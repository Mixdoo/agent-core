/*
事件流和网页响应共用 send；测试读取顺序、慢消费者、错误、关闭以及旧流不能取消新任务。
调用：bun test tests/stream.test.js。只使用本地模拟模型。
*/
import { test, expect } from 'bun:test'
import Agent from '../index.js'

// --- 一台支持普通和流式回答的模型服务 ---
const service = (text = '你好') => {
    const calls = []
    const server = Bun.serve({
        port: 0,
        async fetch(request) {
            const body = await request.json()
            calls.push(body)
            if (!body.stream) return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: {} })
            return new Response([
                `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: text } }] })}\n\n`,
                `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: {} })}\n\n`,
                'data: [DONE]\n\n',
            ].join(''), { headers: { 'Content-Type': 'text/event-stream' } })
        },
    })
    return { server, calls, config: { baseURL: `http://127.0.0.1:${server.port}/v1`, model: 'm' } }
}

test('事件流保持模型事件、轮次、最终结果顺序，原回调照常调用', async () => {
    const { server, config } = service()
    try {
        const observed = []
        const callback = step => observed.push(step.step)
        const agent = Agent.create({ config, callbacks: { onStep: callback } })
        const run = agent.stream('你好')
        const events = []
        for await (const event of run.events) events.push(event)
        expect(events[0].type).toBe('start')
        expect(events.some(event => event.type === 'llm' && event.data.type === 'text-delta')).toBe(true)
        expect(events.at(-2).type).toBe('step')
        expect(events.at(-1)).toEqual({ type: 'finish', data: await run.result })
        expect(observed).toEqual([1])
        expect(agent.callbacks.onStep).toBe(callback)
        expect((await agent.send('再次发送')).text).toBe('你好') // 不再触碰已经关闭的旧流。
    } finally { server.stop(true) }
})

test('Response 输出标准 SSE 和最终结构化对象，可附加响应头', async () => {
    const { server, config } = service('{"total":42}')
    try {
        const agent = Agent.create({ config: { ...config, output: Agent.output.object({ schema: Agent.schema.object({ total: Agent.schema.number() }) }) } })
        const run = agent.stream('总数')
        const response = run.response({ headers: { 'X-Test': 'yes' } })
        expect(response.headers.get('content-type')).toContain('text/event-stream')
        expect(response.headers.get('x-test')).toBe('yes')
        const events = (await response.text()).trim().split('\n\n').map(frame => JSON.parse(frame.slice(6)))
        expect(events.at(-1).data.output).toEqual({ total: 42 })
        expect((await run.result).output.total).toBe(42)
    } finally { server.stop(true) }
})

test('没有读流时等待消费者，开始读取后继续推进', async () => {
    const { server, config, calls } = service()
    try {
        const run = Agent.create({ config }).stream('慢慢读')
        await Bun.sleep(30)
        expect(calls).toHaveLength(0) // start 事件还没被读取，模型请求也不会提前堆积。
        for await (const event of run.events) { await Bun.sleep(2) }
        expect((await run.result).text).toBe('你好')
    } finally { server.stop(true) }
})

test('取消读取默认停止当前任务，旧流停止不会误杀新 send', async () => {
    const { server, config } = service()
    try {
        const agent = Agent.create({ config })
        const run = agent.stream('取消')
        await run.events.cancel()
        await expect(run.result).rejects.toThrow()
        expect(agent.running).toBeNull()
        const next = agent.send('新任务')
        run.stop()
        expect((await next).text).toBe('你好')
    } finally { server.stop(true) }
})

test('新 send 可以替换尚无人读取的旧流，不会卡在等待旧流上', async () => {
    const { server, config } = service()
    try {
        const agent = Agent.create({ config })
        const old = agent.stream('旧任务')
        const next = agent.send('新任务')
        await expect(old.result).rejects.toThrow()
        expect((await next).text).toBe('你好')
    } finally { server.stop(true) }
})

test('选择断开后后台继续时，只停止输出，不中断模型', async () => {
    const { server, config } = service()
    try {
        const run = Agent.create({ config }).stream('后台继续', { cancelOnDisconnect: false })
        await run.events.cancel()
        expect((await run.result).text).toBe('你好')
    } finally { server.stop(true) }
})

test('外部请求 signal 会取消当前流及其执行', async () => {
    const { server, config } = service()
    try {
        const controller = new AbortController()
        const agent = Agent.create({ config })
        const run = agent.stream('请求', { signal: controller.signal })
        controller.abort()
        await expect(run.result).rejects.toThrow()
        expect(agent.running).toBeNull()
    } finally { server.stop(true) }
})

test('执行失败时输出 error 事件，同时 result 拒绝', async () => {
    const run = Agent.create().stream('没有配置模型')
    const events = []
    for await (const event of run.events) events.push(event)
    expect(events.at(-1).type).toBe('error')
    expect(events.at(-1).data.message).toContain('model')
    await expect(run.result).rejects.toThrow()
})

test('读取到工具输出后关闭网页响应，会终止工具并保存取消结果', async () => {
    const server = Bun.serve({
        port: 0,
        fetch: () => Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'live-tool', type: 'function', function: { name: 'chatty', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: {} }),
    })
    const agent = Agent.create({ config: { baseURL: `http://127.0.0.1:${server.port}/v1`, model: 'm', stream: false }, tools: await Agent.tool.scan(new URL('./fixtures/limits', import.meta.url)) })
    try {
        const run = agent.stream('运行工具')
        const reader = run.response().body.getReader()
        let text = ''
        while (!text.includes('tool-output')) {
            const { value, done } = await reader.read()
            if (done) throw new Error('工具开始输出前就结束了')
            text += new TextDecoder().decode(value)
        }
        await reader.cancel()
        await expect(run.result).rejects.toThrow()
        expect(agent.running).toBeNull()
        expect(agent.history.at(-1).role).toBe('tool')
        expect(agent.history.at(-1).content[0].output.type).toBe('error-text')
    } finally { await agent.stop(); server.stop(true) }
})

test('流式监听器抛错只失败一次，不反复重试模型', async () => {
    const { server, config, calls } = service()
    try {
        const run = Agent.create({ config, callbacks: { onLLMEvent(event) { if (event.type === 'text-delta') throw new Error('界面处理失败') } } }).stream('你好')
        try { for await (const event of run.events) {} } catch {} // reader 接收到同一次失败。
        await expect(run.result).rejects.toThrow('界面处理失败')
        expect(calls).toHaveLength(1)
    } finally { server.stop(true) }
})
