/*
把一次 Agent 运行的回调变成可读取的事件流，不创建第二套模型或工具循环。
调用示例：
  const run = agent.stream('你好')
  for await (const event of run.events) console.log(event.type, event.data)
  console.log(await run.result)
网页接口：return agent.stream({ input: '你好', signal: request.signal }).response()

events 是标准 ReadableStream，只能选一个消费者：自己读取，或交给 response()。
流中的格式始终是 { type, data }，模型原生事件放在 type='llm' 的 data 中。
完成发送 finish，失败发送 error；result 同时保留原始返回值或原始异常。
必须消费 events 才能持续推进模型输出；Web Streams 的等待机制会让模型回调跟随读取速度。
工具 console 输出本来是不等待的 IPC 通知，会暂存在写入队列中，不默认丢弃或截断。

取消读取默认停止这一次运行；cancelOnDisconnect:false 则只断开输出，让后台继续。
stop() 和传入的 signal 始终停止本次运行，不依赖 agent.running 当前指向谁。
所有观察回调只属于这次运行，不会写回 agent.callbacks 污染后续 send。
*/

export const observe = Symbol('run events') // 内部传递观察出口，避免和调用方配置字段撞名。

// --- 保留已有回调，再向流发送一份事件 ---
// 权限回调不包装：true / false 的决策仍由调用方处理，不能当普通通知丢掉。
export const callbacks = (base, publish) => {
    if (!publish) return base // 普通 send 走原路径，不创建流或额外队列。
    const result = { ...base }
    const names = { onStart: 'start', onLLMEvent: 'llm', onLLMFinish: 'model-finish', onToolCall: 'tool-call', onToolOutput: 'tool-output', onToolResult: 'tool-result', onStep: 'step', onCompact: 'compact', onRetry: 'retry' }
    for (const [name, type] of Object.entries(names)) {
        result[name] = data => {
            const pending = (async () => { await base[name]?.(data); await publish(type, data) })()
            pending.catch(publish.fail) // IPC 日志不等待回调；任意用户回调失败也不能被当成网络错误反复请求。
            return pending
        }
    }
    return result
}

// --- 开始一次有事件出口的 send ---
const run = (send, input, options = {}) => {
    const request = typeof input === 'string' || Array.isArray(input) ? { ...options, input } : { ...input }
    const controller = new AbortController() // 每条流各自持有取消权，不能去停止后来那次任务。
    const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal
    const channel = new TransformStream() // 不复制一份历史；只把已有回调送入标准流。
    const writer = channel.writable.getWriter()
    let connected = true
    let finished = false
    let detach = () => {} // send 也有自己的停止控制器，运行结束后解除这条关联。

    // --- 关闭读取或主动取消时解除等待 ---
    const abort = () => { connected = false; void writer.abort(signal.reason).catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    writer.closed.catch(() => {
        connected = false
        if (!finished && request.cancelOnDisconnect !== false) controller.abort(new DOMException('Stream reader disconnected', 'AbortError'))
    })

    // --- 写事件；断开但选择后台继续时，后面的输出直接跳过 ---
    const publish = async (type, data) => {
        if (!connected) return
        try { await writer.write({ type, data }) }
        catch { connected = false } // writer.closed 统一决定是否取消，避免在多个出口重复决定。
    }
    publish.fail = error => controller.abort(error) // 非等待式工具回调失败也能让本次运行停止。
    publish.bind = runningSignal => {
        const cancel = () => controller.abort(runningSignal.reason) // 后来的 send 取消旧任务时，同时解除旧流的写入等待。
        runningSignal.addEventListener('abort', cancel, { once: true })
        if (runningSignal.aborted) cancel()
        detach = () => runningSignal.removeEventListener('abort', cancel)
    }

    const result = (async () => {
        try {
            const value = await send({ ...request, signal, [observe]: publish }) // 参数、历史、工具循环仍由 send 唯一负责。
            await publish('finish', value)
            finished = true
            if (connected) await writer.close()
            return value
        } catch (error) {
            await publish('error', { name: error.name, message: error.message, kind: error.kind }) // 网络出口只发错误描述和分类，不泄漏 SDK 请求头和密钥。
            finished = true
            if (connected) await writer.close()
            throw error // 调用方 await result 时仍拿到原始异常。
        } finally { signal.removeEventListener('abort', abort); detach() }
    })()
    result.catch(() => {}) // 只读 response 的调用方不必为了防未处理拒绝再写一套异常消费。

    return {
        events: channel.readable,
        result,
        stop: () => controller.abort(new DOMException('Stream stopped', 'AbortError')),
        response(init = {}) {
            const headers = new Headers(init.headers)
            headers.set('Content-Type', 'text/event-stream; charset=utf-8') // 标准 SSE；不是 AI SDK UIMessage 私有协议。
            if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-cache')
            const encoder = new TextEncoder()
            const body = channel.readable.pipeThrough(new TransformStream({
                transform(event, output) {
                    const json = JSON.stringify(event, (_, value) => value instanceof Error ? { name: value.name, message: value.message } : value)
                    output.enqueue(encoder.encode(`data: ${json}\n\n`)) // JSON 转义换行，不会把模型文字变成伪造的 SSE 帧。
                },
            }))
            return new Response(body, { ...init, headers }) // 标准 Response，可交给 Bun.serve 或 Elysia 等 Web 框架。
        },
    }
}

export default { run } // 只有数据出口；不持有 Agent 状态或额外模型。
