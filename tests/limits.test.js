/*
盯住"能不能长期不停机地跑下去"：输出上限、超时、并发上限、内存不累积。

常驻 agent 的失败方式和一次性脚本不同：不是某次调用报错，而是几十小时之后
内存涨到几个 GB、或者某次打断往 history 里写进 356 万字符、或者 tool 进程塌了
再也没人接住那次调用。这里的每一条都对应一个"跑得越久越糟"的坑。
*/

import { expect, test, describe } from 'bun:test'
import Agent from '../index.js'
import History from '../utils/history.js'
import Context from '../features/context.js'
import Tool from '../features/tool.js'
import { BROKEN, LIMITS } from './helpers.js'

describe('常驻加固', () => {
    test('工具输出超限时从中间截断，并明确告诉模型', async () => {
        const tools = await Tool.scan(LIMITS)
        const result = await Tool.execute({ name: 'big', input: { kb: 1024 }, handlers: tools.handlers, limit: 32000 })

        expect(result.output.value.length).toBeLessThan(33000)   // 不截断的话这里是 1,048,576 字符 = 31 万 token，超过大多数模型的整个上下文窗口。
        expect(result.output.value).toContain('输出过长')          // 模型得知道自己看到的是残缺的，才会换个问法。
        expect(result.output.value.startsWith('x')).toBe(true)    // 头留着：说明这是什么。
        expect(result.output.value.endsWith('x')).toBe(true)      // 尾留着：结论和报错通常在末尾。
    })

    test('截断把一次工具调用的 token 代价压下两个数量级', async () => {
        const tools = await Tool.scan(LIMITS)
        const result = await Tool.execute({ name: 'big', input: { kb: 1024 }, handlers: tools.handlers, limit: 32000 })
        const history = [
            History.user({ content: '读日志' }),
            History.assistant({ content: null, toolCalls: [{ id: 'c1', name: 'big', arguments: {} }] }),
            History.tool({ toolCallId: 'c1', toolName: 'big', content: result.output }),
        ]
        expect(Context.build({ history }).token).toBeLessThan(20000) // 截断前实测 314,656。
    })

    test('并发再多也不会超过池子上限', async () => {
        const tools = await Tool.scan(LIMITS)
        const ids = await Promise.all(Array.from({ length: 30 }, () =>
            Tool.execute({ name: 'wid', input: {}, handlers: tools.handlers }).then(result => result.output.value)))

        expect(ids.filter(Boolean).length).toBe(30)        // 排队的一个都不能丢。
        expect(new Set(ids).size).toBeLessThanOrEqual(8)   // 不设上限时这里会瞬间起 30 个工具进程，实测 20 个就占 466MB。
    })

    test('工具自己声明的 timeout 会按时把它杀掉', async () => {
        const tools = await Tool.scan(LIMITS)
        const started = Date.now()
        const result = await Tool.execute({ name: 'impatient', input: {}, handlers: tools.handlers })

        expect(result.error).toBe('timeout')
        expect(Date.now() - started).toBeLessThan(3000)    // 工具自己要睡 30 秒。
    })

    test('没声明 timeout 的阻塞型工具不受影响', async () => {
        // 等 IM 消息、盯文件变化这类工具就是要长期阻塞，全局超时会把它们全废掉，所以这个包没有全局超时。
        const tools = await Tool.scan(LIMITS)
        const result = await Tool.execute({ name: 'blocking', input: {}, handlers: tools.handlers })
        expect(result.output.value).toBe('blocked-then-done')
    })

    test('timeout 只进 handlers，不泄漏给模型', async () => {
        const tools = await Tool.scan(LIMITS)
        expect(tools.handlers.impatient.timeout).toBe(250)
        expect('timeout' in tools.schema.impatient).toBe(false)
    })

    test('反复杀工具进程不会累积内存', async () => {
        // 用子进程而不是 Worker 线程，就是为了这件事：Worker 被 terminate 之后 Bun 不归还那约 22MB，
        // 而常驻 agent 天天要杀工具进程（工具崩溃、超时、用户打断），一天下来就是几个 GB。
        const tools = await Tool.scan(BROKEN)
        Bun.gc(true)
        const before = process.memoryUsage.rss()
        for (let i = 0; i < 30; i += 1) await Tool.execute({ name: 'suicide', input: {}, handlers: tools.handlers })
        Bun.gc(true)

        expect((process.memoryUsage.rss() - before) / 1048576).toBeLessThan(150) // Worker 版这里是 30 × 22MB ≈ 660MB 起步。
    })

    test('取消时写进结果的实时输出也有上限', async () => {
        // maxToolOutput 以前只管"工具正常返回"这一条路。取消和超时把主线程里无上限累积的输出
        // 原样拼进结果写进 history——一次 3 秒的打断实测写进 356 万字符（111 倍上限），而且永远删不掉。
        const tools = await Tool.scan(LIMITS)
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 1200)

        const result = await Tool.execute({ name: 'chatty', input: {}, handlers: tools.handlers, signal: controller.signal, limit: 32000 })

        expect(result.interrupted).toBe(true)
        expect(result.output.value.length).toBeLessThan(40000)
    })

    test('maxTokens 有默认值，常驻 Agent 不会永不压缩', () => {
        expect(Agent.create().config.maxTokens).toBeGreaterThan(0) // 默认 undefined 时历史会一直涨到供应商拒收。
        expect(Agent.create().config.maxToolOutput).toBeGreaterThan(0)
    })
})
