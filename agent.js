/* 参数分四组，规则只有一条：谁的东西就归谁，这个包不替上游保管参数。

// 1. 连接：怎么找到模型。必填，没有默认值。
baseURL, apiKey, model, protocol

// 2. provider：AI SDK 的生成参数，整包原样透传。
//    这个包不认识里面任何一个字段，上游加新参数时这里一行都不用改。
provider: { temperature, topP, topK, maxOutputTokens, stopSequences, seed, toolChoice, providerOptions, headers, body }
// 只有 headers 和 body 是连接层的东西（额外请求头、并进请求体的字段），其余全交给 AI SDK。

// 3. system：人给这台 Agent 的身份。它不属于模型参数，是这个包要往上下文里放的东西。

// 4. Agent 的策略：这个包自己的旋钮，和模型无关。
maxTokens, compactThreshold, maxToolOutput, maxToolConcurrency, retryMaxDelay, retryMaxElapsed, noToolPrompt, stream, cache
maxTokens 和 provider.maxOutputTokens 名字像但是两回事：前者是这个包的上下文预算（超了就压缩），
后者是"这次最多生成多少 token"。改其中一个不会影响另一个。

// 先扫描工具目录，得到一份独立的工具集合。
const tools = await Agent.tool.scan("./tools")
// tools.schema   → 给 LLM 的工具描述
// tools.handlers → 给执行器的工具处理表

// 创建一个独立 Agent。参数会成为 Agent 的公开内部状态。
const agent = Agent.create({
    history: [],
    config: {
        baseURL: "https://api.example.com/v1",
        apiKey: "sk-xxx",
        model: "model-name",
        protocol: "chat",
        system: "你是一个编程助手。",
        provider: { temperature: 0.3 },   // 要改模型参数就写在这里，不写就用模型自己的默认值
    },
    tools,        // Agent.tool.scan() 的返回值，直接整份传进来
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

// 手动压缩历史；默认沿用 callbacks.onCompact / callbacks.onRetry。
const summary = await agent.compact()
await agent.compact({ onCompact: event => console.log(event) }) // 本次覆盖默认回调。

// 直接使用底层 LLM，无需再单独引入。
const result = await Agent.llm.chat({ baseURL, apiKey, model, messages })

// callbacks 中可使用下面这些回调：
// onStart: () => {}，循环开始时调用，无返回值。
// onLLMStart: ({ messages, tools }) => {}，每次实际请求模型前调用。
// onLLMFinish: result => {}，模型请求完成时调用，result 是 LLM.chat 返回的完整结果。
// onPermission: ({ sessionId, toolCallId, toolName, arguments }) => true | false，需要等待时可以返回 Promise。
// onLLMEvent: event => {}，原样收到 AI SDK 流中的每个事件。
// onRetry: info => {}，模型请求重试时调用，info 是重试信息。
// onToolCall: call => {}，模型请求调用工具时调用，call 包含 toolCallId、toolName、input。
// onToolOutput: output => {}，工具产生实时输出时调用，output 包含工具调用信息和输出数据。
// onToolResult: result => {}，工具执行结束时调用，result 包含工具调用信息和最终结果。
// onCompact: event => {}，接收 compact-start、所有 AI SDK 原生事件和 compact-finish。
*/

import { nanoid } from 'nanoid'
import Context from './features/context.js'   // 负责把历史消息裁剪成模型上下文
import Compact from './features/compact.js'   // 负责把上下文压缩成总结文本
import Loop from './features/loop.js'         // 负责驱动"请求模型 → 执行工具"的主循环
import Tool from './features/tool.js'         // 负责扫描和执行工具文件
import LLM from './utils/llm.js'              // 底层模型请求封装，也暴露给调用方直接使用
import History from './utils/history.js'      // 负责创建标准格式的历史消息块
import { version } from './package.json'      // 版本号只在 package.json 里写一次，打包时会被内联进产物


// --- 内部工具：构建模型和循环共用的参数 ---
// system 已由 Context 折进消息（包括压缩总结），不能再单独传给 LLM 覆盖它。
const buildLLM = config => ({
    baseURL: config.baseURL,                    // 模型服务地址
    apiKey: config.apiKey,                      // 鉴权密钥
    model: config.model,                        // 模型名称
    protocol: config.protocol,                  // 调用协议
    cache: config.cache,                        // 是否发送 OpenAI 提示词缓存字段
    provider: config.provider,                  // 生成参数整包转发给 AI SDK，这个包不逐个列字段
    retryMaxDelay: config.retryMaxDelay,        // 重试退避上限（秒）。重试是 LLM.chat 自带的，压缩那次请求也走同一套
    retryMaxElapsed: config.retryMaxElapsed,    // 一直失败最多再试多久（秒），到点把错误交给上层
    maxTokens: config.maxTokens,                // 上下文 Token 上限，压缩阈值判断和裁剪预算都用它
    compactThreshold: config.compactThreshold,  // 触发自动压缩的比例
    noToolPrompt: config.noToolPrompt,          // 临时提示文本
    stream: config.stream,                      // 是否流式输出
})


// 创建一台独立 Agent：传入的对象会成为这台机器公开、可继续修改的内部状态。
const create = ({ id = nanoid(), history = [], config = {}, tools = { schema: {}, handlers: {} }, callbacks = {} } = {}) => {
    const agent = {
        id,       // Agent 的身份只用于区分实例和权限等待。
        history,  // 直接保存外部传入的数组，外部可以和 Agent 共同修改它。
        config: {
            baseURL: '',            // 没有模型地址时，真正发送请求才会报错。
            apiKey: '',             // 密钥只在模型请求时使用，不参与 Agent 流程判断。
            model: '',              // 模型名称没有默认值，避免静默选择错误模型。
            protocol: 'chat',       // 大多数兼容 OpenAI Chat 的服务使用这个协议。
            provider: {},           // AI SDK 的生成参数整包转发，默认一个都不设——替调用者的模型默认 temperature 是在猜他的模型。
            cache: false,           // prompt_cache_key 是 OpenAI 私有字段，中转站大多不认，默认不发。
            maxToolOutput: 32000,   // 单次工具输出上限（字符）。不设限时一个 cat 大日志的工具就能把会话撑死：实测 1MB 输出 = 31 万 token。
            maxToolConcurrency: 8,  // 同时最多跑几个工具，超出的排队。阻塞型工具会长期占着名额，会话多时要调大。
            maxTokens: 120000,      // 上下文 Token 上限，超过就压缩。默认值按主流模型的最小窗口（约 128k）取，用别的模型请按实际窗口改。
            compactThreshold: 0.8,  // 接近上限时提前压缩，默认在 80% 处开始。
            retryMaxDelay: 60,      // 重试退避时间上限（秒），防止单次等待过长。
            retryMaxElapsed: 300,   // 一直失败最多再试多久（秒）。不设头的话服务挂一整天 send() 也不返回，上层连出事了都不知道。
            noToolPrompt: '[错误] 你刚才的响应中没有使用工具！请继续使用工具（这是一条系统提醒消息，请勿以对话形式回复）', // 模型连续 2 轮不调工具时的临时提示。
            stream: true,           // 主循环和压缩请求都使用流式输出。
            system: '',             // 没有系统提示词时仍允许 Agent 运行。
            ...config,              // 传入配置覆盖默认配置，且配置结构只包含 Agent 需要的字段。
            provider: { ...config.provider }, // 单独浅拷一层：两个 Agent 共用一个 provider 对象时，改其中一个不该动到另一个。
        },
        tools,                       // Agent.tool.scan() 的返回值：{ schema, handlers }，后续 send 可以整份替换。
        callbacks: { ...callbacks }, // 回调逐项保存，后续 send 只覆盖传入的回调。
        running: null,               // null 表示空闲；运行对象保存当前停止控制器和任务。
    }


    // 发送指令：更新本次传入的持久参数，登记运行状态，然后启动新任务。
    // 输入既可以是一句话，也可以是 AI SDK 风格的内容块数组（发图片、发文件走数组这条路）。
    // send('你好') 和 send({ input: '你好' }) 是同一件事——只有一句话时不该逼调用者写一个对象。
    agent.send = (input, options = {}) => {
        if (typeof input === 'object' && input !== null && !Array.isArray(input)) ({ input, ...options } = input) // 传对象就是完整形式，传字符串或数组就是纯输入。

        const empty = typeof input === 'string' ? !input.trim() : !Array.isArray(input) || !input.length
        if (empty) throw new TypeError('input must be a non-empty string or a non-empty content array') // 没有本次输入就没有可执行指令。
        if ('history' in options) agent.history = options.history                                           // 传入空数组也代表明确覆盖历史。
        if ('config' in options) agent.config = { ...agent.config, ...options.config, provider: 'provider' in options.config ? { ...options.config.provider } : agent.config.provider } // provider 整包替换，复制一层避免外部改动串到 Agent。
        if ('tools' in options) agent.tools = options.tools                                                 // 工具是整体替换，不在 Agent 内部猜测如何合并。
        if ('callbacks' in options) agent.callbacks = { ...agent.callbacks, ...options.callbacks }         // 回调逐项合并，避免替换一个回调时清掉其他回调。

        const previous = agent.running                              // 同步取走上一次运行，本函数末尾就把它顶替掉。
        const controller = new AbortController()                    // stop() 通过它中断当前模型请求或工具。

        // 停旧任务挪进 task 内部，所以 send 从头到尾一个 await 都没有：
        // 同一个 tick 里连发两次 send，第二次必定看得见第一次登记的运行状态并把它停掉，
        // 不会出现两个 Loop 同时往同一份 history 里写。
        const task = (async () => {
            if (previous) {                                         // 上一次还在跑：先停掉它，再开始这一次。
                previous.controller.abort()
                await previous.task.catch(() => {})                 // 旧任务以 AbortError 结束是正常的，不当成新异常。
            }
            agent.history.push(History.user({ content: input }))   // 等旧任务把它的收尾消息写完再写新指令，history 的顺序才和实际发生的顺序一致。
            return Loop.run({
                history: agent.history,           // Loop 直接使用这份公开数组，执行结果也会继续写入这里。
                system: agent.config.system,      // 系统提示词本轮不变，直接取当前配置。
                tools: agent.tools.schema,        // Loop 只需要给模型看的工具描述。
                llm: buildLLM(agent.config),      // 统一从配置构建，两处使用完全一致。
                buildContext: Context.build,      // 上下文构建交给 Context 模块。
                compact: Compact.run,             // 压缩交给 Compact 模块。
                executeTool: request => Tool.execute({ ...request, handlers: agent.tools.handlers, limit: agent.config.maxToolOutput, concurrency: agent.config.maxToolConcurrency }), // 执行器需要的处理表、输出上限和并发上限由 Agent 补上，Loop 不用知道它们。
                sessionId: agent.id,             // 会话 ID 用于权限询问时区分实例。
                signal: controller.signal,        // 取消信号，stop() 触发时 Loop 立即响应。
                ...agent.callbacks,               // 所有回调一次展开，新增回调类型时这里不用改。
            })
        })()

        // running 一次构造完整，stop() 拿到的永远是可用的运行对象，不存在"task 还没补上"的中间态。
        agent.running = { controller, task }
        task.finally(() => {
            if (agent.running?.task === task) agent.running = null // 只清理自己的任务，避免覆盖后续运行状态。
        }).catch(() => {})
        return task
    }


    // 停止指令：只操作当前 Agent 自己的控制器。
    agent.stop = async () => {
        if (!agent.running) return { ok: false }           // 空闲 Agent 没有需要停止的任务。
        const running = agent.running                      // 保存当前运行对象，避免等待期间状态被其他逻辑替换。
        running.controller.abort()                         // 让 Loop、LLM 和工具进程看到取消信号。
        await running.task.catch(() => {})                 // 等待当前任务结束，但不把停止异常变成新的异常。
        if (agent.running === running) agent.running = null // 任务已结束后由 stop 直接清空状态，不依赖 finally 的微任务时序；等待期间来了新任务就不动它。
        return { ok: true }
    }


    // 手动压缩：先停掉当前任务，再立即压缩当前上下文。
    // 登记运行状态的方式和 send 完全一致（同步顶替、停旧任务放进 task 内部），
    // 所以 compact 和 send 抢跑时，后来的那个必定看得见先来的并把它停掉，不会互相把运行状态覆盖掉。
    agent.compact = ({ onCompact = agent.callbacks.onCompact, onRetry = agent.callbacks.onRetry, ...options } = {}) => {
        const previous = agent.running            // 同步取走上一次运行。
        const controller = new AbortController()  // stop() 也可以中断手动压缩。

        const task = (async () => {
            if (previous) {                       // 用户主动压缩时，先结束正在进行的 send 或压缩。
                previous.controller.abort()
                await previous.task.catch(() => {})
            }
            const context = Context.build({ history: agent.history, system: agent.config.system, tools: agent.tools.schema })
            const content = await Compact.run({
                ...options,
                messages: context.messages,       // 把裁剪后的上下文交给 Compact。
                llm: buildLLM(agent.config),      // 与 send 共用同一个构建函数，保证一致性。
                stream: agent.config.stream,      // 压缩使用与 Agent 相同的流式配置。
                onCompact,                         // 单次回调优先，否则沿用 Agent 的默认回调。
                onRetry,                           // 手动压缩和自动压缩走同一套重试通知。
                signal: controller.signal,
            })
            agent.history.push(History.compact({ content }))  // 总结文本写回公开历史。
            return content
        })()

        agent.running = { controller, task }      // 手动压缩和 send 共用同一个运行状态。
        task.finally(() => {
            if (agent.running?.task === task) agent.running = null // 只清理自己的任务，避免覆盖后续运行状态。
        }).catch(() => {})
        return task
    }

    return agent
}


// 导出时附带全部常用模块。这个包会被打包成单文件嵌进别的项目，那时 default 导出就是唯一的入口——
// 凡是嵌入方需要的东西都必须挂在这里，否则在打包产物里根本够不着。
const Agent = {
    version,          // 包版本，来自 package.json；排查问题时上层要能报出来
    create,           // 创建 Agent 实例
    tool: Tool,       // 工具扫描和执行：Agent.tool.scan() / Agent.tool.execute()
    history: History, // 造标准历史消息块：Agent.history.user() / assistant() / tool() / compact()
    context: Context, // 上下文构建：Agent.context.build()
    compact: Compact, // 生成压缩总结：Agent.compact.run()
    llm: LLM,         // 底层模型请求：Agent.llm.chat()
}

export default Agent
