/*
盯住工具这条链路：扫描目录、把工具跑在独立子进程里、把结果安全地带回主线程。

这里最贵的一条契约是"一次调用一定会结算"。工具进程可能跑完、抛错、自杀、被超时杀掉、
被取消信号杀掉——五条路径，任何一条没接住，整台 Agent 就会静默卡死。
*/

import { expect, test, describe } from 'bun:test'
import Tool from '../features/tool.js'
import { BROKEN, CYCLIC_FORMAT, TOOLS } from './helpers.js'

describe('Tool 扫描', () => {
    test('工具目录里的非工具文件被跳过，不再让整次扫描崩溃', async () => {
        const tools = await Tool.scan(TOOLS) // 这个目录里放着没有默认导出的 helper.js。
        expect(Object.keys(tools.schema).sort()).toEqual(['echo', 'noschema', 'partialschema', 'stream'])
    })

    test('没写 inputSchema 的工具也拿到合法的对象 Schema', async () => {
        const tools = await Tool.scan(TOOLS)
        expect(tools.schema.noschema.inputSchema.jsonSchema).toEqual({ type: 'object', properties: {} }) // 缺了它 Anthropic 和 OpenAI 都会 400。
    })

    test('只写了 properties 没写 type 的工具，参数不会被吞掉', async () => {
        const tools = await Tool.scan(TOOLS)
        expect(tools.schema.partialschema.inputSchema.jsonSchema).toEqual({
            type: 'object',                                          // 缺的 type 补上，
            properties: { path: { type: 'string' } },                // 工具自己写的 properties 一个不丢。
            required: ['path'],
        })
    })

    test('工具按名字定位，文件里排第几完全不影响', async () => {
        const tools = await Tool.scan(BROKEN) // order-a.js 里 second 排在 first 前面。
        const first = await Tool.execute({ name: 'first', input: {}, handlers: tools.handlers })
        const second = await Tool.execute({ name: 'second', input: {}, handlers: tools.handlers })

        expect(first.output.value).toBe('I-am-first')   // 按下标定位时这里会拿到 I-am-second。
        expect(second.output.value).toBe('I-am-second')
    })

    test('handlers 里不再保存下标', async () => {
        const tools = await Tool.scan(TOOLS)
        expect(tools.handlers.echo).toEqual({ url: tools.handlers.echo.url })
    })

    test('TypeScript 写的工具也认得，.d.ts 跳过', async () => {
        // 这个包只跑在 Bun 上，Bun 直接执行 TypeScript。工具作者写 .ts 是很自然的事。
        const tools = await Tool.scan(new URL('./fixtures/typescript', import.meta.url))
        expect(Object.keys(tools.schema)).toEqual(['multiply'])   // .d.ts 只有类型，不能被当成工具加载。

        const result = await Tool.execute({ name: 'multiply', input: { a: 6, b: 7 }, handlers: tools.handlers })
        expect(result.output.value).toBe(42)                      // 真的能在工具进程里执行。
    })
})


describe('Tool 执行', () => {
    test('工具返回循环引用时变成一条工具错误，而不是毒死 history', async () => {
        const tools = await Tool.scan(BROKEN)
        const result = await Tool.execute({ name: 'cyclic', input: {}, handlers: tools.handlers })

        expect(result.error).toBeTruthy()
        expect(result.output.type).toBe('error-text')
        expect(() => JSON.stringify(result.output)).not.toThrow() // 写进 history 之后 Context.build 还得能序列化它。
    })

    test('Date / Map / NaN 被规整成纯 JSON 再跨进程', async () => {
        const tools = await Tool.scan(BROKEN)
        const result = await Tool.execute({ name: 'rich', input: {}, handlers: tools.handlers })

        expect(result.output.value.when).toBe('2020-01-02T03:04:05.000Z') // Date 变字符串。
        expect(result.output.value.map).toEqual({})                       // Map 没有 JSON 表示。
        expect(result.output.value.bad).toBeNull()                        // NaN 变 null，AI SDK 才收。
    })

    test('带方法的类实例不再让成功的工具被报成失败', async () => {
        const tools = await Tool.scan(BROKEN)
        const result = await Tool.execute({ name: 'uncloneable', input: {}, handlers: tools.handlers })

        expect(result.error).toBeUndefined()        // 以前这里是 DataCloneError，模型会以为工具失败而重试。
        expect(result.output.value).toEqual({ value: 42 })
    })

    test('toModelOutput 抛错时这次调用仍然会结算', async () => {
        const tools = await Tool.scan(BROKEN)
        const result = await Tool.execute({ name: 'badformat', input: {}, handlers: tools.handlers }) // 以前这里永远挂着，整台 Agent 卡死。

        expect(result.error).toBeTruthy()
        expect(result.output.type).toBe('error-text')
    })

    test('工具把工具进程杀掉时这次调用仍然会结算', async () => {
        const tools = await Tool.scan(BROKEN)
        const result = await Tool.execute({ name: 'suicide', input: {}, handlers: tools.handlers }) // 以前只触发 close 事件，没人监听。

        expect(result.error).toBeTruthy()
        expect(result.output.value).toContain('工具进程')
    })

    test('工具进程被杀之后还能继续执行工具', async () => {
        const tools = await Tool.scan(BROKEN)
        await Tool.execute({ name: 'suicide', input: {}, handlers: tools.handlers })
        const after = await Tool.execute({ name: 'first', input: {}, handlers: tools.handlers })

        expect(after.output.value).toBe('I-am-first') // 工具进程塌了会自动重建，不需要调用方做任何事。
    })

    test('取消信号能瞬间杀掉死循环工具', async () => {
        const tools = await Tool.scan(BROKEN)
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 100)

        const started = Date.now()
        const result = await Tool.execute({ name: 'forever', input: {}, handlers: tools.handlers, signal: controller.signal })

        expect(result.interrupted).toBe(true)
        expect(Date.now() - started).toBeLessThan(2000) // 进程内的 await 永远做不到这件事，所以工具必须跑在独立进程里。
    })

    test('同一套工具复用一个工具进程，不再按次新建 Worker', async () => {
        const tools = await Tool.scan(TOOLS)
        const before = process.memoryUsage.rss()
        for (let i = 0; i < 40; i += 1) await Tool.execute({ name: 'echo', input: { value: String(i) }, handlers: tools.handlers })
        const grew = (process.memoryUsage.rss() - before) / 1048576

        expect(grew).toBeLessThan(200) // 按次新建 Worker 时每个留下约 22MB；换成子进程后杀多少次都不累积。
    })

    test('signal 进来之前就已经取消时，这次调用立刻结算而不是永远挂着', async () => {
        const tools = await Tool.scan(TOOLS)
        const controller = new AbortController()
        controller.abort() // 先取消，再调用——agent.stop() 之后残留的工具调用就是这个形状。

        const result = await Promise.race([
            Tool.execute({ name: 'echo', input: { value: 'x' }, handlers: tools.handlers, signal: controller.signal }),
            Bun.sleep(2000).then(() => 'HUNG'), // 挂住的话这条先到，测试失败。
        ])

        expect(result).not.toBe('HUNG')
        expect(result.interrupted).toBe(true)
    })

    test('取消只杀自己这一轮的工具，不误伤共用同一份工具的另一个调用', async () => {
        const tools = await Tool.scan(BROKEN)
        const mine = new AbortController()
        const theirs = new AbortController()

        const victim = Tool.execute({ name: 'forever', input: {}, handlers: tools.handlers, signal: mine.signal })
        const bystander = Tool.execute({ name: 'first', input: {}, handlers: tools.handlers, signal: theirs.signal })
        setTimeout(() => mine.abort(), 80)

        expect((await victim).interrupted).toBe(true)
        expect((await bystander).output.value).toBe('I-am-first') // 以前这里会被连坐杀掉，拿到"工具执行已中断"。
    })

    test('跑过工具之后进程还能正常退出', async () => {
        // 池里的工具进程如果不 unref，事件循环永远不空，任何用了这个包的 CLI 都会卡在退出这一步。
        const child = Bun.spawn(['bun', '-e', `
            import Tool from '${new URL('../features/tool.js', import.meta.url).href}'
            const tools = await Tool.scan('./tests/fixtures/tools')
            await Tool.execute({ name: 'echo', input: { value: 'bye' }, handlers: tools.handlers })
            console.log('done')
        `], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })

        const exited = await Promise.race([child.exited, Bun.sleep(8000).then(() => 'HUNG')])
        if (exited === 'HUNG') child.kill()

        expect(exited).toBe(0)
    })

    test('自带 toModelOutput 的工具返回循环引用时也不会毒化 history', async () => {
        const tools = await Tool.scan(CYCLIC_FORMAT)
        const result = await Tool.execute({ name: 'cyclicformat', input: {}, handlers: tools.handlers })

        expect(result.error).toBeTruthy()                              // 成形结果同样要过 JSON 化这一关，不能因为工具自带格式化就放行。
        expect(() => JSON.stringify(result.output)).not.toThrow()
    })

    test('并发调用不会串台', async () => {
        const tools = await Tool.scan(TOOLS)
        const values = ['a', 'b', 'c', 'd']
        const results = await Promise.all(values.map(value => Tool.execute({ name: 'echo', input: { value }, handlers: tools.handlers })))

        expect(results.map(result => result.output.value)).toEqual(values.map(value => `done:${value}`))
    })
})
