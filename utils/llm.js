/*
目标被调用形式（绝对不可修改）：
const result = await LLM.chat({
    // --- 连接（必填）---
    baseURL: "https://中转站/v1",      // model 是字符串时必填；传模型实例时由实例负责连接
    apiKey: "sk-xxx",
    model: "model-name",          // 或直接传 AI SDK 创建的模型实例，保留自定义 Provider / 中间件
    protocol: "chat",               // chat / responses / anthropic / gemini，默认 chat
    system,                         // 系统提示词；也可以放进 messages 里的 system 消息
    messages: [...],                // 必填

    // --- 工具（可选）---
    tools: tools.schema,           // Agent.tool.scan() 返回的工具名 → 描述对象
    toolChoice: "auto",             // 也可写在 provider 里；没传 tools 时不会出现在请求里
    toolMode: "native",             // native（默认）：只用原生工具字段，system 零注入
                                    // text：模拟工具——不发 tools，把工具说明注入 system，调用从文字里读
                                    // auto：兼容降级——原生优先，接口拒收时才改用文字协议（那时才注入）

    // --- 生成参数，全部可选（原样交给 AI SDK，这个文件不认识它们）---
    provider: {
        temperature: 0.5,
        topP: 0.9,
        maxOutputTokens: 4096,
        stopSequences: ["END"],
        seed: 7,
        toolChoice: 'auto',         // 不设置也默认 auto
        providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } } },
        headers: {},                // 额外请求头；模型实例走 AI SDK 的请求级 headers
        body: {},                   // 原始请求体，仅本包创建的字符串模型可用
    },

    // --- 流式与回调 ---
    stream: true,
    onLLMEvent: event => {},        // 流式时原样接收 AI SDK 的每个事件
    onLLMStart: request => {},      // 每次真实请求前调用，重试也算一次
    onRetry: info => {},

    // --- 重试（毫秒）---
    retryMaxDelay: undefined,       // 不限制单次退避上限；调用方可主动设置毫秒数
    retryMaxElapsed: undefined,     // 不限制重试总时长；调用方可主动设置毫秒数

    // --- 控制信号 ---
    signal: abortSignal,
    requestTimeout: undefined,      // 单笔请求最多等多久（毫秒）；不设就不限时

    // --- 提示词缓存（默认开启）---
    cache: true,                    // true 使用默认键；{ key, retention, body } 自定义；false 完全关闭
    capabilities: { image, audio, video, file, tools, structuredOutput, toolChoice, reasoning }, // 针对脆弱渠道逐项关闭能力
    mediaFallback: 'error',         // 关闭媒体后报错；'strip' 只保留文字继续请求
});

provider 里的生成参数交给 AI SDK；连接信息、消息和重试控制由这个包持有，不接受 provider 覆盖。
AI SDK 认识的生成参数就用上、不认识的就忽略。于是上游加新参数时这个包一行都不用改，
调用者在新旧 AI SDK 之间也不会被这个包卡住。
传已创建的模型实例时，连接配置和原始请求体由创建它的 Provider 决定；本包只负责发送消息和生成参数。

两条接入路径共用后面的请求流程，不各自维护一份流式、取消和重试实现：
  模型名   → 本包创建连接 → AI SDK 请求 → 完整结果
  模型实例 → 保留现成连接 → AI SDK 请求 → 完整结果
因此换成实例后，onLLMEvent、onRetry、signal 和返回值仍然保持同一种用法。
Agent 的自动压缩也使用 LLM.chat，所以不需要为压缩再建一份模型配置。

模型实例必须与本包使用的 AI SDK 模型接口兼容，不代表任意版本都能混用。
调用方包裹模型的日志、路由或其他中间件也属于这个实例，不在这里拆开或重建。
headers 是 AI SDK 支持的请求级参数，因此两条路径都可以设置。
body 和 cache 是本包创建连接时加上的 fetch 行为，无法补进一个已经创建好的实例。
需要这两项的调用方，可以继续用模型名写法，或在创建自己的 Provider 时配置。

这个文件是整个项目与模型供应商之间唯一的边界：
要么返回一份完整结果，要么把供应商给的原始错误原样抛出去。
"这次回答是不是其实失败了"不会流到上层，所以 Loop 和 Retry 都不需要再判断一遍。

抛出去的模型错误会带一个稳定的 kind：aborted / auth / limit / timeout / server / network / request / unknown。
unknown 指服务返回了成功状态码，但回答格式对不上（不完全兼容的中转站最常见）。
上层靠它决定"该重试、该换模型、还是该直接报给用户"，不用去认 AI SDK 的内部错误形状。
kind 只补充信息，"能不能重试"仍然只由 error.isRetryable 决定，这里不制造第二套判断标准。

requestTimeout 是单笔请求的限时，每次重试各自重新计时：
不设就不限时（默认），卡住的一笔请求会一直等下去，由调用方决定要不要设。
超时属于传输层瞬时故障，和流被截断同类，因此会补上 isRetryable，让 Retry 决定要不要再来一次。
*/

import { generateText, streamText } from 'ai'                        // 统一使用上游的生成和流式能力。
import { createOpenAI } from '@ai-sdk/openai'                         // 模型名写法中的 Responses 连接。
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'    // 默认的 OpenAI Chat 兼容连接。
import { createAnthropic } from '@ai-sdk/anthropic'                   // 模型名写法中的 Anthropic 连接。
import { createGoogle } from '@ai-sdk/google'                         // 模型名写法中的 Gemini 连接。
import Retry from './retry.js'                                       // 主请求和压缩请求共用的退避重试。
import History from './history.js'                                   // 在发给供应商前把旧媒体块统一成 AI SDK 当前形态。
import TextTools from './text-tools.js'                              // 纯对话模型的文字工具协议：说明书、解析、降级。


// --- 提示词缓存：每种协议要的东西不一样，这里集中回答 ---
// 实测（lingloft 中转站，同一会话的多步工具循环，默认配置）：
//   chat：服务端按 prompt_cache_key 路由到同一处缓存。不发 0%，发了第二步起 99%。
//   anthropic：服务端不自动缓存，必须在内容块上标 cache_control。不标 0%，标了第三步起每步命中整段开头。
//   gemini：隐式缓存由服务端自己决定，请求里没有可发的字段。
// 键只取"这段对话从哪开始"：同一台 Agent 的连续请求开头相同，自然落在同一个键上。
const cacheKey = ({ baseURL, model, system }, options) => options.key ?? `agent:${baseURL}:${model}:${Bun.hash(JSON.stringify(system || ''))}`

// Anthropic 一次请求最多 4 个缓存断点。这里用 2 个：
// system 一个（工具描述排在 system 前面，会被一起缓存），最后一条消息一个（下一轮从这里接着读）。
// 两个断点覆盖了"固定开头"和"上一轮为止的全部对话"，再多不会多命中。
const mark = target => ({ ...target, providerOptions: { ...target.providerOptions, anthropic: { ...target.providerOptions?.anthropic, cacheControl: { type: 'ephemeral' } } } })

// 断点标在最后一个内容块上而不是消息上：AI SDK 对块级标记支持最完整，tool 消息和多块消息都一样处理。
// 纯文本消息先摊成一个文字块，才有地方挂标记。
const markLast = message => {
    const content = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }]
    if (!content.length) return message
    return { ...message, content: [...content.slice(0, -1), mark(content.at(-1))] }
}


// --- 建一条模型连接：模型名写法专用，协议决定用哪个 Provider ---
// 已创建的模型实例不走这里，它的连接由调用方自己负责。
const connect = ({ baseURL, apiKey, model, protocol, system, headers, cache, bodyOverrides, generation }) => {
    const settings = { apiKey, baseURL, headers } // 连接三件套：地址、密钥、额外请求头。

    // 默认开启。chat / responses 发 prompt_cache_key；个别不认这个字段的中转站会 400，设 cache:false 即可关掉。
    const cacheOptions = cache === true ? {} : cache || {}
    const cacheBody = cache && ['chat', 'responses'].includes(protocol)
        ? { prompt_cache_key: cacheKey({ baseURL, model, system }, cacheOptions), ...(cacheOptions.retention ? { prompt_cache_retention: cacheOptions.retention } : {}), ...cacheOptions.body }
        : {}
    const finalBody = { ...cacheBody, ...bodyOverrides } // 自定义 body 可以覆盖默认缓存字段。

    // 只有自己创建的 Provider 才能接管 fetch，并入调用方要求的原始请求体字段。
    if (Object.keys(finalBody).length) {
        settings.fetch = async (input, init) => {
            let body = init?.body // AI SDK 已经组好的协议请求体，连接层只负责并入额外字段。
            if (typeof body === 'string') {
                try { body = { ...JSON.parse(body), ...finalBody } } // 明确指定的原始字段优先。
                catch (error) { throw new TypeError('AI SDK request body is not valid JSON', { cause: error }) } // 保留原始解析错误，便于定位上游响应形状。
            }
            return fetch(input, { ...init, body: body && JSON.stringify(body) }) // 保留 SDK 的请求头、方法和取消信号。
        }
    }

    if (protocol === 'chat') return createOpenAICompatible({ ...settings, name: 'agent', supportsStructuredOutputs: Boolean(generation.output) }).chatModel(model) // 显式选择结构化输出时把 schema 一起发给服务端。
    if (protocol === 'responses') return createOpenAI(settings).responses(model)         // 官方 OpenAI Responses 接口。
    if (protocol === 'anthropic') return createAnthropic(settings).languageModel(model)   // Anthropic 原生接口。
    if (protocol === 'gemini') return createGoogle(settings).languageModel(model)         // Google 原生接口。
    return protocol // 认不出来就原样返回，由调用方报错，不在这里抛。
}


// --- 发一次请求：流式和非流式在这里分叉，但对外表现完全一致 ---
// markAttempt 把本笔请求的限时信号交回给 chat，错误分类靠它区分"限时到点"和"用户取消"。
const request = async ({ input, stream, requestTimeout, markAttempt, onLLMEvent }) => {
    const attempt = Number.isFinite(requestTimeout) && requestTimeout > 0 ? AbortSignal.timeout(requestTimeout) : null // 重试各自重新计时。
    markAttempt(attempt)
    if (attempt) input.abortSignal = input.abortSignal ? AbortSignal.any([input.abortSignal, attempt]) : attempt

    // 非流式：等待模型完整返回，供应商错误会直接抛出来。
    if (!stream) {
        const result = await generateText(input)
        return {
            text: await result.text, // 模型最后生成的文字。
            toolCalls: await result.toolCalls, // 模型要求执行的工具调用。
            finishReason: await result.finishReason, // 模型停止生成的原因。
            usage: await result.usage, // 本次请求消耗的 Token。
            warnings: await result.warnings, // Provider 对请求参数的提示。
            responseMessages: await result.responseMessages, // 保存完整 assistant/tool 消息。
            ...(input.output && !result.toolCalls.length ? { output: result.output } : {}), // 工具轮没有最终对象，只有最终回答才读取 SDK 的校验结果。
        }
    }

    // 流式：逐个转发事件，再等待最终结果。
    const result = streamText(input) // 开始流式请求；真正的事件从 result.stream 产生。
    const text = [] // 单独收集文字，兼容部分 Provider 的事件字段差异。
    let failure = null // 供应商在流中途报的错。

    try {
        for await (const event of result.stream) {
            await onLLMEvent?.(event) // 不过滤事件，文字、思考、工具和错误都交给上层。
            if (event.type === 'error') failure = event.error // AI SDK 只对"中断流的网络错误"抛异常，供应商自己报的错是一个事件，不接住就会被当成正常回答。
            if (event.type === 'text-delta') text.push(event.textDelta ?? event.text ?? event.delta ?? '') // 收集最终文字。
        }
        if (failure) throw failure // 带着 statusCode 和 isRetryable，先于 result.finishReason 抛，避免被换成丢了这些字段的 AI_NoOutputGeneratedError。

        const finishReason = await result.finishReason
        if (finishReason === 'error') throw new Error('模型请求失败：供应商返回了错误但没有给出原因') // 只有 finishReason 报错、没有 error 事件时的兜底，不让失败伪装成成功。

    } catch (error) {
        // 流被截断、SSE 格式坏掉、缺 finish_reason 这类错误，AI SDK 不给 isRetryable 标记，
        // 但它们全是传输层的瞬时故障——中转站和代理最常见的就是这种，重试一次通常就好了。
        // 在边界上补标记而不是让 Retry 去认 AI SDK 的内部错误类型：判断"能不能重试"仍然只有一处来源。
        if (error?.isRetryable === undefined && error?.name !== 'AbortError') error.isRetryable = true
        throw error
    }
    // 格式错误属于最终回答错误，放在传输重试之外，避免反复重试一段不符合 schema 的 JSON。
    const toolCalls = await result.toolCalls
    return {
        text: text.join('') || await result.text,
        toolCalls,
        finishReason: await result.finishReason,
        usage: await result.usage,
        warnings: await result.warnings,
        responseMessages: await result.responseMessages,
        ...(input.output && !toolCalls.length ? { output: await result.output } : {}), // 使用 SDK 自己的 JSON 解析和 Zod 校验。
    }
}


// --- 给抛出去的错误贴一个稳定的分类 ---
// 只按错误自己带的证据判断，不改 isRetryable：能重试仍然只有"错误自己说能"这一个来源。
const label = (error, timeout) => {
    if (error?.kind) return error                                // 已经分过类，不重复贴。
    if (timeout?.aborted) error.kind = 'timeout'                 // 我们自己的限时先判，避免被当成用户取消。
    else if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') error.kind = 'aborted'
    else if (error?.statusCode === undefined) error.kind = 'network' // 连接根本没建起来，没有状态码。
    else if (error.statusCode === 401 || error.statusCode === 403) error.kind = 'auth'
    else if (error.statusCode === 429) error.kind = 'limit'
    else if (error.statusCode === 408) error.kind = 'timeout'
    else if (error.statusCode >= 500) error.kind = 'server'
    else if (error.statusCode >= 400) error.kind = 'request'     // 4xx 里的参数、格式、鉴权之外的问题。
    else error.kind = 'unknown'                                  // 服务说成功（2xx）但回答对不上格式：不是调用方传错了，不能贴成 request。
    if (error.kind === 'timeout' && error.isRetryable === undefined) error.isRetryable = true // 超时是瞬时故障，交给 Retry 决定。
    return error
}


// --- 发出一次模型请求 ---
// 模型的来源在入口决定；来源确定后，同一份 input 供流式和非流式请求使用。
// 本函数是公开接口，也是外部模型响应进入 Agent 的边界，因此只在这里判定请求是否失败。
const chat = async ({
    baseURL,              // 模型服务地址；传模型实例时不用给。
    apiKey,               // 鉴权密钥；传模型实例时不用给。
    model,                // 模型名称，或调用方创建的 AI SDK 模型实例。
    protocol = 'chat',    // chat / responses / anthropic / gemini。
    system,               // 系统提示词；也可以放进 messages 里的 system 消息。
    messages,             // 要发给模型的完整消息，必填。
    tools,                // 工具描述表；没有工具就不下发。
    toolChoice = 'auto',  // 工具选择策略；provider 里可以覆盖。
    toolMode = 'native',  // 默认零注入：只用原生工具字段。'text'（模拟工具）或 'auto'（兼容降级）才会把工具说明注入 system。
    stream = true,        // 是否流式；两条路最终返回同一种结果。
    cache = true,         // 提示词缓存；四协议默认开启，false 完全关闭，或传 { key, retention, body }。
    capabilities = {},    // 模型能力开关；关闭后对应的字段不下发。
    mediaFallback = 'error', // 模型不支持媒体时报错，还是只保留文字。
    requestTimeout,       // 单笔请求限时（毫秒）；不设就不限时。
    onLLMEvent,           // 流式事件回调。
    onLLMStart,           // 每次真实请求前回调，重试也算一次。
    onRetry,              // 重试通知回调。
    retryMaxDelay,        // 重试退避上限（毫秒）。
    retryMaxElapsed,      // 重试总时长上限（毫秒）。
    signal,               // 取消信号。
    provider = {},        // AI SDK 生成参数整包，headers / body 单独取出来。
}) => {
    // --- 检查输入 ---
    if (!model || !Array.isArray(messages) || (typeof model === 'string' && !baseURL)) throw new TypeError('model and messages are required; string models also need baseURL') // 模型实例自带连接，模型名才需要地址。

    // --- 从 messages 中取出系统提示词，并在出门前把消息整理成供应商要的样子 ---
    // 这一遍只管"长什么样"：去掉内部字段、把旧 image/audio/video 转成 file、按能力开关摘掉思考。
    // 它不管"该不该发"——挑哪些回合、丢掉没人应答的调用由 Context.build 决定。
    // 但这里必须自己算出"哪些调用有结果"：History.model 会摘掉没人应答的调用，
    // 如果传一个空名单进去，它会连有结果的调用一起摘掉、只留下结果，真实中转站要求两者必须配对，会直接 400。
    const systemMessage = messages.find(message => message.role === 'system') // Context 可能已经把 system 放进 messages。
    const answered = History.answeredCalls(messages)                          // 哪些工具调用已经拿到结果，由 History 统一判断。
    const prepare = message => History.model(message, { answered, capabilities, reasoning: capabilities.reasoning ?? false, mediaFallback, normalizeMedia: true })
    const modelMessages = messages.filter(message => message.role !== 'system').map(prepare) // AI SDK 的 system 单独传入，不重复放进消息列表。
    system ||= systemMessage?.content // 调用方单独传入的 system 优先级更高。

    // --- 能力开关：决定哪些字段根本不发给这个模型 ---
    const { headers, body: bodyOverrides = {}, ...call } = provider // headers / body 是连接参数，其余生成参数直接交给 AI SDK。
    // 已创建的模型无法再更换内部 fetch：默认的 cache:true 对实例安静跳过，只有调用方明确写了缓存对象或 body 才报错。
    if (typeof model !== 'string' && (typeof cache === 'object' && cache || Object.keys(bodyOverrides).length)) throw new TypeError('cache options and provider.body require a string model; configure custom models when creating them')
    if (typeof model !== 'string') cache = false // 实例的连接由创建者负责，这个包不往里补缓存字段。
    const sendTools = capabilities.tools !== false
    const sendOutput = capabilities.structuredOutput !== false
    const sendToolChoice = capabilities.toolChoice !== false
    const generation = sendOutput ? call : Object.fromEntries(Object.entries(call).filter(([name]) => name !== 'output')) // 不支持结构化输出的渠道不收到 response_format。

    // --- 决定模型来源：模型实例直接用，模型名才由这个包创建连接 ---
    let providerModel = model // 调用方传入的 AI SDK 模型实例，原样使用。
    if (typeof model === 'string') providerModel = connect({ baseURL, apiKey, model, protocol, system, headers, cache, bodyOverrides, generation })
    if (typeof providerModel === 'string') throw new Error(`Unsupported protocol: ${protocol}`) // 协议拼错时立即报错，不把模型名当实例传下去。

    // --- 组织一次统一的 AI SDK 请求 ---
    // maxRetries: 0 —— 重试在这个项目里只有 Retry 一个实现。交给 AI SDK 自己重试会导致
    // 一次 onLLMStart 对应服务端三次请求，而且原始错误会被包成 AI_RetryError，Retry 认不出来。
    // generation 是 provider 去掉 headers 和 body 之后的整份生成参数，原样展开，这里不逐个列字段。
    // 工具走哪条路由 toolMode 决定：native 用接口字段，text 把工具写进 system、让模型用文字调用。
    const hasTools = Boolean(tools && sendTools && Object.keys(tools).length)
    const memory = memoryKey({ model, protocol, baseURL })
    const textOnly = hasTools && (toolMode === 'text' || (toolMode === 'auto' && noNativeTools.has(memory)))

    const build = async text => {
        const spec = text ? await TextTools.prepare(tools) : null
        const baseSystem = spec ? [system, spec.instructions].filter(Boolean).join('\n\n') : system
        const baseMessages = spec ? TextTools.downgrade(modelMessages) : modelMessages
        // Anthropic 不自动缓存，必须在内容块上打 cache_control 断点，所以只有这一条协议要改写消息。
        const requestMessages = cache && protocol === 'anthropic' && baseMessages.length ? [...baseMessages.slice(0, -1), markLast(baseMessages.at(-1))] : baseMessages
        const requestSystem = cache && protocol === 'anthropic' && baseSystem ? mark({ role: 'system', content: baseSystem }) : baseSystem
        const input = { ...generation, model: providerModel, system: requestSystem, messages: requestMessages, abortSignal: signal, maxRetries: 0 } // 生成参数可扩展，但不能覆盖 Agent 的上下文和重试控制。
        if (typeof model !== 'string' && headers) input.headers = headers // 已创建的模型按 AI SDK 请求级参数发送额外请求头。
        if (hasTools && !text) {
            input.tools = tools
            if (sendToolChoice) input.toolChoice = call.toolChoice ?? toolChoice // provider 是 AI SDK 参数的归属地；兼容开关可完全省略这个字段。
        } else delete input.toolChoice // 没工具时单独发 toolChoice 会被部分服务拒收。
        return { input, spec }
    }

    // --- 发一轮（含重试）；text 决定这一轮用不用文字工具协议 ---
    const run = async text => {
        const { input, spec } = await build(text)
        let attempt = null // 本笔请求的限时信号；label 靠它区分"限时到点"和"用户取消"。
        const once = () => request({ input, stream, requestTimeout, markAttempt: timeout => { attempt = timeout }, onLLMEvent }) // 流式和非流式在 request 里分叉，对外表现一致。

        // 重试包在这里，而不是让每个调用方各自包一层：这样"发一次模型请求"在整个项目里只有一条路，
        // 主循环和上下文压缩自动走同一套重试、同一套退避、同一个 onRetry 通知。
        const result = await Retry.run({
            operation: async () => {
                await onLLMStart?.({ messages, tools }) // 每一次真实请求都通知一次；重试也是真实请求。
                try { return await once() }
                catch (error) { throw label(error, attempt) } // 分类只在这里做一次，流式和非流式共用同一个出口。
            },
            signal, onRetry, maxDelay: retryMaxDelay, maxElapsed: retryMaxElapsed,
        })

        // 文字模式：工具调用只可能在文字里。auto 下原生没给调用：模型可能把调用写成了文字，也读一遍。
        if (text) return adopt(result, TextTools.parse(result.text, spec, { loose: true }))
        if (toolMode === 'auto' && hasTools && !result.toolCalls?.length) {
            const recovered = TextTools.parse(result.text, await TextTools.prepare(tools))
            if (recovered.calls.length) return adopt(result, recovered)
        }
        return result
    }

    if (textOnly) return run(true)
    try { return await run(false) }
    catch (error) {
        // auto：接口拒收工具字段时（不支持原生工具的纯对话模型），记住这个模型，改用文字协议再发一次。
        if (toolMode !== 'auto' || !hasTools || signal?.aborted || !rejectsTools(error)) throw error
        noNativeTools.add(memory)
        return run(true)
    }
}


// --- auto 模式记住"这个模型不支持原生工具"，同一模型后续请求直接走文字协议，不再撞墙 ---
const noNativeTools = new Set()
const memoryKey = ({ model, protocol, baseURL }) => typeof model === 'string' ? `${protocol}:${baseURL}:${model}` : `instance:${model.provider}:${model.modelId}`

// 4xx 是"请求本身被拒"；5xx 只有在错误信息明确提到工具时才算——部分网关对不认识的字段报 500。
const rejectsTools = error => error?.kind === 'request' || (error?.kind === 'server' && /tool|function/i.test(`${error.message} ${error.responseBody ?? ''}`))


// --- 把文字里读回的工具调用，改写成和原生调用完全一样的结果形状 ---
// 历史里存的是标准 tool-call 块，Loop / Context / 下一轮无论走哪种协议都认得。
const adopt = (result, parsed) => {
    if (!parsed.calls.length) return result // 没读到调用就是普通回答，原样返回，不动它。
    const toolCalls = parsed.calls.map(one => ({
        type: 'tool-call',
        toolCallId: TextTools.newCallId(),
        toolName: one.toolName ?? 'invalid_tool_call', // 坏块读不出名字时也要有名字，否则历史块不合法。
        input: one.input ?? {},
        ...(one.invalid ? { invalid: true, error: one.error } : {}),
    }))

    // 只替换 assistant 里的文字块，思考等其他块原样保留。
    const assistant = [...result.responseMessages].reverse().find(message => message.role === 'assistant')
    const kept = assistant ? (Array.isArray(assistant.content) ? assistant.content : []).filter(part => part.type !== 'text' && part.type !== 'tool-call') : []
    const content = [...kept, ...(parsed.text ? [{ type: 'text', text: parsed.text }] : []), ...toolCalls.map(({ invalid, error, ...part }) => part)]
    const responseMessages = [...result.responseMessages.filter(message => message !== assistant), { role: 'assistant', content }]

    return { ...result, text: parsed.text, toolCalls, responseMessages, finishReason: toolCalls.length ? 'tool-calls' : result.finishReason }
}

export default { chat }
