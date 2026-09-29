/*
结构化结果从包内 schema 定义，到 HTTP 请求，再到 send 返回值的完整测试。
调用：bun test tests/output.test.js。流式和非流式使用同一份本地服务。
*/
import { test, expect } from 'bun:test'
import Agent from '../index.js'

// --- 模拟最终对象，也能先要求执行一个真实文件工具 ---
const service = (text, withTool = false) => {
    const bodies = []
    const server = Bun.serve({
        port: 0,
        async fetch(request) {
            const body = await request.json()
            bodies.push(body)
            const tool = withTool && bodies.length === 1
            const message = tool
                ? { role: 'assistant', content: null, tool_calls: [{ id: 'lookup', type: 'function', function: { name: 'echo', arguments: '{"value":"data"}' } }] }
                : { role: 'assistant', content: text }
            const finish_reason = tool ? 'tool_calls' : 'stop'
            if (!body.stream) return Response.json({ choices: [{ index: 0, message, finish_reason }], usage: {} })
            return new Response([
                `data: ${JSON.stringify({ choices: [{ index: 0, delta: tool ? { tool_calls: message.tool_calls.map(call => ({ ...call, index: 0 })) } : message }] })}\n\n`,
                `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason }], usage: {} })}\n\n`,
                'data: [DONE]\n\n',
            ].join(''), { headers: { 'Content-Type': 'text/event-stream' } })
        },
    })
    return { server, bodies, config: { baseURL: `http://127.0.0.1:${server.port}/v1`, model: 'test' } }
}

for (const stream of [false, true]) {
    test(`数组输出使用包内格式定义（stream=${stream}）`, async () => {
        const { server, config } = service('{"elements":[{"name":"A"},{"name":"B"}]}')
        try {
            const agent = Agent.create({ config: { ...config, stream, provider: { output: Agent.output.array({ element: Agent.schema.object({ name: Agent.schema.string() }) }) } } })
            expect((await agent.send('列出名字')).output).toEqual([{ name: 'A' }, { name: 'B' }])
        } finally { server.stop(true) }
    })

    test(`对象输出直接返回校验过的数据（stream=${stream}）`, async () => {
        const { server, bodies, config } = service('{"total":42}')
        try {
            const agent = Agent.create({ config: { ...config, stream, provider: { output: Agent.output.object({ schema: Agent.schema.object({ total: Agent.schema.number() }) }) } } })
            const result = await agent.send('计算总数')
            expect(result.output).toEqual({ total: 42 })
            expect(result.text).toBe('{"total":42}')
            expect(bodies).toHaveLength(1)
            expect(bodies[0].response_format.type).toBe('json_schema')
        } finally { server.stop(true) }
    })

    test(`结构化格式写在配置顶层的 output 里也能用（stream=${stream}）`, async () => {
        // 顶层 output 回答"要什么形状的结果"，比塞进 provider（生成参数）更好找；
        // provider.output 这条老写法继续保留，两者都写时以顶层为准。
        const { server, bodies, config } = service('{"total":7}')
        try {
            const agent = Agent.create({ config: { ...config, stream, output: Agent.output.object({ schema: Agent.schema.object({ total: Agent.schema.number() }) }) } })
            expect((await agent.send('计算总数')).output).toEqual({ total: 7 })
            expect(bodies[0].response_format.type).toBe('json_schema')
        } finally { server.stop(true) }
    })

    test(`工具轮不要求最终 JSON，工具完成后返回对象（stream=${stream}）`, async () => {
        const { server, bodies, config } = service('{"total":42}', true)
        try {
            const tools = await Agent.tool.scan(new URL('./fixtures/tools', import.meta.url))
            const agent = Agent.create({ tools, config: { ...config, stream, provider: { output: Agent.output.object({ schema: Agent.schema.object({ total: Agent.schema.number() }) }) } } })
            const result = await agent.send('先查工具再给出总数')
            expect(result.output.total).toBe(42)
            expect(bodies).toHaveLength(2)
            expect(agent.history.some(message => message.role === 'tool')).toBe(true)
        } finally { server.stop(true) }
    })

    test(`格式错误会返回错误，不进入无限网络重试（stream=${stream}）`, async () => {
        const { server, bodies, config } = service('{"total":"not a number"}')
        try {
            const agent = Agent.create({ config: { ...config, stream, provider: { output: Agent.output.object({ schema: Agent.schema.object({ total: Agent.schema.number() }) }) } } })
            await expect(agent.send('计算')).rejects.toThrow()
            expect(bodies).toHaveLength(1)
        } finally { server.stop(true) }
    })
}

test('压缩不继承任务的结构化输出格式', async () => {
    const { server, bodies, config } = service('普通总结')
    try {
        const agent = Agent.create({ history: [{ role: 'user', content: '之前的任务' }], config: { ...config, stream: false, provider: { output: Agent.output.object({ schema: Agent.schema.object({ total: Agent.schema.number() }) }) } } })
        expect(await agent.compact()).toBe('普通总结')
        expect(bodies[0].response_format).toBeUndefined()
        expect(agent.config.provider.output).toBeDefined() // 压缩本次覆盖不污染任务配置。
    } finally { server.stop(true) }
})
