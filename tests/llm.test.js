/*
盯住这个项目和模型供应商之间唯一的边界。

这个文件里的测试全都建立在一条契约上：LLM.chat 要么返回一份完整结果，
要么把供应商给的原始错误原样抛出去。中间不存在"这次回答其实失败了但看起来像成功"的状态。
"能不能重试"也只有一个来源——错误自己带的 isRetryable，这里不照着状态码再判断一遍。
*/

import { expect, test, describe, afterAll } from 'bun:test'
import Agent from '../index.js'
import Tool from '../features/tool.js'
import LLM from '../utils/llm.js'
import Compact from '../features/compact.js'
import { TOOLS, failingServer, echoServer } from './helpers.js'

// 一个只会报错的假中转站：真实服务报错时就是这个形状。
const failing = failingServer(39931)

// 记录收到的请求体，用来确认我们到底发了什么字段。
const { server: echo, recorded } = echoServer(39932)

// retryMaxElapsed: 0 = 一次都不重试。这几条测的是"错误有没有如实抛出来"，
// 不是重试行为；不关掉的话 LLM.chat 会老老实实对着这个永远 503 的假服务重试满 5 分钟。
const noRetry = { retryMaxElapsed: 0 }
const call = extra => ({ baseURL: `http://127.0.0.1:${failing.port}/v1`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], ...extra })

afterAll(() => { failing.stop(true); echo.stop(true) })


describe('LLM 边界', () => {
    test('流式请求里的供应商错误会被抛出来，不再伪装成正常回答', () => {
        expect(LLM.chat(call({ stream: true, ...noRetry }))).rejects.toThrow() // 以前它会返回一个空文本的"成功"结果，上层完全看不出请求失败过。
    })

    test('抛出来的错误带着 AI SDK 的可重试标记，Retry 才认得出', async () => {
        const error = await LLM.chat(call({ stream: true, ...noRetry })).catch(caught => caught)
        expect(error.isRetryable).toBe(true) // 503 该重试；以前这里是 AI_NoOutputGeneratedError，没有这个字段，重试从来不会发生。
    })

    test('一直失败也会在时间预算内收手，不会永远重试', async () => {
        // 重试搬进 LLM.chat 之后，次数不设限；上界改成时间。
        // 没有这条上界的话服务挂一整天 send() 也不 resolve 不 reject，上层连"出事了"都不知道。
        const started = Date.now()
        const error = await LLM.chat(call({ stream: false, retryMaxElapsed: 2 })).catch(caught => caught)

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
})


describe('请求里到底发了什么', () => {
    const send = async extra => {
        recorded.length = 0
        await LLM.chat({ baseURL: `http://127.0.0.1:${echo.port}/v1`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false, ...extra })
        return recorded[0]
    }

    test('默认不发 OpenAI 私有的提示词缓存字段', async () => {
        const body = await send()
        expect(body).not.toHaveProperty('prompt_cache_key') // 实测 gpt-oss-120b 会因为这个字段直接 400。
        expect(body).not.toHaveProperty('prompt_cache_retention')
    })

    test('显式打开 cache 时才发缓存字段', async () => {
        expect(await send({ cache: true })).toHaveProperty('prompt_cache_key')
    })

    test('默认 toolChoice 是 auto，模型可以正常收尾', async () => {
        const tools = (await Tool.scan(TOOLS)).schema // 用真实扫描出来的 schema，保证形状和线上一致。
        expect((await send({ tools, toolChoice: 'auto' })).tool_choice).toBe('auto') // 写死 required 会让 gpt-oss-120b 在模型不想调工具时返回 tool_use_failed。
    })

    test('没有工具时不下发 tools 和 toolChoice', async () => {
        // 单独发一个 tool_choice 而不带 tools，部分服务会直接 400。
        const body = await send({ toolChoice: 'auto' })
        expect(body).not.toHaveProperty('tools')
        expect(body).not.toHaveProperty('tool_choice')
    })
})


/*
AI SDK 的生成参数原样透传这一层。这些字段属于上游包，不属于这个项目：
调用者写了什么就发什么，这个包不翻译、不改名、不白名单、不校验。
凡是"这个包只接了 8 个字段"的写法都会在这里红——上游加新参数时不该让这个包跟着发版。
*/
describe('provider 生成参数透传', () => {
    const send = async provider => {
        recorded.length = 0
        await LLM.chat({ baseURL: `http://127.0.0.1:${echo.port}/v1`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false, provider })
        return recorded[0]
    }

    test('高频采样参数落到请求体里的正确字段名', async () => {
        // 这些是 OpenAI 风格的名字。名字翻译由 AI SDK 负责，这个包只负责把值送到它手上。
        const body = await send({ temperature: 0.5, topP: 0.9, maxOutputTokens: 123, presencePenalty: 0.1, frequencyPenalty: 0.2, stopSequences: ['END'], seed: 7 })

        expect(body.temperature).toBe(0.5)
        expect(body.top_p).toBe(0.9)              // 下划线是这个协议的形状，不是我们决定的。
        expect(body.max_tokens).toBe(123)
        expect(body.presence_penalty).toBe(0.1)
        expect(body.frequency_penalty).toBe(0.2)
        expect(body.stop).toEqual(['END'])
        expect(body.seed).toBe(7)
    })

    test('没写的生成参数一个都不出现在请求体里', async () => {
        // 这个包不替调用者的模型默认 temperature 之类的值——那是在猜他的模型。
        const body = await send(undefined)

        for (const field of ['temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty', 'stop', 'seed']) {
            expect(body).not.toHaveProperty(field)
        }
    })

    test('厂商私有参数原样送到请求体，不需要这个包认识它', async () => {
        // providerOptions 是自由对象。AI SDK 每加一个新参数都要这个包跟着改，是封装库烂掉的根源。
        const body = await send({ providerOptions: { agent: { some_future_knob: 'on' } } })
        expect(body.some_future_knob).toBe('on')
    })

    test('provider 里的未知字段不会让请求失败', async () => {
        // 上游改名或下线某个参数时，调用者的配置不该把整次请求打挂。
        const body = await send({ temperature: 0.3, somethingUpstreamRemoved: true })
        expect(body.temperature).toBe(0.3)
    })

    test('缓存字段仍然可以被 provider 里的自定义 body 覆盖', async () => {
        // cache 是这个包的开关（默认关，因为中转站大多不认这组字段），
        // 但调用者显式写在 provider 里的值必须赢——它是更具体的那一层。
        const body = await send({ body: { prompt_cache_key: 'mine' } })
        expect(body.prompt_cache_key).toBe('mine')
    })
})


/*
Agent 这一层的配置有没有落到请求上。上面测的是 LLM.chat 本身，
这里测的是"从 Agent.create 到出网"整条路上参数会不会丢。
*/
describe('Agent 配置落到请求上', () => {
    const config = extra => ({ baseURL: `http://127.0.0.1:${echo.port}/v1`, apiKey: 'k', model: 'm', stream: false, ...extra })

    test('Agent 的 provider 参数会一路走到请求体', async () => {
        recorded.length = 0
        const agent = Agent.create({ config: config({ provider: { temperature: 0.2, topP: 0.8 } }) })
        await agent.send({ input: '你好' })

        expect(recorded.at(-1).temperature).toBe(0.2) // Agent 是最外层入口，最容易在这里漏字段。
        expect(recorded.at(-1).top_p).toBe(0.8)
    })

    test('send 时按次覆盖 provider，写进去的就是这次要用的全部', async () => {
        recorded.length = 0
        const agent = Agent.create({ config: config({ provider: { temperature: 0.2, topP: 0.8 } }) })
        await agent.send({ input: '第一条' })
        await agent.send({ input: '第二条', config: { provider: { temperature: 0.9 } } })

        expect(recorded.at(-1).temperature).toBe(0.9)    // 这次覆盖的。
        expect(recorded.at(-1).top_p).toBeUndefined()    // provider 整包替换，不做逐字段合并——半套参数比整包更难推理。
    })

    test('两个 Agent 各改各的 provider，互不影响', async () => {
        recorded.length = 0
        const shared = { temperature: 0.2 }
        const first = Agent.create({ config: config({ provider: shared }) })
        const second = Agent.create({ config: config({ provider: shared }) })
        first.config.provider.temperature = 0.9

        await first.send({ input: 'A' })
        const afterFirst = recorded.length // 一次 send 会打多轮请求（模型不调工具时要走完 no-tool 出口），按次数切分而不是取最后一条。
        await second.send({ input: 'B' })

        expect(afterFirst).toBeGreaterThan(0)
        expect(recorded.slice(0, afterFirst).every(body => body.temperature === 0.9)).toBe(true)  // 第一台全程用自己的值。
        expect(recorded.slice(afterFirst).every(body => body.temperature === 0.2)).toBe(true)     // 第二台不受影响。
        expect(shared.temperature).toBe(0.2)                                                       // 传入的那个对象也不该被改动。
    })
})
