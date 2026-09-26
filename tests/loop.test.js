/*
盯住"驱动一台 Agent"这件事：send / stop / compact 三者抢跑时的状态机，以及主循环的出口。

这个包的运行状态只有一份（agent.running）。send 和 compact 都要同步顶替它、把停旧任务
放进自己任务内部，所以同一个 tick 里连发两次调用时，后来的必定看得见先来的。
凡是破坏这条的写法都会在这里红——包括"新指令插到旧任务收尾之前"这种 history 乱序。
*/

import { expect, test, describe, afterAll } from 'bun:test'
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
})
