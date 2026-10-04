/* 包入口：import Agent from '@kernel4632/agent-core'。所有能力都挂在 Agent 上，这个文件把各功能组合起来。

    const agent = Agent.create({
        config: { baseURL, apiKey, model, system: '你是一个助手。' },
        tools,                              // Agent.tool.from(...) 的返回值
        callbacks: { onToolResult: r => console.log(r.toolName, r.output) },
    })
    const answer = await agent.send('帮我做件事')
    console.log(answer.text, answer.reason)

完整的配置项、回调、返回值，以及工具来源（文件 / 内存 / MCP / 技能）见 README 的「API 参考」和「接入 MCP 和技能」。
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
import { createMeter, modelKey } from './utils/tokens.js' // 本地 token 估算器：按模型记账，用真实 usage 自校准
import { version } from './package.json'      // 版本号只在 package.json 里写一次，打包时会被内联进产物


// --- 模型和循环共用同一份配置，不再逐字段抄一遍 ---
const buildLLM = (config, overrides = {}) => {
    const { output, ...merged } = { ...config, ...overrides }
    return { ...merged, provider: { ...merged.provider, output }, system: undefined }
}


// --- 压缩用的模型配置 ---
const buildCompact = config => buildLLM(config, config.compact)


// --- 默认值只有这一处 ---
const DEFAULT_CAPABILITIES = { ...History.mediaDefaults, tools: true, structuredOutput: true, toolChoice: true, reasoning: false, usage: true }
const DEFAULT_COMPACT_THRESHOLD = 0.8
const DEFAULT_MAX_TOKENS = 128000 // 默认上下文预算：不设也能在接近上限时自动压缩，避免把上下文撑爆。设 Infinity 关闭。
const DEFAULT_NO_TOOL_ROUNDS = 3
const DEFAULT_NO_TOOL_PROMPT = '[错误] 你刚才的响应中没有使用工具！请继续使用工具（这是一条系统提醒消息，请勿以对话形式回复）'

// --- 入口检查：被入口直接调用的指令只在这里查一次 ---
// 返回第一条不合法的问题（一个带原因的 Error），全都合法就返回 null。
const inputProblem = (input, limits) => {
    const empty = typeof input === 'string' ? !input.trim() : !Array.isArray(input) || !input.length
    const positive = (value, finite = true) => value === undefined || (finite ? Number.isInteger(value) && value >= 1 : value === Infinity || Number.isInteger(value) && value >= 1)
    if (empty) return new TypeError('input must be a non-empty string or a non-empty content array')
    if (!positive(limits.maxSteps)) return new RangeError('maxSteps must be a positive integer')
    if (!positive(limits.maxTokens, false)) return new RangeError('maxTokens must be a positive integer or Infinity') // 字符串 '1000' 会让压缩永远不触发。
    if (!positive(limits.noToolRounds, false)) return new RangeError('noToolRounds must be a positive integer or Infinity')
    if (!positive(limits.maxToolConcurrency, false)) return new RangeError('maxToolConcurrency must be a positive integer or Infinity')
    if (!positive(limits.maxToolOutput, false)) return new RangeError('maxToolOutput must be a positive integer or Infinity') // 0/负数会把工具输出静默截成空。
    if (!(typeof limits.compactThreshold === 'number' && Number.isFinite(limits.compactThreshold) && limits.compactThreshold > 0 && limits.compactThreshold <= 1)) return new RangeError('compactThreshold must be a number in (0, 1]')
    if (!['native', 'text', 'auto'].includes(limits.toolMode)) return new TypeError("toolMode must be 'native', 'text' or 'auto'") // 拼错的 toolMode 会被默默当成 native。
    return null
}

// --- 一次 send 传入的 config 合并进 Agent 当前配置 ---
// provider 整份替换（调用方给了就整份用它的）；capabilities 和 compact 按字段叠加（它们是嵌套配置，
// 只传其中一项不该把另一项丢掉）。其余字段覆盖。
const mergeConfig = (current, override) => ({
    ...current,
    ...override,
    provider: 'provider' in override ? { ...override.provider } : current.provider,
    capabilities: 'capabilities' in override ? { ...current.capabilities, ...override.capabilities } : current.capabilities,
    compact: 'compact' in override ? { ...current.compact, ...override.compact } : current.compact,
})


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
        if (signal.aborted) throw Object.assign(new DOMException('Agent run aborted', 'AbortError'), { kind: 'aborted' }) // 取消也带 kind，和模型错误一致。
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
    const meter = createMeter()   // 这台 Agent 的 token 估算器：按模型自校准，跨 send 复用。放闭包里，不进公开状态。
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
            maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS, // 默认开启自动压缩；想关掉设 maxTokens: Infinity。
            compactThreshold: config.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD,
            noToolRounds: config.noToolRounds ?? DEFAULT_NO_TOOL_ROUNDS,
        },
        tools: Tool.adopt(tools),    // 统一归一化：数组、record、{ schema,handlers }、null 都认。
        callbacks: { ...callbacks },
        running: null,
    }


    agent.send = (input, options = {}) => {
        if (typeof input === 'object' && input !== null && !Array.isArray(input)) ({ input, ...options } = input)

        const badConfig = 'config' in options && (typeof options.config !== 'object' || options.config === null || Array.isArray(options.config))
        const badHistory = 'history' in options && !Array.isArray(options.history) // 覆盖会写回 Agent，坏值必须先挡在门外，否则这台 Agent 之后每次 send 都崩。
        const badCallbacks = 'callbacks' in options && (typeof options.callbacks !== 'object' || options.callbacks === null || Array.isArray(options.callbacks))
        const limits = { ...agent.config, ...(badConfig ? {} : options.config ?? {}) }
        const invalid =
            badConfig ? new TypeError('config must be an object')
            : badHistory ? new TypeError('history must be an array')
            : badCallbacks ? new TypeError('callbacks must be an object')
            : inputProblem(input, limits)
        if (invalid) return Promise.reject(invalid)

        return start(agent, async signal => {
            if ('history' in options) agent.history = options.history
            if ('config' in options) agent.config = mergeConfig(agent.config, options.config)
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
                meter,                            // token 估算器：跨 send 复用，按模型记住自校准的比例。
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
        const context = Context.build({ history: agent.history, system: agent.config.system, tools: agent.config.capabilities.tools === false ? {} : agent.tools.schema, ratio: meter.ratio(modelKey(agent.config)), capabilities: agent.config.capabilities, mediaFallback: agent.config.mediaFallback }) // 工具表和 send 保持一致：关掉工具能力时这里也不带。
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
    }, options.signal) // 手动压缩也接受外部取消信号，和 send 一致。

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
