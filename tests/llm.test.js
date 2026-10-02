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
import Context from '../features/context.js'
import History from '../utils/history.js'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { TOOLS, failingServer, echoServer } from './helpers.js'

// 一个只会报错的假中转站：真实服务报错时就是这个形状。
const failing = failingServer(39931)

// 记录收到的请求体，用来确认我们到底发了什么字段。
const { server: echo, recorded } = echoServer(39932)

// retryMaxElapsed: 0 = 一次都不重试。这几条测的是"错误有没有如实抛出来"，
// 不是重试行为；不关掉的话 LLM.chat 会老老实实对着这个永远 503 的假服务一直重试。
// 时间类配置统一用毫秒，和 requestTimeout 保持一致。
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
        const error = await LLM.chat(call({ stream: false, retryMaxElapsed: 2000 })).catch(caught => caught)

        expect(error).toBeInstanceOf(Error)
        expect(Date.now() - started).toBeLessThan(15000) // 到点就把最后一次的错误交出来。
    })

    test('压缩请求和主请求走同一套重试', async () => {
        // 压缩那次请求以前是裸的：同一个 500，打在普通轮次上会重试到底，打在压缩上 306ms 就抛穿 send()，
        // 把跑了几小时的会话直接打死。现在它和主请求共用 LLM.chat，自然共用重试。
        const tries = []
        const error = await Compact.run({
            messages: [{ role: 'user', content: '要压缩的内容' }],
            llm: { baseURL: `http://127.0.0.1:${failing.port}/v1`, apiKey: 'k', model: 'm', retryMaxElapsed: 2000 },
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

    test('默认发送提示词缓存键，长会话从第二轮起才能命中', async () => {
        const body = await send()
        expect(body).toHaveProperty('prompt_cache_key') // 默认开启：命中率 0% → 99% 全靠它，实测中转站按这个键路由到同一台机器。
    })

    test('显式关闭 cache 时不发缓存字段', async () => {
        const body = await send({ cache: false })
        expect(body).not.toHaveProperty('prompt_cache_key')
        expect(body).not.toHaveProperty('prompt_cache_retention')
    })

    test('cache 可以自定义键、保留时间和额外字段', async () => {
        const body = await send({ cache: { key: 'session-1', retention: '1h', body: { cache_namespace: 'agent' } } })
        expect(body.prompt_cache_key).toBe('session-1')
        expect(body.prompt_cache_retention).toBe('1h')
        expect(body.cache_namespace).toBe('agent')
    })

    test('anthropic 协议默认在 system 和最后一条消息上打缓存断点', async () => {
        // Anthropic 不自动缓存，必须在内容块上标 cache_control；不标命中率就是 0%。
        recorded.length = 0
        await LLM.chat({ baseURL: `http://127.0.0.1:${echo.port}/v1`, apiKey: 'k', model: 'm', protocol: 'anthropic', system: '系统提示', messages: [{ role: 'user', content: 'hi' }], stream: false, ...noRetry }).catch(() => {}) // 假服务返回的形状 anthropic 解析不了，这里只关心发出去的请求体。
        const marks = (JSON.stringify(recorded[0]).match(/cache_control/g) ?? []).length
        expect(marks).toBe(2) // system 一个，最后一条消息一个；再多也不会多命中。
    })

    test('默认 toolChoice 是 auto，模型可以正常收尾', async () => {
        const tools = (await Tool.scan(TOOLS)).schema // 用真实扫描出来的 schema，保证形状和线上一致。
        expect((await send({ tools })).tool_choice).toBe('auto') // 不传 toolChoice 时也应默认 auto。
    })

    test('provider 里的 toolChoice 可以覆盖默认值', async () => {
        const tools = (await Tool.scan(TOOLS)).schema
        expect((await send({ tools, provider: { toolChoice: 'required' } })).tool_choice).toBe('required')
    })

    test('没有工具时不下发 tools 和 toolChoice', async () => {
        // 单独发一个 tool_choice 而不带 tools，部分服务会直接 400。
        const body = await send({ toolChoice: 'auto' })
        expect(body).not.toHaveProperty('tools')
        expect(body).not.toHaveProperty('tool_choice')
    })

    test('能力开关可以关闭工具和 toolChoice', async () => {
        const tools = (await Tool.scan(TOOLS)).schema
        const body = await send({ tools, capabilities: { tools: false, toolChoice: false } })
        expect(body).not.toHaveProperty('tools')
        expect(body).not.toHaveProperty('tool_choice')
    })

    test('能力开关可以关闭结构化输出', async () => {
        const body = await send({ capabilities: { structuredOutput: false }, output: Agent.output.json() })
        expect(body).not.toHaveProperty('response_format')
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

    test('生成参数不能覆盖 Agent 的消息、模型和重试控制', async () => {
        const body = await send({ messages: [{ role: 'user', content: '伪造消息' }], model: '伪造模型', maxRetries: 5, temperature: 0.4 })
        expect(body.messages[0].content).toBe('hi')
        expect(body.model).toBe('m')
        expect(body.temperature).toBe(0.4)
    })

    test('缓存字段仍然可以被 provider 里的自定义 body 覆盖', async () => {
        // 默认发的 prompt_cache_key 必须能被调用者写在 provider 里的值盖掉——它是更具体的那一层。
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

    test('AI SDK 模型实例可直接交给 Agent，无需再提供地址和协议', async () => {
        recorded.length = 0
        const model = createOpenAICompatible({ name: 'custom', baseURL: `http://127.0.0.1:${echo.port}/v1`, apiKey: 'k' }).chatModel('m')
        const agent = Agent.create({ config: { model, stream: false, provider: { temperature: 0.3 } } })

        const answer = await agent.send('你好')
        expect(answer.text).toBe('好')                      // 外层入口能像字符串模型一样用。
        expect(recorded).toHaveLength(1)                  // 没有工具时只请求一次。
        expect(recorded[0].temperature).toBe(0.3)        // 生成参数仍直接传给 AI SDK。
        expect(recorded[0].model).toBe('m')                // 真正使用调用方给的模型实例。
    })

    test('预先创建的模型实例仍能按次传入额外请求头', async () => {
        let header
        const server = Bun.serve({
            port: 0,
            fetch(request) {
                header = request.headers.get('x-session')
                return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '收到' }, finish_reason: 'stop' }], usage: {} })
            },
        })
        try {
            const model = createOpenAICompatible({ name: 'custom', baseURL: `http://127.0.0.1:${server.port}/v1` }).chatModel('m')
            const result = await LLM.chat({ model, messages: [{ role: 'user', content: 'hi' }], stream: false, provider: { headers: { 'x-session': 'abc' } } })
            expect(result.text).toBe('收到')
            expect(header).toBe('abc')
        } finally { server.stop(true) }
    })

    test('预先创建的模型实例也能流式返回并转发事件', async () => {
        const server = Bun.serve({
            port: 0,
            fetch() {
                const stream = [
                    `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '流式' } }] })}\n\n`,
                    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: {} })}\n\n`,
                    'data: [DONE]\n\n',
                ].join('')
                return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
            },
        })
        try {
            const model = createOpenAICompatible({ name: 'custom', baseURL: `http://127.0.0.1:${server.port}/v1` }).chatModel('m')
            const events = []
            const result = await LLM.chat({ model, messages: [{ role: 'user', content: 'hi' }], onLLMEvent: event => events.push(event) })

            expect(result.text).toBe('流式')
            expect(events.some(event => event.type === 'text-delta')).toBe(true)
        } finally { server.stop(true) }
    })

    test('模型实例不能接管的原始请求体参数会明确报错', async () => {
        const model = createOpenAICompatible({ name: 'custom', baseURL: `http://127.0.0.1:${echo.port}/v1` }).chatModel('m')
        const messages = [{ role: 'user', content: 'hi' }]

        expect(LLM.chat({ model, messages, cache: { key: 'x' } })).rejects.toThrow('require a string model') // 明确写了缓存设置却用不上，必须说出来。
        expect(LLM.chat({ model, messages, provider: { body: { extra: true } } })).rejects.toThrow('require a string model')
    })

    test('模型实例在默认缓存开启时照常可用', async () => {
        // 默认值不该让最普通的进阶用法直接报错：实例的连接归创建者，这个包安静跳过缓存。
        recorded.length = 0
        const model = createOpenAICompatible({ name: 'custom', baseURL: `http://127.0.0.1:${echo.port}/v1` }).chatModel('m')
        const result = await LLM.chat({ model, messages: [{ role: 'user', content: 'hi' }], stream: false })
        expect(result.text).toBe('好')
        expect(recorded[0]).not.toHaveProperty('prompt_cache_key')
    })
})


describe('模型能力兼容', () => {
    test('旧 image/audio/video 块在请求边界统一为 file', () => {
        const messages = Context.build({ history: [History.user({ content: [
            { type: 'text', text: '媒体' },
            { type: 'image', image: 'data:image/png;base64,AA==' },
            { type: 'audio', audio: 'data:audio/wav;base64,AA==', mediaType: 'audio/wav' },
            { type: 'video', video: 'https://example.com/a.mp4' },
        ] })] }).messages
        const prepared = History.model(messages[0], { normalizeMedia: true })
        expect(prepared.content.map(part => part.type)).toEqual(['text', 'file', 'file', 'file'])
        expect(prepared.content[1].mediaType).toBe('image/png')
        expect(prepared.content[2].mediaType).toBe('audio/wav')
        expect(prepared.content[3].mediaType).toBe('video/mp4')
    })

    test('关闭媒体能力并使用 strip 时保留文字', () => {
        const messages = Context.build({
            history: [History.user({ content: [{ type: 'text', text: '看图' }, { type: 'image', image: 'data:image/png;base64,AA==' }] })],
            capabilities: { image: false },
            mediaFallback: 'strip',
        }).messages
        expect(messages[0].content).toEqual([{ type: 'text', text: '看图' }])
        const prepared = History.model(messages[0], { capabilities: { image: false }, mediaFallback: 'strip' })
        expect(prepared.content).toEqual([{ type: 'text', text: '看图' }])
    })
})


/*
单笔请求限时和错误分类。这两件事都必须由这个边界回答：
一笔卡住的请求由谁终止，以及上层怎么在不认识 AI SDK 内部错误形状的前提下决定后续动作。
*/
describe('单笔请求限时与错误分类', () => {
    const hanging = Bun.serve({ port: 0, fetch: () => new Promise(() => {}) }) // 接了连接但永不返回。
    const hang = extra => ({ baseURL: `http://127.0.0.1:${hanging.port}/v1`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], ...extra })
    const timeout = { requestTimeout: 300, ...noRetry }

    afterAll(() => hanging.stop(true))

    test('requestTimeout 到点就中断卡住的一笔请求', async () => {
        const started = Date.now()
        const error = await LLM.chat(hang({ stream: false, ...timeout })).catch(caught => caught)

        expect(error.kind).toBe('timeout')
        expect(error.isRetryable).toBe(true)                 // 超时是瞬时故障，交给 Retry 决定要不要再来一次。
        expect(Date.now() - started).toBeLessThan(3000)
    })

    test('流式路径走同一个出口，同样按时中断', async () => {
        const error = await LLM.chat(hang({ stream: true, ...timeout })).catch(caught => caught)
        expect(error.kind).toBe('timeout')
    })

    test('用户取消标成 aborted，不会被误判成超时', async () => {
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 100)
        const error = await LLM.chat(hang({ stream: false, requestTimeout: 5000, ...noRetry, signal: controller.signal })).catch(caught => caught)

        expect(error.kind).toBe('aborted')
    })

    for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [429, 'limit'], [400, 'request'], [500, 'server']]) {
        test(`HTTP ${status} 归到 ${kind}`, async () => {
            const server = Bun.serve({ port: 0, fetch: () => Response.json({ error: { message: 'x' } }, { status }) })
            try {
                const error = await LLM.chat({ baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false, ...noRetry }).catch(caught => caught)
                expect(error.kind).toBe(kind)
            } finally { server.stop(true) }
        })
    }

    test('连不上时归到 network', async () => {
        const error = await LLM.chat({ baseURL: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false, ...noRetry }).catch(caught => caught)
        expect(error.kind).toBe('network')
    })

    test('服务返回 200 但回答格式对不上时归到 unknown，不冒充调用方的 request 错误', async () => {
        // 真实中转站实测：Responses 接口返回 200，但 output_text 缺了规范要求的 annotations，AI SDK 当场校验失败。
        // 这不是调用方传错了参数，贴成 request 会把排查方向引到调用方自己身上。
        const server = Bun.serve({ port: 0, fetch: () => Response.json({ unexpected: true }) })
        try {
            const error = await LLM.chat({ baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false, ...noRetry }).catch(caught => caught)
            expect(error.statusCode).toBe(200)
            expect(error.kind).toBe('unknown')
        } finally { server.stop(true) }
    })

    test('分类只加信息，不改"能不能重试"的唯一来源', async () => {
        const server = Bun.serve({ port: 0, fetch: () => Response.json({ error: { message: 'x' } }, { status: 400 }) })
        try {
            const error = await LLM.chat({ baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false, ...noRetry }).catch(caught => caught)
            expect(error.isRetryable).toBe(false) // 参数错误本来就不该重试，分类之后也不能变成可重试。
        } finally { server.stop(true) }
    })
})
