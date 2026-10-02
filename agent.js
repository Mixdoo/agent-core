/* 参数分四组，规则只有一条：谁的东西就归谁，这个包不替上游保管参数。

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
// noToolRounds: 连续多少轮不调工具就结束（默认 1，即模型不调工具就算答完）；调大可让模型多坚持几轮，设成 Infinity 就永不因不调工具结束。
// output: 结构化输出格式，如 Agent.output.object({ schema: Agent.schema.object({...}) })；返回值里读 output。
//         写在配置顶层（它回答"要什么形状的结果"），底层会并进 provider 交给 AI SDK。
// compact: 压缩单独用一套模型时写在这里，比如 { model: '便宜的小模型' }；也能换 baseURL / apiKey。
//          不写就和主模型共用；自动压缩和手动 compact() 都用它。
// 带 ? 的策略默认不限制；只有调用方主动填写才会启用对应保护。
maxTokens 和 provider.maxOutputTokens 名字像但是两回事：前者是这个包的上下文预算（超了就压缩），
后者是"这次最多生成多少 token"。改其中一个不会影响另一个。

// 先扫描工具目录，得到一份独立的工具集合。
const tools = await Agent.tool.scan("./tools")
// tools.schema   → 给 LLM 的工具描述
// tools.handlers → 给执行器的工具处理表

// 技能是可选的：每个技能一个文件夹、里面一份 SKILL.md。不传 skills 就零注入。
// 扫到了才会往 system 追加一段技能列表、挂上内置的 skill 工具；目录是空的也一样零注入。
const skills = await Agent.skill.scan("./skills")

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
    tools,        // Agent.tool.scan() 的返回值，直接整份传进来
    skills,       // 可选：Agent.skill.scan() 的返回值
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
// onStart: () => {}，循环开始时调用，无返回值。
// onLLMStart: ({ messages, tools }) => {}，每次实际请求模型前调用。
// onLLMFinish: result => {}，模型请求完成时调用，result 是 LLM.chat 返回的完整结果。
// onPermission: ({ sessionId, toolCallId, toolName, arguments }) => true | false，需要等待时可以返回 Promise。
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
import Tool from './features/tool.js'         // 负责扫描和执行工具文件
import Skill from './features/skill.js'       // 负责扫描技能目录并按需加载技能
import LLM from './utils/llm.js'              // 底层模型请求封装，也暴露给调用方直接使用
import History from './utils/history.js'      // 负责创建标准格式的历史消息块
import { version } from './package.json'      // 版本号只在 package.json 里写一次，打包时会被内联进产物


// --- 模型和循环共用同一份配置，不再逐字段抄一遍 ---
// 逐字段抄的写法每加一个配置项就要多改一处，改了这里忘了那里就会静默丢参数。
// overrides 是给压缩留的覆盖层：压缩想换便宜模型时，只覆盖它写了的字段。
// system 要挡掉：它已经被 Context 折进消息（包括压缩总结），再单独传给模型会盖掉那份消息。
// output 回答"要什么形状的结果"，是这个包自己的配置，并进 provider 交给 AI SDK；并进之后顶层不再留它。
// 其余字段原样传下去，LLM.chat 只取自己认识的，不认识的（比如 maxToolOutput）自然被忽略。
const buildLLM = (config, overrides = {}) => {
    const { output, ...merged } = { ...config, ...overrides }
    return { ...merged, provider: { ...merged.provider, output }, system: undefined }
}


// --- 压缩用的模型配置：和主模型同源，config.compact 里写什么就覆盖什么 ---
// 常见用法是换一个更便宜的小模型做总结：compact: { model: 'gpt-4o-mini' }
// baseURL、apiKey、protocol 也能一起换，所以压缩完全可以走另一家供应商。
const buildCompact = config => buildLLM(config, config.compact)


// --- 默认值只有这一处，改一次就够 ---
// 这些值会随配置一起交给 Loop，所以 Loop 里不再写第二份"没传就用这个"，避免改一处漏一处。
// capabilities 里媒体那几项的默认值由 History 拥有（mediaDefaults），这里只补上工具、结构化输出等 Agent 自己的开关。
const DEFAULT_CAPABILITIES = { ...History.mediaDefaults, tools: true, structuredOutput: true, toolChoice: true, reasoning: false } // 陌生渠道默认只发通用能力，高级能力由调用方逐项打开。
const DEFAULT_COMPACT_THRESHOLD = 0.8 // 设置 maxTokens 后，上下文到这个比例就压缩。
// 有工具时连续几轮不调工具就结束一次 send。默认 1：模型不调工具就是在给最终回答。
// 实测默认 3 时，模型答完还会被追问两轮，最后一轮常是"谢谢确认"甚至空字符串，把真正的答案盖掉，耗时也翻几倍。
const DEFAULT_NO_TOOL_ROUNDS = 1

// --- 开始一次运行：先停掉上一次，再做这一次的事 ---
// send 和 compact 都走这里，所以"同一时间只跑一个任务"这条规则只写一次。
// 这个函数从头到尾一个 await 都没有：同一个 tick 里连发两次，第二次一定看得见第一次并把它停掉，
// 不会出现两个任务同时往同一份 history 里写。
// work 拿到本次的取消信号，返回这一次要做的事；返回的 Promise 就是 send / compact 的返回值。
const start = (agent, work, outside) => {
    const previous = agent.running                              // 上一次运行（可能是 send，也可能是 compact）。
    const controller = new AbortController()                    // stop() 靠它中断这一次。
    const signal = outside ? AbortSignal.any([controller.signal, outside]) : controller.signal // 调用方自己的取消信号也能停掉它。

    const task = (async () => {
        if (previous) {                                         // 上一次还在跑：先停掉它，再开始这一次。
            previous.controller.abort()
            await previous.task.catch(() => {})                 // 旧任务以 AbortError 结束是正常的，不当成新异常。
        }
        if (signal.aborted) throw new DOMException('Agent run aborted', 'AbortError') // 等待期间已被更新的任务取消：不写入这次输入，history 里不留没人回答的指令。
        return work(signal)                                     // 等旧任务收尾完再开始，history 的顺序才和实际发生的顺序一致。
    })()

    agent.running = { controller, task }                        // 一次构造完整，stop() 拿到的永远是可用的运行对象。
    task.finally(() => {
        if (agent.running?.task === task) agent.running = null  // 只清理自己的任务，后来的任务不受影响。
    }).catch(() => {})
    return task
}


// 创建一台独立 Agent：传入的对象会成为这台机器公开、可继续修改的内部状态。
const create = ({ id = nanoid(), history = [], config = {}, tools = { schema: {}, handlers: {} }, skills = null, callbacks = {} } = {}) => {
    const agent = {
        id,       // Agent 的身份只用于区分实例和权限等待。
        history,  // 直接保存外部传入的数组，外部可以和 Agent 共同修改它。
        config: {
            baseURL: '',            // 没有模型地址时，真正发送请求才会报错。
            apiKey: '',             // 密钥只在模型请求时使用，不参与 Agent 流程判断。
            model: '',              // 模型名称没有默认值，避免静默选择错误模型。
            protocol: 'chat',       // 大多数兼容 OpenAI Chat 的服务使用这个协议。
            provider: {},           // AI SDK 的生成参数整包转发，默认一个都不设——替调用者的模型默认 temperature 是在猜他的模型。
            cache: true,            // 默认开启提示词缓存：chat/responses 发 prompt_cache_key，anthropic 打 cache_control。个别中转站不认时设 false。
            mediaFallback: 'error', // 媒体能力关闭时默认明确报错；需要尽量跑完时改成 'strip'。
            maxToolOutput: undefined, // 不截断工具输出；需要保护内存时由调用方主动设置字符上限。
            maxToolConcurrency: undefined, // 不限制同一轮工具并发；需要排队时由调用方主动设置。
            maxTokens: undefined,      // 不估算或压缩上下文；需要窗口保护时由调用方主动设置。
            maxSteps: undefined,    // 不设上限；调用方主动传入正整数时才限制一次 send 的模型轮数。
            retryMaxDelay: undefined, // 不限制退避上限；调用方需要限制等待时主动设置毫秒数。
            retryMaxElapsed: undefined, // 不限制重试总时长；服务恢复前持续重试，调用方可主动设置毫秒数。
            requestTimeout: undefined, // 不限制单笔请求时长；调用方需要防卡死时主动设置毫秒数。
            noToolPrompt: undefined, // 不主动催促模型；调用方需要无工具提醒时主动设置。
            compact: undefined,     // 压缩想用另一套模型时写在这里（{ model, baseURL, apiKey, provider… }）；不写就和主模型共用。
            output: undefined,      // 要固定格式的结果时写在这里，如 Agent.output.object({ schema })；不写就返回普通文字。
            stream: true,           // 主循环和压缩请求都使用流式输出。
            toolMode: 'native',     // 默认只用原生工具，不往 system 里注入任何东西。接纯对话模型时主动开 'text' 或 'auto'。
            system: '',             // 没有系统提示词时仍允许 Agent 运行。
            ...config,              // 传入配置覆盖默认配置，且配置结构只包含 Agent 需要的字段。
            provider: { ...config.provider },                                                                                   // 单独浅拷一层：两个 Agent 共用一个 provider 对象时，改其中一个不该动到另一个。
            capabilities: { ...DEFAULT_CAPABILITIES, ...config.capabilities },                                                // 能力开关按字段覆盖，其余保持默认。
            compactThreshold: config.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD,                                            // 压缩比例只有这一个来源，Loop 直接用它。
            noToolRounds: config.noToolRounds ?? DEFAULT_NO_TOOL_ROUNDS,                                                       // 无工具结束轮数只有这一个来源，Loop 直接用它。
        },
        tools,                       // Agent.tool.scan() 的返回值：{ schema, handlers }，后续 send 可以整份替换。
        skills: skills ?? null,      // Agent.skill.scan() 的返回值；没传就是 null，system 和工具表都不受影响。
        callbacks: { ...callbacks }, // 回调逐项保存，后续 send 只覆盖传入的回调。
        running: null,               // null 表示空闲；运行对象保存当前停止控制器和任务。
    }


    // 发送指令：更新本次传入的持久参数，登记运行状态，然后启动新任务。
    // 输入既可以是一句话，也可以是 AI SDK 风格的内容块数组（发图片、发文件走数组这条路）。
    // send('你好') 和 send({ input: '你好' }) 是同一件事——只有一句话时不该逼调用者写一个对象。
    // 出错方式只有一种：返回的 Promise 会拒绝。入口检查和网络失败都走这里，调用方只写 .catch() 就够。
    // （取消、模型报错也都从同一条链上抛出来，不需要额外写 try/catch 去接同步异常。）
    agent.send = (input, options = {}) => {
        if (typeof input === 'object' && input !== null && !Array.isArray(input)) ({ input, ...options } = input) // 传对象就是完整形式，传字符串或数组就是纯输入。

        // --- 检查输入：被入口直接调用的指令，只在这里查一次 ---
        const empty = typeof input === 'string' ? !input.trim() : !Array.isArray(input) || !input.length
        const limits = { ...agent.config, ...(options.config ?? {}) } // 本次真正生效的配置：即将覆盖的值也要一起检查。
        const invalid =
            empty ? new TypeError('input must be a non-empty string or a non-empty content array')                            // 没有本次输入就没有可执行指令。
            : limits.maxSteps !== undefined && (!Number.isInteger(limits.maxSteps) || limits.maxSteps < 1) ? new RangeError('maxSteps must be a positive integer') // 设成 0 却仍然发出一次请求，是调用方最容易被骗到的地方。
            : limits.noToolRounds !== undefined && limits.noToolRounds !== Infinity && (!Number.isInteger(limits.noToolRounds) || limits.noToolRounds < 1) ? new RangeError('noToolRounds must be a positive integer or Infinity') // 0 会让一次 send 一轮都不走。
            : null
        if (invalid) return Promise.reject(invalid)
        if ('history' in options) agent.history = options.history                                           // 传入空数组也代表明确覆盖历史。
        if ('config' in options) agent.config = { ...agent.config, ...options.config, provider: 'provider' in options.config ? { ...options.config.provider } : agent.config.provider, capabilities: 'capabilities' in options.config ? { ...agent.config.capabilities, ...options.config.capabilities } : agent.config.capabilities } // provider 整包替换；能力开关按字段合并，调用方只改一个开关就够。
        if ('tools' in options) agent.tools = options.tools                                                 // 工具是整体替换，不在 Agent 内部猜测如何合并。
        if ('skills' in options) agent.skills = options.skills ?? null                                      // 技能整份替换；传 null 表示这台 Agent 不使用技能。
        if ('callbacks' in options) agent.callbacks = { ...agent.callbacks, ...options.callbacks }         // 回调逐项合并，避免替换一个回调时清掉其他回调。
        const callbacks = { ...agent.callbacks }                    // 拍下本次回调，后来的 send 不会改变正在运行的通知出口。

        return start(agent, signal => {
            agent.history.push(History.user({ content: input }))   // 写下这次的指令。
            const compactLLM = buildCompact(agent.config)          // 压缩用哪套模型在这里定下来，自动压缩和手动压缩共用同一个来源。

            // 技能：扫到了才注入系统提示词、才挂上内置的 skill 工具。
            // 没扫到（或没传）时这两行都是空操作，system 一个字节都不多，工具表也不动——默认零注入。
            const active = agent.config.capabilities.tools === false || !agent.skills?.list?.length ? null : agent.skills
            const system = active ? [agent.config.system, active.prompt].filter(Boolean).join('\n\n') : agent.config.system
            const tools = active ? Tool.merge(agent.tools, active) : agent.tools // 内置技能工具和用户工具共用一张表，同名时技能工具优先。

            return Loop.run({
                history: agent.history,           // Loop 直接使用这份公开数组，执行结果也会继续写入这里。
                system,                           // 系统提示词 + 本次真正启用的技能列表。
                tools: agent.config.capabilities.tools === false ? {} : tools.schema, // 兼容开关关闭工具时，模型请求和 Loop 都看不到工具（技能工具也一并关掉）。
                llm: buildLLM(agent.config),      // 主请求用的模型配置。
                buildContext: options => Context.build({ ...options, capabilities: agent.config.capabilities, mediaFallback: agent.config.mediaFallback }), // 上下文构建交给 Context 模块，并带上本次模型的能力开关。
                compact: request => Compact.run({ ...request, llm: compactLLM, stream: compactLLM.stream }), // 压缩用哪套模型由 Agent 决定；Loop 只负责什么时候压、压哪些消息。
                executeTool: request => Tool.execute({ ...request, handlers: tools.handlers, limit: agent.config.maxToolOutput, concurrency: agent.config.maxToolConcurrency }), // 执行器需要的处理表、输出上限和并发上限由 Agent 补上，Loop 不用知道它们。
                sessionId: agent.id,             // 会话 ID 用于权限询问时区分实例。
                ...callbacks,                     // 本次回调快照，后来的 send 不会改变正在运行的通知出口。
                signal,                           // stop 和外部取消信号共同控制本次运行。
            })
        }, options.signal)
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
    // 和 send 走同一个 start，所以两者抢跑时，后来的那个一定看得见先来的并把它停掉。
    agent.compact = ({ onCompact = agent.callbacks.onCompact, onRetry = agent.callbacks.onRetry, ...options } = {}) => start(agent, async signal => {
        const context = Context.build({ history: agent.history, system: agent.config.system, tools: agent.tools.schema, capabilities: agent.config.capabilities, mediaFallback: agent.config.mediaFallback }) // 取出现在要发给模型的上下文。
        const compactLLM = buildCompact(agent.config)    // 与 send 里的自动压缩用同一个来源，手动压缩不会偷偷换成主模型。
        const content = await Compact.run({
            ...options,
            messages: context.messages,                   // 把裁剪后的上下文交给 Compact。
            llm: compactLLM,                              // 压缩专用的模型配置。
            stream: compactLLM.stream,                    // 流式与否也跟着压缩那套配置走。
            onCompact,                                    // 单次回调优先，否则沿用 Agent 的默认回调。
            onRetry,                                      // 手动压缩和自动压缩走同一套重试通知。
            signal,                                       // stop() 也能中断手动压缩。
        })
        agent.history.push(History.compact({ content }))  // 总结文本写回公开历史。
        return content
    })

    return agent
}


// 导出时附带全部常用模块。这个包会被打包成单文件嵌进别的项目，那时 default 导出就是唯一的入口——
// 凡是嵌入方需要的东西都必须挂在这里，否则在打包产物里根本够不着。
const Agent = {
    version,          // 包版本，来自 package.json；排查问题时上层要能报出来
    create,           // 创建 Agent 实例
    tool: Tool,       // 工具扫描和执行：Agent.tool.scan() / Agent.tool.execute()
    skill: Skill,     // 技能扫描：Agent.skill.scan()；扫到技能才注入系统提示词、才挂内置 skill 工具
    history: History, // 造标准历史消息块：Agent.history.user() / assistant() / tool() / compact()
    context: Context, // 上下文构建：Agent.context.build()
    compact: Compact, // 生成压缩总结：Agent.compact.run()
    llm: LLM,         // 底层模型请求：Agent.llm.chat()
    output: Output,   // Agent.output.object / array / json：上游结构化输出格式。
    schema: z,        // Agent.schema.object / string 等：包内同一份 Zod。
}

export default Agent
