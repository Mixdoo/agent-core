/*
目标被调用形式（绝对不可修改）：
const result = await Retry.run({
    // 要重试的操作（一个返回 Promise 的函数）
    operation: () => LLM.chat({ baseURL, model, messages, tools }),

    // 取消信号，用户点停止时触发
    signal: abortSignal,

    // 重试通知回调，UI 靠它显示"正在重试"
    onRetry: (info) => {},

    // 重试退避时间上限，默认 60 秒
    maxDelay: 60,

    // 一直失败最多再试多久，默认 300 秒
    maxElapsed: 300,
})
 */

import pRetry from 'p-retry'

// "这个错误能不能重试"由抛错的人说了算：LLM.chat 抛的是 AI SDK 的原始 APICallError，
// 它自己带着 isRetryable（429、408、5xx、连接失败都为真）。这里不再照着状态码重新判断一遍，
// 否则同一件事会有两套标准，而且一旦 AI SDK 换了错误形状，这里就会静默失效。
const isRetryable = error => {
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return false // 用户主动取消不是失败，不该重试。
    return error?.isRetryable === true
}

const run = async ({ operation, signal, onRetry, maxDelay = Infinity, maxElapsed = Infinity }) => {
    // 上界是时间，不是次数。常驻 agent 遇到瞬时故障应该一直试下去，但"服务挂了一整天"也得有个头——
    // 不设头的话调用方既不 resolve 也不 reject，上层连"出事了"都不知道，没法退避、告警或换模型。
    // 时间预算直接用 p-retry 的 maxRetryTime（它内部走单调时钟，不受系统改时间影响），不再自己算截止时刻。
    const options = {
        retries: Infinity,                        // 次数不设限，由 maxRetryTime 收口。
        signal,                                   // p-retry 会在请求之间和等待期间响应用户取消。
        minTimeout: 1000,                         // 第一次等待一秒，后续自动按指数增长。
        maxRetryTime: Number.isFinite(maxElapsed) ? maxElapsed * 1000 : Infinity, // 一直失败最多再试多久。
        shouldRetry: async ({ error, attemptNumber, retryDelay }) => {
            if (!isRetryable(error)) return false  // 不能重试的错误立刻收手，把原始错误交给上层。
            await onRetry?.({ attempt: attemptNumber, error, delay: retryDelay }) // 让上层能显示"正在重试第几次"。
            return true
        },
    }
    if (Number.isFinite(maxDelay)) options.maxTimeout = maxDelay * 1000 // 只有调用方明确设了上限才限制单次等待。
    return pRetry(operation, options) // 交回重试库执行，结果或错误原样向上传。
}

export default { run }
