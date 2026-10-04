/* 包入口：import Agent from '@kernel4632/agent-core'。所有能力都挂在 Agent 上，这个文件负责把各个功能组合起来。

参数分四组，规则只有一条：谁的东西就归谁，这个包不替上游保管参数。

// 1. 连接：怎么找到模型。必填，没有默认值。
baseURL, apiKey, model, protocol

// 2. provider：AI SDK 的生成参数，整包原样透传。
//    这个包不认识里面任何一个字段，上游加新参数时这里一行都不用改。
provider: { temperature, topP, topK, maxOutputTokens, stopSequences, seed, toolChoice, providerOptions, headers, body }
// 只有 headers 和 body 是连接层的东西（额外请求头、并进请求体的字段），其余全交给 AI SDK。

// 3. system：人给这台 Agent 的身份。它不属于模型参数，是这个包要往上下文里放的东西。

// 4. Agent 的策略：这个包自己的旋钮，和模型无关。
maxTokens?, compactThreshold, maxSteps?, maxToolOutput?, maxToolConcurrency?, retryMaxDelay?, retryMaxElapsed?, noToolPrompt?, requestTimeout?, noToolRounds?, stream, cache, toolMode, capabilities, mediaFallback, compact?, output?
// toolMode: 'native'（默认）只用原生工具，system 一个字节都不动；接不支持原生工具的模型时主动开 'text' 或 'auto'。
//            'text' 是「模拟工具」开关：不发 tools，把工具说明注入 system，调用从文字里读。
//            'auto' 是兼容开关：原生优先，被拒收时才降级注入 system（因此不是默认值）。
// capabilities: { image, audio, video, file, tools, structuredOutput, toolChoice, reasoning }
// mediaFallback: 'error'（默认）或 'strip'；关闭某种媒体后，strip 会保留文字并丢掉媒体块。
// requestTimeout: 单笔模型请求最多等多久（毫秒）；不设就不限时，卡住的请求会一直等。
// noToolRounds: 有工具时连续多少轮不调工具就结束（默认 3，第 2 轮插入 noToolPrompt 提醒）；设成 Infinity 就永不因不调工具结束。
// output: 结构化输出格式，如 Agent.output.object({ schema: Agent.schema.object({...}) })；返回值里读 output。
//         写在配置顶层（它回答"要什么形状的结果"），底层会并进 provider 交给 AI SDK。
// compact: 压缩单独用一套模型时写在这里，比如 { model: '便宜的小模型' }；也能换 baseURL / apiKey。
//              不写就和主模型共用；自动压缩和手动 compact() 都用它。
// 带 ? 的策略默认不限制；只有调用方主动填写才会启用对应保护。
maxTokens 和 provider.maxOutputTokens 名字像但是两回事：前者是这个包的上下文预算（超了就压缩），
后者是"这次最多生成多少 token"。改其中一个不会影响另一个。

// 工具的来源可以任意搭配，一行拼装交给 Tool.from：
//
//     const tools = await Agent.tool.from(
//         "./tools",              // 目录：里面的文件工具跑在子进程里，崩了不影响 Agent
//         mcpClient.tools(),      // 内存工具：AI SDK / MCP 客户端给的工具对象，主进程直接调
//         { skill },              // record：自定义函数；也可以传数组 [{ name, ... }, ...]
//     )
//
// from 的参数可以是任意多个：目录（字符串 / URL）、工具对象数组、record、已装好的集合，或它们的 Promise。
// 只有一个来源时，也可以直接 await Agent.tool.scan("./tools") 或 Agent.tool.adopt(objects)。
// create 收已经装好的工具（同步，不扫目录）；send 收任意形状，目录会在发送时现扫。

// 创建一个独立 Agent。参数会成为 Agent 的公开内部状态。
const agent = Agent.create({
    history: [],
    config: {
        baseURL: "https://api.example.com/v1",
        apiKey: "sk-xxx",
        model: "model-name",        // 也可直接传 AI SDK 模型实例；实例已自带地址和协议
        protocol: "chat",
        system: "你是一个编程助手。",
        provider: { temperature: 0.3 },   // 要改模型参数就写在这里，不写就用模型自己的默认值
    },
    tools,        // from(...) / scan(...) / adopt(...) 的返回值
    callbacks: {},
})

// 发送消息。没有再次传入的参数继续使用 Agent 当前状态。
const answer = await agent.send('继续处理') // 只有一句话时直接传字符串；图片也可直接传内容块数组。
console.log(answer.text)            // 最后一轮模型生成的文字；answer.reason 是结束原因。
await agent.send({
    input: "帮我写个爬虫",
    callbacks: {
        onLLMEvent: event => console.log(event),
        onPermission: async permission => true,
        onCompact: event => console.log(event),
    },
})

// 发送时也可以覆盖内部参数。
await agent.send({
    input: "继续",
    history: anotherHistory,
    config: anotherConfig,
    callbacks: { onLLMEvent: event => console.log(event) },
})

// 停止当前运行。
await agent.stop()

// send 内部默认就是流式（config.stream 默认 true），await 拿到和流式一样的结果。
// 想实时拿到每一块：传 callbacks.onLLMEvent，模型每吐一段就调用一次。
// 网页要边生成边推送：在 onLLMEvent 里把内容写进你自己的响应流，见 README 的"网页实时推送"。
// 想要非流式的旧式请求：config.stream = false，这是唯一的兼容开关。

// 手动压缩历史；默认沿用 callbacks.onCompact / callbacks.onRetry。
const summary = await agent.compact()
await agent.compact({ onCompact: event => console.log(event) }) // 本次覆盖默认回调。

// 直接使用底层 LLM，无需再单独引入。
const result = await Agent.llm.chat({ baseURL, apiKey, model, messages })

// 要一个有固定格式的对象时，格式定义也从本包拿；返回值里直接读取 output。
// config.output = Agent.output.object({ schema: Agent.schema.object({ total: Agent.schema.number() }) })
// const { output } = await agent.send('计算总数')

// callbacks 中可使用下面这些回调：
// onPermission: ({ sessionId, toolCallId, toolName, arguments, signal }) => true | false，需要等待时可以返回 Promise。
//               它是唯一一个看返回值的回调；它抛错时这次 send 失败。
// 其余回调都只是通知：出错会被忽略，不影响任务（规则写在 utils/notify.js）。
// onStart: () => {}，循环开始时调用，无返回值。
// onLLMStart: ({ messages, tools }) => {}，每次实际请求模型前调用。
// onLLMFinish: result => {}，模型请求完成时调用，result 是 LLM.chat 返回的完整结果。
// onLLMEvent: event => {}，原样收到 AI SDK 流中的每个事件。
// onRetry: info => {}，模型请求重试时调用，info 是重试信息。
// onToolCall: call => {}，模型请求调用工具时调用，call 包含 toolCallId、toolName、input。
// onToolOutput: output => {}，工具产生实时输出时调用，output 包含工具调用信息和输出数据。
// onToolResult: result => {}，工具执行结束时调用，result 包含工具调用信息和最终结果。
// onStep: step => {}，一轮模型和工具完成后调用，step 包含 step、result、toolCalls、toolResults。
// onCompact: event => {}，接收 compact-start、所有 AI SDK 原生事件和 compact-finish。
*/

import { nanoid } from 'nanoid'
import { Output } from 'ai'                   // 输出格式直接复用本包的 AI SDK，不维护另一套 schema 协议。
import { z } from 'zod'                       // 调用方从 Agent.schema 获取格式定义，无需另装验证库。
import Context from './features/context.js'   // 负责把历史消息裁剪成模型上下文
import Compact from './features/compact.js'   // 负责把上下文压缩成总结文本
import Loop from './features/loop.js'         // 负责驱动"请求模型 → 执行工具"的主循环
import Tool from './features/tool.js'         // 负责扫描、接纳和执行工具
import LLM from './features/llm.js'           // 底层模型请求封装，也暴露给调用方直接使用
import TextTools from './features/text-tools.js' // 纯对话模型的文字工具协议，直接用 LLM.chat 时也能自己调
import History from './features/history.js'   // 负责创建标准格式的历史消息块
import { version } from './package.json'      // 版本号只在 package.json 里写一次，打包时会被内联进产物


// --- 模型和循环共用同一份配置，不再逐字段抄一遍 ---
const buildLLM = (config, overrides = {}) => {
    const { output, ...merged } = { ...config, ...overrides }
    return { ...merged, provider: { ...merged.provider, output }, system: undefined }
}


// --- 压缩用的模型配置 ---
const buildCompact = config => buildLLM(config, config.compact)


// --- 默认值只有这一处 ---
const DEFAULT_CAPABILITIES = { ...History.mediaDefaults, tools: true, structuredOutput: true, toolChoice: true, reasoning: false }
const DEFAULT_COMPACT_THRESHOLD = 0.8
const DEFAULT_NO_TOOL_ROUNDS = 3
const DEFAULT_NO_TOOL_PROMPT = '[错误] 你刚才的响应中没有使用工具！请继续使用工具（这是一条系统提醒消息，请勿以对话形式回复）'

// --- 开始一次运行：先停掉上一次，再做这一次的事 ---
const start = (agent, work, outside) => {
    if (outside !== undefined && !(outside instanceof AbortSignal)) return Promise.reject(new TypeError('signal must be an AbortSignal'))
    const previous = agent.running
    const controller = new AbortController()
    const signal = outside ? AbortSignal.any([controller.signal, outside]) : controller.signal

    const task = (async () => {
        if (previous) {
            previous.controller.abort()
            await previous.task.catch(() => {})
        }
        if (signal.aborted) throw new DOMException('Agent run aborted', 'AbortError')
        return work(signal)
    })()

    agent.running = { controller, task }
    task.finally(() => {
        if (agent.running?.task === task) agent.running = null
    }).catch(() => {})
    return task
}


// 创建一台独立 Agent。
// tools 接受 scan()/adopt() 的返回值、数组、record 或 null，内部自动归一化。
const create = ({ id = nanoid(), history = [], config = {}, tools = null, callbacks = {} } = {}) => {
    const agent = {
        id,
        history,
        config: {
            baseURL: '',
            apiKey: '',
            model: '',
            protocol: 'chat',
            provider: {},
            cache: true,
            mediaFallback: 'error',
            maxToolOutput: undefined,
            maxToolConcurrency: undefined,
            maxTokens: undefined,
            maxSteps: undefined,
            retryMaxDelay: undefined,
            retryMaxElapsed: undefined,
            requestTimeout: undefined,
            noToolPrompt: DEFAULT_NO_TOOL_PROMPT,
            compact: undefined,
            output: undefined,
            stream: true,
            toolMode: 'native',
            system: '',
            ...config,
            provider: { ...config.provider },
            capabilities: { ...DEFAULT_CAPABILITIES, ...config.capabilities },
            compactThreshold: config.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD,
            noToolRounds: config.noToolRounds ?? DEFAULT_NO_TOOL_ROUNDS,
        },
        tools: Tool.adopt(tools),    // 统一归一化：数组、record、{ schema,handlers }、null 都认。
        callbacks: { ...callbacks },
        running: null,
    }


    agent.send = (input, options = {}) => {
        if (typeof input === 'object' && input !== null && !Array.isArray(input)) ({ input, ...options } = input)

        const empty = typeof input === 'string' ? !input.trim() : !Array.isArray(input) || !input.length
        const badConfig = 'config' in options && (typeof options.config !== 'object' || options.config === null || Array.isArray(options.config))
        const limits = { ...agent.config, ...(badConfig ? {} : options.config ?? {}) }
        const positive = (value, finite = true) => value === undefined || (finite ? Number.isInteger(value) && value >= 1 : value === Infinity || Number.isInteger(value) && value >= 1)
        const invalid =
            empty ? new TypeError('input must be a non-empty string or a non-empty content array')
            : badConfig ? new TypeError('config must be an object')
            : !positive(limits.maxSteps) ? new RangeError('maxSteps must be a positive integer')
            : !positive(limits.maxTokens) ? new RangeError('maxTokens must be a positive integer') // 字符串 '1000' 会让压缩永远不触发，当场拦下。
            : !positive(limits.noToolRounds, false) ? new RangeError('noToolRounds must be a positive integer or Infinity')
            : !positive(limits.maxToolConcurrency, false) ? new RangeError('maxToolConcurrency must be a positive integer or Infinity')
            : !['native', 'text', 'auto'].includes(limits.toolMode) ? new TypeError("toolMode must be 'native', 'text' or 'auto'") // 拼错的 toolMode 会被默默当成 native，不如直接报错。
            : null
        if (invalid) return Promise.reject(invalid)

        return start(agent, async signal => {
            if ('history' in options) agent.history = options.history
            if ('config' in options) agent.config = { ...agent.config, ...options.config, provider: 'provider' in options.config ? { ...options.config.provider } : agent.config.provider, capabilities: 'capabilities' in options.config ? { ...agent.config.capabilities, ...options.config.capabilities } : agent.config.capabilities }
            if ('tools' in options) agent.tools = await Tool.from(options.tools) // send 是异步的，传来的目录会现扫；create 是同步的，只收已经装好的工具。
            if ('callbacks' in options) agent.callbacks = { ...agent.callbacks, ...options.callbacks }
            const callbacks = { ...agent.callbacks }

            agent.history.push(History.user({ content: input }))
            const compactLLM = buildCompact(agent.config)
            const tools = agent.tools  // 直接用归一化后的工具集合，无需再合并 MCP / skills。

            return Loop.run({
                history: agent.history,
                system: agent.config.system,
                tools: agent.config.capabilities.tools === false ? {} : tools.schema,
                llm: buildLLM(agent.config),
                buildContext: options => Context.build({ ...options, capabilities: agent.config.capabilities, mediaFallback: agent.config.mediaFallback }),
                compact: request => Compact.run({ ...request, llm: compactLLM, stream: compactLLM.stream }),
                executeTool: request => Tool.execute({ ...request, handlers: tools.handlers, limit: agent.config.maxToolOutput, concurrency: agent.config.maxToolConcurrency }),
                sessionId: agent.id,
                ...callbacks,
                signal,
            })
        }, options.signal)
    }


    agent.stop = async () => {
        if (!agent.running) return { ok: false }
        const running = agent.running
        running.controller.abort()
        await running.task.catch(() => {})
        if (agent.running === running) agent.running = null
        return { ok: true }
    }


    agent.compact = ({ onCompact = agent.callbacks.onCompact, onRetry = agent.callbacks.onRetry, ...options } = {}) => start(agent, async signal => {
        const context = Context.build({ history: agent.history, system: agent.config.system, tools: agent.tools.schema, capabilities: agent.config.capabilities, mediaFallback: agent.config.mediaFallback })
        const compactLLM = buildCompact(agent.config)
        const content = await Compact.run({
            ...options,
            messages: context.messages,
            llm: compactLLM,
            stream: compactLLM.stream,
            onCompact,
            onRetry,
            signal,
        })
        agent.history.push(History.compact({ content }))
        return content
    })

    return agent
}


const Agent = {
    version,
    create,
    tool: Tool,       // from / scan / adopt / execute / merge
    history: History,
    context: Context,
    compact: Compact,
    llm: LLM,
    textTools: TextTools,
    output: Output,
    schema: z,
}

export default Agent
