/*
盯住"驱动一台 Agent"这件事：send / stop / compact 三者抢跑时的状态机，以及主循环的出口。

这个包的运行状态只有一份（agent.running）。send 和 compact 都要同步顶替它、把停旧任务
放进自己任务内部，所以同一个 tick 里连发两次调用时，后来的必定看得见先来的。
凡是破坏这条的写法都会在这里红——包括"新指令插到旧任务收尾之前"这种 history 乱序。
*/

import { expect, test, describe, afterAll } from 'bun:test'
import { jsonSchema } from 'ai'
import Agent from '../index.js'
import History from '../utils/history.js'
import Context from '../features/context.js'
import Compact from '../features/compact.js'
import Loop from '../features/loop.js'

const server = Bun.serve({
    port: 39933,
    async fetch(request) {
        await request.json()
        await Bun.sleep(120) // 留出足够窗口，让"两次 send 抢跑"这件事真的有机会发生。
        return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '回答' }, finish_reason: 'stop' }], usage: {} })
    },
})
const config = { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'm', stream: false }

afterAll(() => server.stop(true))


describe('Agent 的状态机', () => {
    test('没有工具时只问模型一次，send 直接返回回答', async () => {
        let calls = 0
        const single = Bun.serve({
            port: 0,
            async fetch() {
                calls += 1
                return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }], usage: {} })
            },
        })
        try {
            const agent = Agent.create({ config: { ...config, baseURL: `http://127.0.0.1:${single.port}/v1` } })
            const result = await agent.send('打个招呼')

            expect(result).toEqual({ reason: 'no-tool', text: '你好' })
            expect(calls).toBe(1) // 没有可用工具时，不要让模型连续三轮尝试调用不存在的工具。
            expect(agent.history.at(-1).role).toBe('assistant')
        } finally { single.stop(true) }
    })

    test('默认注册工具后，模型不调工具即结束，不再多问', async () => {
        let calls = 0
        const mock = Bun.serve({
            port: 0,
            async fetch() {
                calls += 1
                return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '暂时不用工具' }, finish_reason: 'stop' }], usage: {} })
            },
        })
        try {
            const tools = await Agent.tool.scan(new URL('./fixtures/tools', import.meta.url))
            const agent = Agent.create({ config: { ...config, baseURL: `http://127.0.0.1:${mock.port}/v1` }, tools })
            const result = await agent.send('检查一下')

            expect(result).toEqual({ reason: 'no-tool', text: '暂时不用工具' })
            expect(calls).toBe(1) // 默认 noToolRounds=1：模型不调工具的那一轮就是最终回答，不要再追问。
        } finally { mock.stop(true) }
    })

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
        expect(agent.history.slice(0, indexB).every(message => ['user', 'assistant', 'tool'].includes(message.role))).toBe(true)
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
})


describe('压缩这条路径', () => {
    test('压缩可以改用另一套模型配置', async () => {
        // 压缩是省钱的常规手段：主模型要聪明，做总结的小模型只要便宜。
        // 两个假服务各记各的请求，谁被调用、用的哪个模型名，一目了然。
        const seen = { main: [], compact: [] }
        const reply = content => Response.json({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: {} })
        const small = Bun.serve({ port: 0, async fetch(request) { seen.compact.push(await request.json()); return reply('小模型总结') } })
        const big = Bun.serve({ port: 0, async fetch(request) { seen.main.push(await request.json()); return reply('主模型回答') } })
        try {
            const agent = Agent.create({
                history: [History.user({ content: '之前的工作' })],
                config: {
                    ...config, baseURL: `http://127.0.0.1:${big.port}/v1`, model: 'big-model',
                    compact: { baseURL: `http://127.0.0.1:${small.port}/v1`, model: 'small-model' },
                },
            })

            expect(await agent.compact()).toBe('小模型总结')              // 结果来自小模型那台服务。
            expect(seen.compact).toHaveLength(1)                          // 压缩只打给了小模型。
            expect(seen.compact[0].model).toBe('small-model')
            expect(seen.main).toHaveLength(0)                             // 主模型一次都没被压缩请求碰到。
        } finally { small.stop(true); big.stop(true) }
    })

    test('自动压缩也走压缩专用的模型', async () => {
        // 自动压缩才是生产里真正天天跑的那条路：上下文超阈值时 Loop 自己触发一次。
        const seen = { main: [], compact: [] }
        const reply = content => Response.json({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: {} })
        const small = Bun.serve({ port: 0, async fetch(request) { seen.compact.push(await request.json()); return reply('小模型总结') } })
        const big = Bun.serve({ port: 0, async fetch(request) { seen.main.push(await request.json()); return reply('主模型回答') } })
        try {
            const agent = Agent.create({
                history: [History.user({ content: '很久以前的工作记录'.repeat(50) })],
                config: {
                    ...config, baseURL: `http://127.0.0.1:${big.port}/v1`, model: 'big-model',
                    maxTokens: 20, compactThreshold: 0.5, noToolRounds: 1,
                    compact: { baseURL: `http://127.0.0.1:${small.port}/v1`, model: 'small-model' },
                },
            })

            await agent.send('继续')
            expect(seen.compact).toHaveLength(1)                                   // 超阈值触发了一次自动压缩。
            expect(seen.compact[0].model).toBe('small-model')                      // 压缩打给小模型。
            expect(seen.main.every(body => body.model === 'big-model')).toBe(true) // 主请求从来不用小模型。
        } finally { small.stop(true); big.stop(true) }
    })

    test('不写 compact 时压缩仍用主模型', async () => {
        const seen = []
        const mock = Bun.serve({ port: 0, async fetch(request) { seen.push(await request.json()); return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '总结' }, finish_reason: 'stop' }], usage: {} }) } })
        try {
            const agent = Agent.create({ history: [History.user({ content: '之前的工作' })], config: { ...config, baseURL: `http://127.0.0.1:${mock.port}/v1` } })
            expect(await agent.compact()).toBe('总结')
            expect(seen[0].model).toBe('m') // config 里的主模型名。
        } finally { mock.stop(true) }
    })

    test('手动压缩沿用默认回调，单次传入的回调优先', async () => {
        let calls = 0
        const mock = Bun.serve({
            port: 0,
            fetch() {
                calls += 1
                if (calls === 1) return Response.json({ error: { message: '稍后重试' } }, { status: 503 })
                return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '总结' }, finish_reason: 'stop' }], usage: {} })
            },
        })
        try {
            const events = []
            const retries = []
            const agent = Agent.create({
                history: [History.user({ content: '之前的工作' })],
                config: { ...config, baseURL: `http://127.0.0.1:${mock.port}/v1`, retryMaxElapsed: 3000 },
                callbacks: { onCompact: event => events.push(event.type), onRetry: info => retries.push(info.attempt) },
            })

            expect(await agent.compact()).toBe('总结')
            expect(events).toEqual(['compact-start', 'compact-finish'])
            expect(retries).toEqual([1])

            const override = []
            await agent.compact({ onCompact: event => override.push(event.type) })
            expect(override).toEqual(['compact-start', 'compact-finish'])
            expect(events).toHaveLength(2) // 单次回调替换默认回调，而不是额外重复通知。
        } finally { mock.stop(true) }
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

    test('压缩确实把发给模型的内容压小了（只是不动 history）', () => {
        const history = Array.from({ length: 40 }, (_, i) => History.user({ content: `第 ${i} 轮的内容`.repeat(20) }))
        const before = Context.build({ history }).token
        history.push(History.compact({ content: '前面四十轮的总结' }))

        expect(Context.build({ history }).token).toBeLessThan(before) // 裁剪发生在上下文这一侧。
        expect(history.length).toBe(41)                               // history 本身只是多了一条。
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

    test('上下文压不动时停止压缩，不再无限烧模型请求', async () => {
        let calls = 0
        const compacting = Bun.serve({
            port: 39934,
            async fetch(request) { await request.json(); calls += 1; return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '一段总结' }, finish_reason: 'stop' }], usage: {} }) },
        })

        const agent = Agent.create({ config: { ...config, baseURL: `http://127.0.0.1:${compacting.port}/v1`, maxTokens: 20, compactThreshold: 0.8 } })
        await agent.send({ input: '你好' }).catch(() => {})

        expect(calls).toBeLessThan(20) // 修之前这里 3 秒能跑出 5500 次真实模型请求。
        compacting.stop(true)
    })
})


describe('Loop', () => {
    test('每轮完成后通知 onStep，工具结果已在 history 中', async () => {
        const steps = []
        const history = [History.user({ content: '开始' })]
        let round = 0

        await Loop.run({
            history,
            system: '',
            tools: { echo: { description: 'echo', inputSchema: jsonSchema({ type: 'object', properties: {} }) } },
            llm: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'm', stream: false, maxSteps: 2 },
            buildContext: Context.build,
            compact: async () => '总结',
            executeTool: async request => ({ output: { type: 'text', value: request.name } }),
            onLLMFinish: result => {
                round += 1
                if (round === 1) result.toolCalls = [{ toolCallId: 'step-1', toolName: 'echo', input: {} }]
            },
            onStep: step => steps.push({ step: step.step, history: history.length, results: step.toolResults.length }),
        })

        expect(steps).toEqual([{ step: 1, history: 3, results: 1 }, { step: 2, history: 4, results: 0 }])
    })

    test('不合法的轮数上限在请求模型前就报错', async () => {
        const agent = Agent.create({ config: { ...config, maxSteps: 0 } })
        await expect(agent.send('你好')).rejects.toThrow('maxSteps must be a positive integer') // 入口拦住，请求根本没发出去。
    })

    test('不合法的无工具结束轮数在请求模型前就报错', async () => {
        const agent = Agent.create({ config: { ...config, noToolRounds: 0 } })
        await expect(agent.send('你好')).rejects.toThrow('noToolRounds must be a positive integer or Infinity')
    })

    test('按次传入的非法轮数上限同样在入口被拦住', async () => {
        const agent = Agent.create({ config })
        await expect(agent.send({ input: '你好', config: { maxSteps: 2.5 } })).rejects.toThrow('maxSteps must be a positive integer') // 覆盖值也要一起检查，不能绕过。
    })

    test('无工具结束轮数可调，调大就多问几轮', async () => {
        const count = async noToolRounds => {
            let calls = 0
            const mock = Bun.serve({
                port: 0,
                fetch() {
                    calls += 1
                    return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '暂时不用工具' }, finish_reason: 'stop' }], usage: {} })
                },
            })
            try {
                const tools = await Agent.tool.scan(new URL('./fixtures/tools', import.meta.url))
                const agent = Agent.create({ config: { ...config, baseURL: `http://127.0.0.1:${mock.port}/v1`, noToolRounds }, tools })
                const result = await agent.send('检查一下')
                return { calls, reason: result.reason }
            } finally { mock.stop(true) }
        }

        expect(await count(1)).toEqual({ calls: 1, reason: 'no-tool' }) // 模型不调工具就结束，不再多问。
        expect(await count(5)).toEqual({ calls: 5, reason: 'no-tool' }) // 多给几次机会，上限跟着配置走。
    })

    test('达到轮数上限时保留完整工具结果，下次 send 可以继续', async () => {
        let calls = 0
        const server = Bun.serve({
            port: 0,
            fetch() {
                calls += 1
                return Response.json({
                    id: `response-${calls}`, object: 'chat.completion',
                    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: `call-${calls}`, type: 'function', function: { name: 'echo', arguments: '{"value":"ok"}' } }] }, finish_reason: 'tool_calls' }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                })
            },
        })
        try {
            const tools = await Agent.tool.scan(new URL('./fixtures/tools', import.meta.url))
            const agent = Agent.create({ config: { ...config, baseURL: `http://127.0.0.1:${server.port}/v1`, maxSteps: 2 }, tools })

            const first = await agent.send('重复使用工具')
            expect(first.reason).toBe('step-limit')          // 模型一直用工具也会停下来。
            expect(calls).toBe(2)                            // 精确控制模型请求次数。
            expect(agent.history.filter(message => message.role === 'tool')).toHaveLength(2)
            expect(Context.build({ history: agent.history }).messages.filter(message => message.role === 'tool')).toHaveLength(2) // 工具调用和结果仍成对。

            const second = await agent.send('接着做')
            expect(second.reason).toBe('step-limit')         // 上限针对每次 send，第二次重新计算。
            expect(calls).toBe(4)
        } finally { server.stop(true) }
    })

    test('轮数上限也限制连续没有工具调用的模型请求', async () => {
        let calls = 0
        const server = Bun.serve({
            port: 0,
            fetch() {
                calls += 1
                return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '等一下' }, finish_reason: 'stop' }], usage: {} })
            },
        })
        try {
            const tools = await Agent.tool.scan(new URL('./fixtures/tools', import.meta.url))
            const agent = Agent.create({ config: { ...config, baseURL: `http://127.0.0.1:${server.port}/v1`, maxSteps: 1 }, tools })
            expect(await agent.send('继续')).toEqual({ reason: 'step-limit', text: '等一下' })
            expect(calls).toBe(1) // 原来要等连续三次无工具调用，轮数设为 1 就只请求一次。
        } finally { server.stop(true) }
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

    test('工具轮里发出去的消息，工具调用和结果始终配对', async () => {
        // 真实中转站会校验：一条 tool 消息的 tool_call_id 必须对应前面某条 assistant 的 tool_calls，
        // 否则直接 400。消息整理如果做了两遍，第二遍会看不到"这个调用有结果"的名单，
        // 把调用摘掉、结果留下，于是任何带工具的多轮对话打到真服务都会挂。
        // 这条测试直接检查发给模型的那份请求体（OpenAI 格式：调用在 tool_calls 字段里）。
        const sent = []
        let round = 0
        const mock = Bun.serve({
            port: 0,
            async fetch(request) {
                sent.push(await request.json())
                round += 1
                const message = round === 1
                    ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'echo', arguments: '{"value":"x"}' } }] }
                    : { role: 'assistant', content: '完成' }
                return Response.json({ choices: [{ index: 0, message, finish_reason: round === 1 ? 'tool_calls' : 'stop' }], usage: {} })
            },
        })
        try {
            const tools = await Agent.tool.scan(new URL('./fixtures/tools', import.meta.url))
            const agent = Agent.create({ tools, config: { ...config, baseURL: `http://127.0.0.1:${mock.port}/v1`, noToolRounds: 1 } })
            await agent.send('执行')

            expect(sent).toHaveLength(2) // 第一轮调工具，第二轮带着工具历史收尾。
            const declared = new Set(sent[1].messages.flatMap(message => (message.tool_calls ?? []).map(call => call.id)))
            const answered = sent[1].messages.filter(message => message.role === 'tool').map(message => message.tool_call_id)
            expect(declared).toEqual(new Set(['call-1']))                 // 工具调用必须还在。
            expect(answered.every(id => declared.has(id))).toBe(true)     // 工具结果必须找得到发起它的调用。
        } finally { mock.stop(true) }
    })
})
