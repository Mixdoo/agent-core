/*
这一份专门盯住已经修掉的缺陷，每个 test 对应一个真实踩过的坑。
跑法和其它测试一样：bun test

每条测试的命名都是"它当初错在哪"，所以一旦有人改回旧写法，失败信息本身就说明了原因。
*/

import { expect, test, describe } from 'bun:test'
import Agent from '../index.js'
import History from '../utils/history.js'
import Context from '../features/context.js'
import Tool from '../features/tool.js'
import LLM from '../utils/llm.js'
import Loop from '../features/loop.js'
import Compact from '../features/compact.js'

const BROKEN = new URL('./fixtures/broken', import.meta.url)               // scan 直接收 URL，不用自己拼路径——嵌进别人项目时手边就是它。
const CYCLIC_FORMAT = new URL('./fixtures/cyclicformat', import.meta.url)  // 单独放一个目录，免得污染其它用例的工具表。

// --- 造一段真实形态的历史：用户指令 + 若干轮工具调用 + 压缩总结 ---
const withTurns = rounds => {
    const history = [History.user({ content: '帮我重构项目' })]
    for (let i = 1; i <= rounds; i += 1) {
        history.push(History.assistant({ content: null, toolCalls: [{ id: `call-${i}`, name: 'read', arguments: { path: `f${i}` } }] }))
        history.push(History.tool({ toolCallId: `call-${i}`, toolName: 'read', content: `文件${i}的内容` }))
    }
    return history
}

// 每条 tool 消息都必须能在它前面找到发起它的 tool-call，反之亦然。
// 供应商就是按这条规则校验的，配不上就是 400。
const pairing = messages => {
    const called = new Set()
    const answered = new Set()
    for (const message of messages) {
        if (!Array.isArray(message.content)) continue
        for (const part of message.content) {
            if (part.type === 'tool-call') called.add(part.toolCallId)
            if (part.type === 'tool-result') {
                if (!called.has(part.toolCallId)) return { ok: false, why: `孤儿工具结果 ${part.toolCallId}` } // 没人发起过它。
                answered.add(part.toolCallId)
            }
        }
    }
    const missing = [...called].find(id => !answered.has(id))
    return missing ? { ok: false, why: `工具调用 ${missing} 没有结果` } : { ok: true }
}


describe('可嵌入性', () => {
    // 这个包会被打包成单文件嵌进别的项目，那时 default 导出就是唯一入口。
    // 凡是嵌入方需要的东西都必须挂在上面，否则在产物里根本够不着——
    // 以前 History 就够不着，而 history 是这个项目的权威数据源，上层却没法给它造一条合法消息。
    test('入口带齐了嵌入方需要的全部模块', () => {
        expect(Object.keys(Agent).sort()).toEqual(['compact', 'context', 'create', 'history', 'llm', 'tool', 'version'])
        expect(Agent.version).toMatch(/^\d+\.\d+\.\d+/) // 排查问题时上层要能报出版本。
    })

    test('从入口就能造出合法的历史消息块', () => {
        // 嵌入方要做的事：把 IM 消息转成 user 块、往历史里塞系统通知、从库里恢复会话。
        // 没有这个就只能手写 { id, role, content } 并自己保证格式对。
        expect(Agent.history.user({ content: '你好' }).role).toBe('user')
        expect(Agent.history.compact({ content: '总结' }).compact).toBe(true)
        expect(typeof Agent.history.assistant).toBe('function')
        expect(typeof Agent.history.tool).toBe('function')
    })

    test('scan 直接收 URL，不用调用方自己拼路径', async () => {
        // 嵌进别人项目时，工具目录的位置只能相对调用方自己的代码算，手边拿到的就是 URL。
        // 以前只收字符串路径，Windows 上还得自己剥掉 pathname 的前导斜杠。
        const tools = await Tool.scan(new URL('./fixtures/tools', import.meta.url))
        expect(tools.schema.echo).toBeDefined()
    })

    test('scan 能合并多个目录，后面的覆盖前面的同名工具', async () => {
        // 内置工具目录在前、用户工具目录在后，用户就能覆盖内置工具——不用为此写任何注册逻辑。
        const merged = await Tool.scan(new URL('./fixtures/tools', import.meta.url), BROKEN)
        expect(merged.schema.echo).toBeDefined()   // 第一个目录的还在。
        expect(merged.schema.cyclic).toBeDefined() // 第二个目录的也进来了。
    })
})


describe('Context 裁剪', () => {
    test('压缩后不再切断 tool-call 与 tool-result 的配对', () => {
        const history = withTurns(5)
        history.push(History.compact({ content: '前面读了 5 个文件' }))
        history.push(History.user({ content: '继续' }))

        const { messages } = Context.build({ history, system: 'sys' })
        expect(pairing(messages)).toEqual({ ok: true })
        expect(messages.length).toBeLessThan(history.length + 1) // 确实裁掉了东西，不是靠"全都留下"蒙混过关。
    })

    test('一条 assistant 带多个并行 tool-call 时整个回合同进同出', () => {
        const history = [History.user({ content: '并行读三个文件' })]
        history.push(History.assistant({ content: null, toolCalls: [1, 2, 3].map(n => ({ id: `p-${n}`, name: 'read', arguments: { path: `f${n}` } })) }))
        for (const n of [1, 2, 3]) history.push(History.tool({ toolCallId: `p-${n}`, toolName: 'read', content: `内容${n}` }))
        history.push(History.compact({ content: '读完了三个文件' }))
        history.push(History.user({ content: '继续' }))

        expect(pairing(Context.build({ history }).messages)).toEqual({ ok: true })
    })

    test('连续多次压缩后依然配对完整', () => {
        const history = withTurns(3)
        history.push(History.compact({ content: '第一次总结' }))
        history.push(...withTurns(3).slice(1))
        history.push(History.compact({ content: '第二次总结' }))
        history.push(History.user({ content: '接着干' }))

        expect(pairing(Context.build({ history }).messages)).toEqual({ ok: true })
    })

    test('工具结果排在调用前面时也能认回自己的回合，不再被静默丢弃', () => {
        // 从数据库按 id 恢复会话、或多路并发写 history 时，结果排到调用前面是完全可能的。
        const call = History.assistant({ content: null, toolCalls: [{ id: 'c-1', name: 'read', arguments: { path: 'a' } }] })
        const result = History.tool({ toolCallId: 'c-1', toolName: 'read', content: '内容' })
        const history = [History.user({ content: '读一下' }), result, call] // 故意把结果放在调用前面。

        const { messages } = Context.build({ history })
        const parts = messages.flatMap(message => (Array.isArray(message.content) ? message.content : []))

        expect(parts.some(part => part.type === 'tool-result' && part.toolCallId === 'c-1')).toBe(true) // 一趟遍历的写法会在这里把结果丢掉。
        expect(pairing(messages)).toEqual({ ok: true })
    })

    test('没人应答的工具调用被摘掉，而不是带着它去撞 MissingToolResultsError', () => {
        const history = [
            History.user({ content: '读一下' }),
            History.assistant({ content: '这就去', toolCalls: [{ id: 'lost', name: 'read', arguments: { path: 'a' } }] }), // 工具没跑完进程就挂了。
        ]
        const { messages } = Context.build({ history })
        const parts = messages.flatMap(message => (Array.isArray(message.content) ? message.content : []))

        expect(parts.some(part => part.type === 'tool-call')).toBe(false)  // 带着它 AI SDK 在本地就抛，请求一个字节都发不出去。
        expect(parts.some(part => part.type === 'text')).toBe(true)        // 正文仍然保留。
    })

    test('content 是字符串或缺失的合法消息不会把 build 打崩', () => {
        // AI SDK 的 AssistantContent 定义就是 string | Array<...>，而 agent.history 是公开可写的，
        // 上层完全可能直接塞一条这样的消息进来。
        const history = [
            { role: 'user', content: '你好' },
            { role: 'assistant', content: '你好呀' },
            { role: 'tool', content: [] },
        ]
        expect(() => Context.build({ history })).not.toThrow()
    })

    test('思考内容留在 history 但不发给模型', () => {
        const history = [
            History.user({ content: '你好' }),
            History.assistant({ content: [{ type: 'reasoning', text: '我先想一下' }, { type: 'text', text: '好的' }] }),
        ]
        const { messages } = Context.build({ history })
        const parts = messages.flatMap(message => (Array.isArray(message.content) ? message.content : []))

        expect(parts.some(part => part.type === 'reasoning')).toBe(false) // 回传思考会被 gpt-oss-120b 这类服务 400。
        expect(parts.some(part => part.type === 'text')).toBe(true)       // 正文还在。
        expect(history[1].content.some(part => part.type === 'reasoning')).toBe(true) // 原始历史没有被改动，上层 UI 仍能渲染思考。
    })

    test('只剩思考的 assistant 消息整条不发出去', () => {
        const history = [
            History.user({ content: '你好' }),
            History.assistant({ content: [{ type: 'reasoning', text: '纯思考，没有正文' }] }),
        ]
        expect(Context.build({ history }).messages.every(message => message.content.length)).toBe(true) // 空 content 的消息会被供应商拒绝。
    })

    test('没人读 token 时不做分词估算', () => {
        const context = Context.build({ history: withTurns(3) })

        // token 是取值器：没设 maxTokens 时 Loop 根本不读它，分词那一遍（2000 条历史约 120ms）就不会白跑。
        expect(typeof Object.getOwnPropertyDescriptor(context, 'token').get).toBe('function')
        expect(context.token).toBeGreaterThan(0)  // 读的时候仍然算得出来。
        expect(context.token).toBe(context.token) // 读第二次直接用缓存，不重复分词。
    })
})


describe('Tool 扫描', () => {
    test('工具目录里的非工具文件被跳过，不再让整次扫描崩溃', async () => {
        const tools = await Tool.scan('./tests/fixtures/tools') // 这个目录里放着没有默认导出的 helper.js。
        expect(Object.keys(tools.schema).sort()).toEqual(['echo', 'noschema', 'partialschema', 'stream'])
    })

    test('没写 inputSchema 的工具也拿到合法的对象 Schema', async () => {
        const tools = await Tool.scan('./tests/fixtures/tools')
        expect(tools.schema.noschema.inputSchema.jsonSchema).toEqual({ type: 'object', properties: {} }) // 缺了它 Anthropic 和 OpenAI 都会 400。
    })

    test('只写了 properties 没写 type 的工具，参数不会被吞掉', async () => {
        const tools = await Tool.scan('./tests/fixtures/tools')
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
        const tools = await Tool.scan('./tests/fixtures/tools')
        expect(tools.handlers.echo).toEqual({ url: tools.handlers.echo.url })
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
        const tools = await Tool.scan('./tests/fixtures/tools')
        const before = process.memoryUsage.rss()
        for (let i = 0; i < 40; i += 1) await Tool.execute({ name: 'echo', input: { value: String(i) }, handlers: tools.handlers })
        const grew = (process.memoryUsage.rss() - before) / 1048576

        expect(grew).toBeLessThan(200) // 按次新建 Worker 时每个留下约 22MB；换成子进程后杀多少次都不累积。
    })

    test('signal 进来之前就已经取消时，这次调用立刻结算而不是永远挂着', async () => {
        const tools = await Tool.scan('./tests/fixtures/tools')
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
        // 池里的 Worker 如果不 unref，事件循环永远不空，任何用了这个包的 CLI 都会卡在退出这一步。
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
        const tools = await Tool.scan('./tests/fixtures/tools')
        const values = ['a', 'b', 'c', 'd']
        const results = await Promise.all(values.map(value => Tool.execute({ name: 'echo', input: { value }, handlers: tools.handlers })))

        expect(results.map(result => result.output.value)).toEqual(values.map(value => `done:${value}`))
    })
})


describe('压缩这条路径', () => {
    test('总结折进 system 并说明身份，不再当成一条用户消息', () => {
        // 裸的 role:'user' 总结会被模型读成"用户塞给我一张表"，于是它从头重做整个任务。
        // 真实端点实测：gpt-oss-120b 改之前 1/6 能正确续跑，改之后 6/6。
        const history = [
            History.user({ content: '核对 12 个箱子' }),
            History.compact({ content: '已经核对完 C01 到 C06' }),
            History.user({ content: '继续' }),
        ]
        const { messages } = Context.build({ history, system: '你是助手' })

        expect(messages[0].role).toBe('system')
        expect(messages[0].content).toContain('你是助手')                 // 原来的系统提示词还在。
        expect(messages[0].content).toContain('你此前工作的压缩记录')       // 总结带着身份说明进了 system。
        expect(messages[0].content).toContain('已经核对完 C01 到 C06')
        expect(messages.slice(1).some(message => String(message.content).includes('已经核对完'))).toBe(false) // 对话里不再有裸的总结消息。
    })

    test('压缩请求不再把整份上下文二次编码', async () => {
        // 以前是 JSON.stringify 塞进一条 user 消息，引号被二次转义，
        // 压缩请求能膨胀到它要压的上下文的 1.51 倍——"压缩"反而成了第一个撑爆窗口的请求。
        let sent = 0
        const server = Bun.serve({
            port: 39961,
            async fetch(request) { sent = JSON.stringify(await request.json()).length; return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '总结' }, finish_reason: 'stop' }], usage: {} }) },
        })

        const history = [History.user({ content: '处理数据' })]
        for (let i = 1; i <= 10; i += 1) {
            history.push(History.assistant({ content: null, toolCalls: [{ id: `c${i}`, name: 'api', arguments: { n: i } }] }))
            history.push(History.tool({ toolCallId: `c${i}`, toolName: 'api', content: { type: 'json', value: { rows: Array.from({ length: 30 }, (_, k) => ({ k, note: '带"引号"的内容' })) } } }))
        }
        const context = Context.build({ history, system: '你是助手' })
        await Compact.run({ messages: context.messages, llm: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'm' }, stream: false })

        expect(sent / JSON.stringify(context.messages).length).toBeLessThan(1.35) // 二次转义时是 1.51；剩下的是请求信封本身。
        server.stop(true)
    })

    test('巨大的开场消息不会让压缩永远收敛不了', () => {
        // 用户第一条就粘一大段日志时，"最初目标"按条数被永久钉住，压缩压完仍然超限，
        // 于是每一轮都白压一次——实测 120/120 轮都没降到阈值以下。现在它要占预算，占不下就不留。
        const history = [History.user({ content: '日志'.repeat(7000) })]
        for (let i = 1; i <= 6; i += 1) history.push(History.user({ content: `第 ${i} 步` }))
        history.push(History.compact({ content: '短总结' }))
        history.push(History.user({ content: '继续' }))

        const budgeted = Context.build({ history, budget: 6000 }).token
        expect(budgeted).toBeLessThan(6000 * 0.8)                               // 压缩之后真的降到阈值以下了。
        expect(budgeted).toBeLessThan(Context.build({ history }).token)         // 不给预算时它会把那坨日志原样钉着。
    })

    test('总结之后的新回合不受预算限制', () => {
        // 总结后的内容是当前正在推进的工作，它涨起来是正常的，Loop 会在下一次超阈值时再压一次。
        const history = [History.user({ content: '开始' }), History.compact({ content: '总结' })]
        for (let i = 0; i < 8; i += 1) history.push(History.user({ content: `新消息 ${i}` }))

        const { messages } = Context.build({ history, budget: 10 })             // 预算小到几乎为零。
        expect(messages.filter(message => String(message.content).startsWith('新消息')).length).toBe(8)
    })
})


describe('多模态', () => {
    const MEDIA = new URL('./fixtures/media', import.meta.url)
    const shot = [{ type: 'text', text: '这是什么' }, { type: 'image', image: 'data:image/png;base64,iVBORw0KGgo=' }]

    test('用户消息可以带图片', () => {
        // AI SDK 的 UserContent 本来就是 string | Array<TextPart | ImagePart | FilePart>，
        // 以前是 History.user 自己只收字符串，把门关上了——电脑任务 agent 连截图都递不进去。
        expect(History.user({ content: shot }).content).toEqual(shot)
        expect(History.user({ content: '还是纯文本' }).content).toBe('还是纯文本') // 字符串照旧，不强行包成数组。
    })

    test('空的内容块数组仍然被拒绝', () => {
        expect(() => History.user({ content: [] })).toThrow('empty array') // 空消息会被供应商拒收。
    })

    test('agent.send 可以直接发图片', async () => {
        const agent = Agent.create() // 没配 baseURL，这次 send 必然失败——我们只关心它没在入口那道检查就被拒掉。
        const error = await agent.send({ input: shot }).catch(caught => caught)

        expect(String(error?.message ?? '')).not.toContain('input must be')
        expect(agent.history[0].content).toEqual(shot) // 图片原样进了历史。
    })

    test('图片能原样走到发给模型的消息里', () => {
        const { messages } = Context.build({ history: [History.user({ content: shot })] })
        expect(messages[0].content).toEqual(shot) // 裁剪只摘思考和没人应答的调用，不碰图片。
    })

    test('工具返回已成形的输出块时不再被二次包装', async () => {
        // README 里 finish 工具就是 return { output: { type:'text', value } } 这么写的。
        // 以前会被当成普通返回值再套一层，模型看到 {"type":"json","value":{"type":"text",...}}。
        const tools = await Tool.scan(MEDIA)
        const result = await Tool.execute({ name: 'screenshot', input: {}, handlers: tools.handlers, limit: 32000 })

        expect(result.output.type).toBe('content')
        expect(result.output.value.map(part => part.type)).toEqual(['text', 'file'])
    })

    test('截断只动文字，图片一个字节都不碰', async () => {
        const tools = await Tool.scan(MEDIA)
        const result = await Tool.execute({ name: 'bigshot', input: {}, handlers: tools.handlers, limit: 32000 })
        const [words, media] = result.output.value

        expect(words.text.length).toBeLessThan(33000)            // 20 万字的说明该截还是截。
        expect(words.text).toContain('输出过长')
        expect(media.data.data.length).toBeGreaterThan(100000)   // 图截一刀就彻底废了，必须原样放行。
        expect(media.mediaType).toBe('image/png')
    })

    test('作废的 media 形状被当场挡住，而不是穿过去毒死 history', async () => {
        // { type:'media' } 是 AI SDK v5 的名字，v7 的联合类型里没有。让它穿过去的话，
        // AI SDK 会在 standardizePrompt 本地抛 AI_InvalidPromptError——请求发不出去、Retry 认不出来、
        // 而 history 只增不删，于是之后每次 send 都撞同一个错，重启装回历史也一样。
        const tools = await Tool.scan(MEDIA)
        const result = await Tool.execute({ name: 'legacyshot', input: {}, handlers: tools.handlers, limit: 32000 })

        expect(result.error).toBeTruthy()
        expect(result.output.type).toBe('error-text')
        expect(result.output.value).toContain('media')           // 错误信息要说清楚哪个部件不合法。
        expect(result.output.value).toContain('file')            // 以及该用什么。
    })
})


describe('常驻加固', () => {
    const LIMITS = new URL('./fixtures/limits', import.meta.url)

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
        expect(new Set(ids).size).toBeLessThanOrEqual(8)   // 不设上限时这里会瞬间起 30 个 Worker，实测 20 个就占 466MB。
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

    test('压缩只往 history 里加总结，一条历史都不许删', async () => {
        // history 是这个项目唯一的权威数据来源，该保留多少由持有它的上层决定。
        // 核心包替它丢数据是越权——压缩控制的是"这一轮发给模型的内容有多大"，不是"历史能留多少"。
        const server = Bun.serve({
            port: 39941,
            async fetch(request) { await request.json(); return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '这是一段总结' }, finish_reason: 'stop' }], usage: {} }) },
        })

        const agent = Agent.create({ config: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'm', stream: false, maxTokens: 600, compactThreshold: 0.8 } })
        const seeded = Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `第 ${i} 轮的一些内容，凑长度用的文本`.repeat(3) }))
        agent.history.push(...seeded)

        await agent.send({ input: '继续' }).catch(() => {})

        expect(agent.history.length).toBeGreaterThan(seeded.length)                 // 只增不减。
        for (const message of seeded) expect(agent.history).toContain(message)      // 每一条原始消息都还在，而且是同一个对象引用。
        expect(agent.history.some(message => message.compact === true)).toBe(true)  // 总结是"加"进来的一条。
        server.stop(true)
    })

    test('压缩确实把发给模型的内容压小了（只是不动 history）', async () => {
        const history = Array.from({ length: 40 }, (_, i) => History.user({ content: `第 ${i} 轮的内容`.repeat(20) }))
        const before = Context.build({ history }).token
        history.push(History.compact({ content: '前面四十轮的总结' }))

        expect(Context.build({ history }).token).toBeLessThan(before) // 裁剪发生在上下文这一侧。
        expect(history.length).toBe(41)                               // history 本身只是多了一条。
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


describe('LLM 边界', () => {
    // 一个只会报错的假中转站：真实服务报错时就是这个形状。
    const failing = Bun.serve({
        port: 39931,
        fetch: () => Response.json({ error: { message: '上游负载已满', type: 'server_error' } }, { status: 503 }),
    })

    // 记录收到的请求体，用来确认我们到底发了什么字段。
    const recorded = []
    const echo = Bun.serve({
        port: 39932,
        async fetch(request) {
            recorded.push(await request.json())
            return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }], usage: {} })
        },
    })

    // retryMaxElapsed: 0 = 一次都不重试。这几条测的是"错误有没有如实抛出来"，
    // 不是重试行为；不关掉的话 LLM.chat 会老老实实对着这个永远 503 的假服务重试满 5 分钟。
    const noRetry = { retryMaxElapsed: 0 }

    test('流式请求里的供应商错误会被抛出来，不再伪装成正常回答', async () => {
        const call = LLM.chat({ baseURL: `http://127.0.0.1:${failing.port}/v1`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, ...noRetry })
        expect(call).rejects.toThrow() // 以前它会返回一个空文本的"成功"结果，上层完全看不出请求失败过。
    })

    test('抛出来的错误带着 AI SDK 的可重试标记，Retry 才认得出', async () => {
        const error = await LLM.chat({ baseURL: `http://127.0.0.1:${failing.port}/v1`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, ...noRetry }).catch(caught => caught)
        expect(error.isRetryable).toBe(true) // 503 该重试；以前这里是 AI_NoOutputGeneratedError，没有这个字段，重试从来不会发生。
    })

    test('一直失败也会在时间预算内收手，不会永远重试', async () => {
        // 重试搬进 LLM.chat 之后，次数不设限；上界改成时间。
        // 没有这条上界的话服务挂一整天 send() 也不 resolve 不 reject，上层连"出事了"都不知道。
        const started = Date.now()
        const error = await LLM.chat({ baseURL: `http://127.0.0.1:${failing.port}/v1`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false, retryMaxElapsed: 2 }).catch(caught => caught)

        expect(error).toBeInstanceOf(Error)
        expect(Date.now() - started).toBeLessThan(15000) // 到点就把最后一次的错误交出来。
    })

    test('压缩请求和主请求走同一套重试', async () => {
        // 压缩那次请求以前是裸的：同一个 500，打在普通轮次上会重试到底，打在压缩上 306ms 就抛穿 send()，
        // 把跑了几小时的会话直接打死。现在它和主请求共用 LLM.chat，自然共用重试。
        const tries = []
        const error = await Compact.run({
            messages: [{ role: 'user', content: '要压缩的内容' }],
            llm: { baseURL: `http://127.0.0.1:${failing.port}/v1`, apiKey: 'k', model: 'm', retryMaxElapsed: 2 },
            stream: false,
            onRetry: info => tries.push(info.attempt),
        }).catch(caught => caught)

        expect(error).toBeInstanceOf(Error)
        expect(tries.length).toBeGreaterThan(0) // 真的重试过，而不是第一次就放弃。
    })

    test('默认不发 OpenAI 私有的提示词缓存字段', async () => {
        recorded.length = 0
        await LLM.chat({ baseURL: `http://127.0.0.1:${echo.port}/v1`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false })

        expect(recorded[0]).not.toHaveProperty('prompt_cache_key') // 实测 gpt-oss-120b 会因为这个字段直接 400。
        expect(recorded[0]).not.toHaveProperty('prompt_cache_retention')
    })

    test('显式打开 cache 时才发缓存字段', async () => {
        recorded.length = 0
        await LLM.chat({ baseURL: `http://127.0.0.1:${echo.port}/v1`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false, cache: true })

        expect(recorded[0]).toHaveProperty('prompt_cache_key')
    })

    test('默认 toolChoice 是 auto，模型可以正常收尾', async () => {
        recorded.length = 0
        const tools = (await Tool.scan('./tests/fixtures/tools')).schema // 用真实扫描出来的 schema，保证形状和线上一致。
        await LLM.chat({ baseURL: `http://127.0.0.1:${echo.port}/v1`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false, tools })

        expect(recorded[0].tool_choice).toBe('auto') // 写死 required 会让 gpt-oss-120b 在模型不想调工具时返回 tool_use_failed。
    })

    process.on('exit', () => { failing.stop(); echo.stop() })
})


describe('Agent 与 Loop', () => {
    const server = Bun.serve({
        port: 39933,
        async fetch(request) {
            await request.json()
            await Bun.sleep(120) // 留出足够窗口，让"两次 send 抢跑"这件事真的有机会发生。
            return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '回答' }, finish_reason: 'stop' }], usage: {} })
        },
    })
    const config = { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'm', stream: false }

    test('同一 tick 内连发两次 send，只有后一次在跑', async () => {
        const agent = Agent.create({ config })
        const first = agent.send({ input: '任务A' })
        const second = agent.send({ input: '任务B' })

        expect(agent.running.task).toBe(second)        // 第二次必定看得见第一次并顶替它。
        await Promise.allSettled([first, second])
        await first.then(() => 'finished', () => 'aborted').then(state => expect(state).toBe('aborted')) // 旧任务被停掉，而不是和新任务并排跑完。
    })

    test('send 之后立刻 stop 不会因为运行状态半成品而抛 TypeError', async () => {
        const agent = Agent.create({ config })
        const task = agent.send({ input: '马上就停' })
        const stopped = await agent.stop()

        expect(stopped).toEqual({ ok: true })
        await task.catch(() => {})
    })

    test('新指令写在旧任务收尾之后，history 顺序不错乱', async () => {
        const agent = Agent.create({ config })
        const first = agent.send({ input: '任务A' })
        const second = agent.send({ input: '任务B' })
        await Promise.allSettled([first, second])
        await second.catch(() => {})

        const said = agent.history.filter(message => message.role === 'user').map(message => message.content)
        expect(said).toEqual(['任务A', '任务B'])                       // 先说的在前。
        const indexB = agent.history.findIndex(message => message.content === '任务B')
        expect(agent.history.slice(0, indexB).every(message => message.role === 'user' || message.role === 'assistant' || message.role === 'tool')).toBe(true)
        // 旧任务被打断后写回的消息不会插到"任务B"后面——它在写之前就已经被等完了。
    })

    test('compact 和 send 抢跑时不会互相把运行状态覆盖掉', async () => {
        const agent = Agent.create({ config })
        const sending = agent.send({ input: '先发一条' })
        const compacting = agent.compact()                            // 同一 tick 紧接着手动压缩。

        expect(agent.running.task).toBe(compacting)                   // 后来的顶替先来的，而不是把它挤成孤儿。
        await Promise.allSettled([sending, compacting])
        expect(agent.running).toBeNull()                              // 都结束之后状态归零，不会留下一个停不掉的任务。
    })

    test('上下文压不动时停止压缩，不再无限烧模型请求', async () => {
        let calls = 0
        const compacting = Bun.serve({
            port: 39934,
            async fetch(request) { await request.json(); calls += 1; return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '一段总结' }, finish_reason: 'stop' }], usage: {} }) },
        })

        const agent = Agent.create({ config: { ...config, baseURL: `http://127.0.0.1:${compacting.port}/v1`, maxTokens: 20, compactThreshold: 0.8 } })
        await agent.send({ input: '你好' }).catch(() => {})

        expect(calls).toBeLessThan(20) // 修之前这里 3 秒能跑出 5500 次真实模型请求。
        compacting.stop()
    })

    test('模型给出无法解析的工具调用时不执行它，而是告诉模型重来', async () => {
        const executed = []
        const history = [History.user({ content: '开始' })]
        let round = 0

        await Loop.run({
            history,
            system: '',
            tools: {},
            llm: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'm', stream: false },
            buildContext: Context.build,
            compact: async () => '总结',
            executeTool: async request => { executed.push(request.name); return { output: { type: 'text', value: 'ran' } } },
            // 第一轮伪造一个 AI SDK 标记为 invalid 的调用，之后按正常无工具结束。
            onLLMFinish: result => {
                round += 1
                if (round === 1) result.toolCalls = [{ toolCallId: 'bad-1', toolName: 'read', input: '{"path":', dynamic: true, invalid: true, error: { message: '参数不是合法 JSON' } }]
            },
        })

        expect(executed).toEqual([])  // 以前会把未解析的参数字符串当对象喂给工具。
        expect(history.some(message => Array.isArray(message.content) && message.content.some(part => part.output?.value?.includes('无效')))).toBe(true)
    })

    process.on('exit', () => server.stop())
})
