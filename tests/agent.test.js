/*
盯住 Agent 这个最外层入口本身：怎么造、怎么喂输入、参数怎么合并。

这里不测主循环怎么跑（那是 loop.test.js 的事），只测"调用者写下的东西有没有被正确接住"。
调用体验的每一条抱怨最后都落在这个文件里：少写一个对象字面量、少传一层 config、
不该被共享的对象被共享了。
*/

import { expect, test, describe, afterAll } from 'bun:test'
import Agent from '../index.js'
import History from '../utils/history.js'

const recorded = []
const server = Bun.serve({
    port: 39981,
    async fetch(request) {
        recorded.push(await request.json())
        return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }], usage: {} })
    },
})
const config = extra => ({ baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'm', stream: false, ...extra })

afterAll(() => server.stop(true))


describe('Agent 入口', () => {
    test('拿到的对象就是 Agent 公开的内部状态', () => {
        const history = []
        const first = Agent.create({ history })
        const second = Agent.create()

        expect(first.history).toBe(history)     // 直接保存外部传入的数组，外部和 Agent 共同修改它。
        expect(second.history).toEqual([])      // 不传就是各自新建的，两台 Agent 不共享。
        expect(first.config.protocol).toBe('chat')
        expect(first.running).toBeNull()
    })

    test('config 里的 provider 是浅拷一层，两个 Agent 不共享同一个对象', () => {
        const shared = { temperature: 0.2 }
        const first = Agent.create({ config: { provider: shared } })
        const second = Agent.create({ config: { provider: shared } })

        expect(first.config.provider).not.toBe(shared)   // 改一台的 provider 不该动到另一台或调用方手里那个。
        expect(first.config.provider).toEqual({ temperature: 0.2 })
        expect(second.config.provider).toEqual({ temperature: 0.2 })
    })

    test('send 替换 provider 后不会持有调用方的对象', async () => {
        const agent = Agent.create({ config: config() })
        const provider = { temperature: 0.2 }
        await agent.send({ input: '你好', config: { provider } })
        provider.temperature = 0.9
        expect(agent.config.provider.temperature).toBe(0.2)
    })

    test('send 直接收一句话，不用包成对象', async () => {
        // 最常用的调用形态。逼调用者写 send({ input: '你好' }) 是把内部结构漏出来。
        recorded.length = 0
        const agent = Agent.create({ config: config() })
        await agent.send('你好')

        expect(agent.history[0].content).toBe('你好')
        expect(recorded[0].messages.at(-1).content).toBe('你好') // 第一次请求就该带上这句话。
    })

    test('send 收内容块数组（发图片走这条路）', async () => {
        const shot = [{ type: 'text', text: '这张图' }, { type: 'image', image: 'data:image/png;base64,iVBORw0KGgo=' }]
        const agent = Agent.create({ config: config() })
        await agent.send(shot)

        expect(agent.history[0].content).toEqual(shot)
    })

    test('send 的完整形式仍然可用，参数照常生效', async () => {
        const agent = Agent.create({ config: config() })
        await agent.send({ input: '完整形式', config: { provider: { temperature: 0.4 } } })

        expect(agent.history[0].content).toBe('完整形式')
        expect(recorded.at(-1).temperature).toBe(0.4)
    })

    test('空输入当场拒绝，而不是发出一轮空请求', () => {
        const agent = Agent.create({ config: config() })

        expect(() => agent.send('')).toThrow('input must be')
        expect(() => agent.send('   ')).toThrow('input must be')  // 只有空白也算空。
        expect(() => agent.send([])).toThrow('input must be')
        expect(() => agent.send({})).toThrow('input must be')     // 完整形式漏了 input 也一样。
        expect(agent.history.length).toBe(0)                      // 被拒绝的输入不写进历史。
    })

    test('send 之后 config 按字段合并，没传的字段继续保留', async () => {
        const agent = Agent.create({ config: config({ maxToolOutput: 1000, provider: { temperature: 0.1 } }) })
        await agent.send({ input: '第一次', config: { maxToolOutput: 2000 } })

        expect(agent.config.maxToolOutput).toBe(2000)   // 这次改的。
        expect(agent.config.provider.temperature).toBe(0.1) // 没提的继续留着。
        expect(agent.config.maxTokens).toBeGreaterThan(0)   // 默认值也没被清掉。
    })

    test('历史是外部传进来的那份数组，Agent 往里追加而不是替换', async () => {
        const history = [History.user({ content: '上一轮' })]
        const agent = Agent.create({ history, config: config() })
        await agent.send('这一轮')

        // 只数用户说的话：助手消息和临时提示也写进历史，它们的条数不是这条测试要盯的东西。
        const said = history.filter(message => message.role === 'user').map(message => message.content)
        expect(agent.history).toBe(history) // 引用没换过。
        expect(said).toEqual(['上一轮', '这一轮'])
    })

    test('send 支持按次替换整份历史', async () => {
        const agent = Agent.create({ config: config() })
        await agent.send('第一条')
        const replaced = [History.user({ content: '换一份历史' })]
        await agent.send({ input: '第二条', history: replaced })

        expect(agent.history).toBe(replaced)
    })
})
