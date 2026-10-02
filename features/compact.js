/*
目标被调用形式（绝对不可修改）：
const content = await Compact.run({
    messages: messages,            // 需要压缩的上下文消息
    llm: {                          // 用来生成总结的模型配置
        baseURL: "https://中转站/v1",
        apiKey: "sk-xxx",
        model: "model-name",
        protocol: "chat",
        provider: { temperature: 0.3 }, // 可选，和主请求共用 AI SDK 参数
    },
    stream: true,                  // 是否流式生成总结
    onCompact: event => {},        // compact-start / AI SDK 原生事件 / compact-finish
    onRetry: info => {},           // 总结请求重试时通知
    signal: abortSignal,           // 可中断手动和自动压缩
})
// content = "压缩后的总结文本"
// onCompact compact-start: { type, messages }，压缩开始
// onCompact: 接收 AI SDK 原生事件，不做过滤或转换
// onCompact compact-finish: { type, content }，压缩完成
*/

import LLM from '../utils/llm.js'

// 压缩的指令。说清楚"留什么、丢什么"，模型才知道这份总结是拿来接着干活的，不是拿来复述的。
const SUMMARIZE = `请把以上对话压缩成一段总结，供你自己后续继续工作时使用。
保留：已经确认的事实与数据、已完成的步骤及其结论、还没做完的事、用户最初的目标。
丢弃：寒暄、重复的中间过程、已经被后续结果推翻的内容。
只输出总结本身，不要说"好的"，不要继续对话。`

// Compact 只负责把上下文变成总结文本，是否需要压缩由调用方决定。
const run = async ({ messages, llm, stream = true, onCompact, onRetry, signal }) => {
    await onCompact?.({ type: 'compact-start', messages })                                        // 告诉上层：压缩开始了。

    const result = await LLM.chat({
        ...llm,                                                                                   // 用什么模型总结由调用方决定，这里不挑模型。
        provider: { ...llm.provider, output: undefined, toolChoice: undefined }, // 总结是自由文本：去掉任务的最终对象格式，也不强制它调工具。
        system: '你在压缩一段你自己参与过的工作记录。只输出总结内容本身。',                       // 换成压缩专用的系统提示词。

        // 要压缩的消息原样当成 messages 发过去，不要 JSON.stringify 塞进一条 user 消息里：
        // 那样引号会被二次转义，实测压缩请求能膨胀到它要压的上下文的 1.51 倍（工具输出是 JSON 时），
        // 于是"压缩"这个本该救命的动作，反而成了第一个把上下文窗口撑爆的请求——
        // 实测正常轮次最高才 92201 token 很安全，压缩请求 157011 直接 400 且不可重试。
        // 原来的 system 要滤掉：它已经被上面那条换掉了，留着会变成一条夹在对话中间的 system 消息。
        messages: [...messages.filter(message => message.role !== 'system'), { role: 'user', content: SUMMARIZE }],

        stream,                                                                                   // 流式与否跟调用方走。
        signal,                                                                                   // 取消压缩和取消普通请求是同一种。
        onRetry,               // 压缩失败能重试——它和主循环走的是同一条 LLM.chat，同一套退避。
        onLLMEvent: onCompact, // 压缩过程中的每个流事件都转发给上层，UI 能显示进度。
    })

    const content = result.text.trim()                                                            // 总结就是模型输出的文字。
    if (!content) throw new Error('压缩失败：模型返回空总结') // 空总结会导致 History.compact 校验失败，提前报错。
    await onCompact?.({ type: 'compact-finish', content })                                        // 告诉上层：压缩完成，总结是这个。
    return content                                                                                // 总结文本交回调用方（由它写进 history）。
}

export default { run }
