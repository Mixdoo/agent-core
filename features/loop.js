/*
目标被调用形式（绝对不可修改）：
const result = await Loop.run({
    // --- 数据（必填）---
    history: [],                // 完整历史消息列表
    system: "你是编程助手",         // 系统提示词
    tools: tools.schema,        // 给模型看的工具描述，来自 Tool.scan() 的 schema

    // --- LLM 参数（必填，内部传给 LLM.chat）---
    llm: {
        // 连接
        baseURL: "https://中转站/v1",
        apiKey: "sk-xxx",
        model: "model-name",
        protocol: "chat",          // chat / responses / anthropic / gemini
        provider: {                // AI SDK 的生成参数，交给 LLM.chat 原样转发
            temperature: 0.3,
            headers: {},
            body: {},
        },
        // 下面这些值由 Agent 组装好再传进来（见 agent.js 的默认值），Loop 直接使用，不再自己补默认。
        maxTokens: undefined,      // 不限制上下文；设置后才启用 token 估算和压缩
        compactThreshold: 0.8,     // 设置 maxTokens 后使用的压缩比例
        maxSteps: undefined,       // 不设上限；调用方主动传入正整数时才限制模型轮数
        stream: true,              // 主请求和压缩都流式输出
        noToolPrompt: "继续使用工具", // 模型连续两轮不调工具时的临时提示
        noToolRounds: 1,           // 连续多少轮不调工具就结束；Infinity 表示永不因此结束
        retryMaxDelay: 60000,       // 重试退避上限（毫秒）。重试是 LLM.chat 自带的，压缩那次请求也走同一套。
    },
    // --- 功能模块（必填，平齐的功能模块作为参数传）---
    buildContext: Context.build,       // 上下文构建模块
    compact: Compact.run,             // 上下文压缩模块
    executeTool: request => Tool.execute({ ...request, handlers: tools.handlers }), // 工具执行模块，handlers 由调用方补上
    sessionId: "session-1",               // 压缩和工具输出使用的会话

    // --- 控制（可选）---
    signal: abortSignal,           // 取消信号

    // --- 回调（全部可选）---
    onStart: () => { },                    // 循环开始
    onLLMStart: (request) => { },          // 每次实际请求模型前
    onLLMFinish: (result) => { },          // 本次模型请求完成，返回完整 result
    onLLMEvent: event => {},               // 原样接收 AI SDK 的所有流事件
    onRetry: (info) => { },                // 请求失败重试中
    onPermission: async (permission) => { }, // 工具权限询问，返回 true 或 false
    onToolCall: (call) => { },              // 工具调用开始
    onToolOutput: (output) => { },          // 工具实时输出
    onToolResult: (result) => { },         // 工具执行完
    onStep: (step) => { },                 // 一轮模型和工具都完成后
    onCompact: (event) => { },             // 压缩过程通知
 })
 // result = { reason: 'no-tool' | 'tool-stop' | 'step-limit', text: '最后一轮模型生成的文字' }
 */

import History from '../utils/history.js'
import LLM from '../utils/llm.js'

const run = async ({
    history, system, tools, llm, buildContext, compact, executeTool, sessionId, signal,                                 // 数据、LLM 参数、功能模块和取消信号
    onStart, onLLMStart, onLLMFinish, onPermission, onLLMEvent, onRetry, onToolCall, onToolOutput, onToolResult, onStep, onCompact, // 全部回调，没传的自动跳过
}) => {
    await onStart?.()          // 外部需要时知道循环已经开始；没有回调就跳过。等它完成，回调抛错才能顺着 send() 冒出去，而不是变成没人接的拒绝。
    const noToolRounds = llm.noToolRounds       // 结束轮数由 Agent 填好再传进来，这里不再写第二份默认值。
    const compactThreshold = llm.compactThreshold // 压缩比例同理，来源只有 Agent 一处。
    let noToolCount = 0        // 记录连续没有工具调用的模型回合。
    let steps = 0              // 一次 send 发给模型的轮数；重试属于同一轮，压缩不算任务轮次。
    let temporaryPrompt = null  // 工具提示只临时发送给模型，不写入 history。

    while (true) {
        // --- 每轮开始：先响应取消信号 ---
        if (signal?.aborted) throw new DOMException('Agent loop aborted', 'AbortError')

        // --- 构建上下文，Token 超限时压一次 ---
        // 每轮最多压一次，不循环压到达标为止：压缩本身就是一次真实模型请求，
        // 而"压完还是超限"通常意味着剩下的内容（单个巨大回合、或工具定义本身）根本压不动，
        // 循环只会一轮一轮地烧钱——实测 maxTokens 配小时能烧到 5500 次请求，
        // 每轮降一点点的情况下加了"没变小就停"的护栏也还能烧 122 次。
        // 压一次之后仍然超限就照常发出去，由模型服务判断收不收；下一轮如果还超，自然会再压一次。
        let context = buildContext({ history, system, tools, budget: llm.maxTokens })
        if (Number.isFinite(llm.maxTokens) && context.token >= llm.maxTokens * compactThreshold) {
            const content = await compact({ messages: context.messages, llm, stream: llm.stream, onCompact, onRetry, signal }) // 自动压缩只在接近上限时触发；Compact 本身不判断上下文大小。
            history.push(History.compact({ content }))                       // 总结写回 history。
            context = buildContext({ history, system, tools, budget: llm.maxTokens })                // 用压缩后的历史重建上下文。
        }
        // 压缩只往 history 里追加一条总结，永远不删任何东西：
        // history 是这个项目唯一的权威数据来源，该保留多少由持有它的上层决定，核心包无权替它丢数据。
        // 压缩控制的是"这一轮发给模型的内容有多大"，不是"历史能留多少"。

        // --- 请求模型 ---
        // 重试不在这里：它是 LLM.chat 自带的，压缩那次请求走的是同一条路、同一套退避。
        if (signal?.aborted) throw new DOMException('Agent loop aborted', 'AbortError')
        const request = { messages: temporaryPrompt ? [...context.messages, History.user({ content: temporaryPrompt })] : context.messages, tools } // 临时提示只挂在本次请求上。
        const result = await LLM.chat({ ...llm, ...request, signal, onLLMEvent, onLLMStart, onRetry })
        steps += 1            // 模型完整回答后才算这一轮，失败重试由 LLM.chat 自己处理。
        await onLLMFinish?.(result) // 上层拿到完整 result，自行选择 usage 或其他字段。
        const answer = { text: result.text, ...('output' in result ? { output: result.output } : {}) } // 最终对象和文字来自同一轮，不能从旧历史猜结果。
        temporaryPrompt = null      // 提示已经用过，下一轮默认不再携带。

        // --- 处理无工具调用的情况 ---
        const toolCalls = result.toolCalls || []                                                        // 模型这轮想调用的工具。
        const assistantMessages = result.responseMessages.filter(message => message.role === 'assistant').map(History.stored) // 只保留 assistant 消息；补上 id 再进 history，前端才能定位每一条。

        if (!toolCalls.length) {
            history.push(...assistantMessages)                                  // 保存模型完整 assistant 消息。
            await onStep?.({ step: steps, result, toolCalls, toolResults: [] })    // 让调用方在回答已经写入 history 后观察这一轮。
            if ('output' in result || !Object.keys(tools).length) return { reason: 'no-tool', ...answer } // 校验成功的最终对象直接返回，不再额外请求模型。
            if (steps >= llm.maxSteps) return { reason: 'step-limit', ...answer } // 上限返回本轮文字，工具轮不捏造对象。
            noToolCount += 1                                                    // 累计没有工具调用的轮次。
            if (noToolCount === noToolRounds - 1) temporaryPrompt = llm.noToolPrompt // 结束前一轮：插入临时提示推一下模型。
            if (noToolCount >= noToolRounds) return { reason: 'no-tool', ...answer } // 到达上限：返回最后一次回答。Infinity 时这里永不触发。
            continue
        }
        noToolCount = 0 // 有工具调用，计数清零。

        // --- 并行执行所有工具调用 ---
        // Promise.all 让所有工具同时开跑，返回结果的顺序和 toolCalls 一致。
        // 流式输出通过 onToolOutput 带上 toolCallId 实时发出，上层靠 ID 区分是哪个工具的输出。
        const toolResults = await Promise.all(toolCalls.map(async call => {
            await onToolCall?.(call) // 让上层知道即将执行哪个工具。

            // AI SDK 标记 invalid 的调用：参数没法解析，或模型点了一个不存在的工具。
            // 此时 call.input 是原始字符串而不是对象，真跑下去等于拿脏数据喂工具。告诉模型让它重来。
            if (call.invalid) return { call, output: { type: 'error-text', value: `工具调用无效：${call.error?.message ?? '参数无法解析，或这个工具不存在'}` } }

            // 模型已经产生了完整工具调用。即使此刻被取消，也要给它补一条取消结果。
            if (signal?.aborted) return { call, output: { type: 'error-text', value: '工具执行已取消' }, stop: true }

            const allowed = await onPermission?.({ sessionId, toolCallId: call.toolCallId, toolName: call.toolName, arguments: call.input, signal }) ?? true // 没有权限回调时按无人值守模式直接放行。
            if (!allowed) return { call, output: { type: 'execution-denied', reason: '工具执行被用户拒绝' } } // 拒绝也是一条结果，模型需要知道。

            try {
                // onToolOutput 是高频流式回调，这里不等它：等一下就等于给模型输出加了一道节流阀。
                const value = await executeTool({ name: call.toolName, input: call.input, signal, onOutput: output => onToolOutput?.({ ...output, ...call }) }) // Loop 只说要执行哪个工具，怎么找到它由调用方负责。
                await onToolResult?.({ ...call, result: value, output: value.output })                              // 通知上层这个工具已经执行完。
                return { call, output: value.output, stop: value?.stop === true || value?.interrupted === true }    // 工具主动停止或被中断都要结束循环。
            } catch (error) {
                // 工具失败属于工具结果，不能让一次工具失败打断整个 Agent 循环。
                // 取消路径由 tool.js 用 resolve 处理，不会走到这里；这里接的是"工具名不在表里"这类调用错误。
                const output = { type: 'error-text', value: `工具执行失败：${error.message}` } // 失败信息也交给模型，让它自己决定怎么补救。
                await onToolResult?.({ ...call, error: error.message, output })
                return { call, output }
            }
        }))

        // --- 把本轮消息和工具结果写回历史 ---
        history.push(...assistantMessages) // AI SDK 的 tool 消息不用，工具结果由项目自己的执行器生成。
        for (const { call, output } of toolResults) history.push(History.tool({ toolCallId: call.toolCallId, toolName: call.toolName, content: output }))
        await onStep?.({ step: steps, result, toolCalls, toolResults })             // 工具结果已写入 history，调用方可安全持久化这一轮。

        // --- 判断是否停止循环 ---
        if (toolResults.some(result => result.stop)) {                                          // 任何一个工具要求停止，整个循环就结束。
            if (signal?.aborted) throw new DOMException('Agent loop aborted', 'AbortError')      // 取消导致的停止，仍然按异常向上抛。
            return { reason: 'tool-stop', ...answer } // 工具主动停止时不另外生成未请求的最终对象。
        }
        if (steps >= llm.maxSteps) return { reason: 'step-limit', ...answer } // 完整工具历史写完后退出。
    }
}

export default { run }
