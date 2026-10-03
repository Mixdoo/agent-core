/*
MCP 使用本地假服务验证完整协议路径，不需要联网或真实密钥。
调用：bun test tests/mcp.test.js。启动即连、带状态、随时开关；连不上不抛异常。
*/
import { test, expect } from 'bun:test'
import Agent from '../index.js'
import { fileURLToPath } from 'node:url'

const STDIO = { type: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-server.js', import.meta.url))] }
const DEAD = { type: 'stdio', command: 'this-binary-does-not-exist-xyz', args: [] } // 连不上的服务。

// --- 同一台服务提供正常工具、失败工具和长期等待工具 ---
const service = () => {
    const calls = []
    const initialized = []
    const server = Bun.serve({
        port: 0,
        async fetch(request) {
            if (request.method !== 'POST') return new Response(null, { status: request.method === 'DELETE' ? 204 : 405 })
            const message = await request.json()
            if (message.id === undefined) return new Response(null, { status: 202 })
            let result
            if (message.method === 'initialize') { initialized.push(message.id); result = { protocolVersion: '2025-06-18', capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: 'fixture', version: '1' } } }
            else if (message.method === 'tools/list') result = { tools: ['echo', 'fail', 'wait'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: { value: { type: 'string' } } } })) }
            else if (message.method === 'tools/call') {
                calls.push(message.params)
                if (message.params.name === 'wait') await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))
                result = { content: [{ type: 'text', text: message.params.arguments.value ?? 'result' }], isError: message.params.name === 'fail' }
            }
            else if (message.method === 'prompts/list') result = { prompts: [{ name: 'greet', description: '打个招呼', arguments: [{ name: 'who', description: '称呼', required: true }] }] }
            else if (message.method === 'prompts/get') result = { messages: [{ role: 'user', content: { type: 'text', text: `你好 ${message.params.arguments.who}` } }] }
            else if (message.method === 'resources/list') result = { resources: [{ uri: 'note://demo', name: 'demo', description: '示例资源', mimeType: 'text/plain' }] }
            else if (message.method === 'resources/templates/list') result = { resourceTemplates: [{ uriTemplate: 'note://{id}', name: 'note', description: '按编号取笔记' }] }
            else if (message.method === 'resources/read') result = { contents: [{ uri: message.params.uri, mimeType: 'text/plain', text: `资源内容：${message.params.uri}` }] }
            else return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
            return Response.json({ jsonrpc: '2.0', id: message.id, result })
        },
    })
    return { server, calls, initialized, transport: { type: 'http', url: `http://127.0.0.1:${server.port}/mcp` } }
}

test('启动即连：create 时带上 mcp，ready 后状态是 open，工具进了工具表', async () => {
    const { server, initialized, transport } = service()
    const agent = Agent.create({ mcp: { web: { transport, prefix: 'web_' } } })
    try {
        const statuses = await agent.mcp.ready()
        expect(statuses.web.state).toBe('open')
        expect(statuses.web.tools).toBeGreaterThan(0)
        expect(agent.mcp.status('web').state).toBe('open')

        const handlers = agent.mcp.tools().handlers
        expect(Object.keys(handlers)).toContain('web_echo')
        const result = await Agent.tool.execute({ name: 'web_echo', input: { value: 'hi' }, handlers })
        expect(result.output).toEqual({ type: 'content', value: [{ type: 'text', text: 'hi' }] })
        expect(initialized).toHaveLength(1)              // 只握手一次。
    } finally { await agent.mcp.closeAll(); server.stop(true) }
})

test('连不上的服务停在 error，不抛异常；ready 也照常返回', async () => {
    const agent = Agent.create({ mcp: { dead: { transport: DEAD }, web: { transport: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } } })
    try {
        const statuses = await agent.mcp.ready()
        expect(statuses.dead.state).toBe('error')        // 启动失败就是关闭状态，附上原因。
        expect(typeof statuses.dead.error).toBe('string')
        expect(statuses.web.state).toBe('error')         // 端口 1 连不上。
        expect(agent.mcp.status('dead').error).toBeTruthy()
    } finally { await agent.mcp.closeAll() }
})

test('enabled:false 启动时是 closed；手动 open 后变 open', async () => {
    const { server, transport } = service()
    const agent = Agent.create({ mcp: { web: { transport, prefix: 'web_', enabled: false } } })
    try {
        await agent.mcp.ready()
        expect(agent.mcp.status('web').state).toBe('closed')   // 没被启动。
        const opened = await agent.mcp.open('web')
        expect(opened.state).toBe('open')
        expect(agent.mcp.tools().schema.web_echo).toBeDefined()
    } finally { await agent.mcp.closeAll(); server.stop(true) }
})

test('close 后工具从工具表消失，再 open 又回来', async () => {
    const { server, transport } = service()
    const agent = Agent.create({ mcp: { web: { transport, prefix: 'web_' } } })
    try {
        await agent.mcp.ready()
        expect(agent.mcp.tools().schema.web_echo).toBeDefined()
        const closed = await agent.mcp.close('web')
        expect(closed.state).toBe('closed')
        expect(agent.mcp.tools().schema.web_echo).toBeUndefined() // 关掉的服务，工具模型看不到。
        expect((await agent.mcp.open('web')).state).toBe('open')
        expect(agent.mcp.tools().schema.web_echo).toBeDefined()
    } finally { await agent.mcp.closeAll(); server.stop(true) }
})

test('认不出的名字：open/close 返回 error 状态，不抛', async () => {
    const agent = Agent.create({})
    expect((await agent.mcp.open('nope')).state).toBe('error')
    expect((await agent.mcp.close('nope')).error).toContain('未知')
    expect(agent.mcp.status('nope').state).toBe('error')
    expect(agent.mcp.status()).toEqual({})         // 没有服务时是空表。
})

test('开着的 MCP 工具和本地工具合并，前缀不改变远端名字', async () => {
    const { server, calls, transport } = service()
    const agent = Agent.create({ mcp: { remote: { transport, prefix: 'remote_' } } })
    try {
        await agent.mcp.ready()
        const local = await Agent.tool.scan(new URL('./fixtures/tools', import.meta.url))
        const tools = Agent.tool.merge(local, agent.mcp.tools())
        expect(tools.schema.echo).toBeDefined()                    // 本地工具还在。
        expect(tools.schema.remote_echo.inputSchema.jsonSchema.type).toBe('object')
        const result = await Agent.tool.execute({ name: 'remote_echo', input: { value: 'hello' }, handlers: tools.handlers })
        expect(result.output).toEqual({ type: 'content', value: [{ type: 'text', text: 'hello' }] })
        expect(calls[0].name).toBe('echo')                         // 发给服务端的是原始名字。
        const failed = await Agent.tool.execute({ name: 'remote_fail', input: {}, handlers: tools.handlers })
        expect(failed.output.type).toBe('error-json')              // 服务端说失败，也作为结果交给模型。
    } finally { await agent.mcp.closeAll(); server.stop(true) }
})

test('模型能通过 send 调用 MCP 工具，并拿到结构化结果', async () => {
    const remote = service()
    let round = 0
    const model = Bun.serve({
        port: 0,
        fetch() {
            round += 1
            const message = round === 1
                ? { role: 'assistant', content: null, tool_calls: [{ id: 'remote-call', type: 'function', function: { name: 'web_echo', arguments: '{"value":"data"}' } }] }
                : { role: 'assistant', content: '{"total":42}' }
            return Response.json({ choices: [{ index: 0, message, finish_reason: round === 1 ? 'tool_calls' : 'stop' }], usage: {} })
        },
    })
    const agent = Agent.create({
        mcp: { web: { transport: remote.transport, prefix: 'web_' } },
        config: { baseURL: `http://127.0.0.1:${model.port}/v1`, model: 'test', stream: false, output: Agent.output.object({ schema: Agent.schema.object({ total: Agent.schema.number() }) }) },
    })
    try {
        await agent.mcp.ready()
        const result = await agent.send('调用工具后给出总数')
        expect(result.output).toEqual({ total: 42 })
        expect(remote.calls).toHaveLength(1)
        expect(round).toBe(2)
    } finally { await agent.mcp.closeAll(); model.stop(true); remote.server.stop(true) }
})

test('取消长期等待的 MCP 调用：立刻返回中断，连接还能继续用', async () => {
    const { server, calls, transport } = service()
    const agent = Agent.create({ mcp: { web: { transport } } })
    const controller = new AbortController()
    try {
        await agent.mcp.ready()
        const handlers = agent.mcp.tools().handlers
        const pending = Agent.tool.execute({ name: 'wait', input: {}, handlers, signal: controller.signal })
        const deadline = Date.now() + 3000
        while (!calls.length && Date.now() < deadline) await Bun.sleep(10) // 等请求真正到达远端，再测取消。
        expect(calls).toHaveLength(1)
        const start = Date.now()
        controller.abort()
        expect((await pending).interrupted).toBe(true)
        expect(Date.now() - start).toBeLessThan(1000)
        const next = await Agent.tool.execute({ name: 'echo', input: { value: 'again' }, handlers })
        expect(next.output.value[0].text).toBe('again')        // 取消之后连接照常可用。
    } finally { controller.abort(); await agent.mcp.closeAll(); server.stop(true) }
})

test('设置 timeout 后，超时的 MCP 调用按失败返回', async () => {
    const { server, transport } = service()
    const agent = Agent.create({ mcp: { web: { transport, timeout: 200 } } })
    try {
        await agent.mcp.ready()
        const result = await Agent.tool.execute({ name: 'wait', input: {}, handlers: agent.mcp.tools().handlers })
        expect(result.error).toBeTruthy()
        expect(result.output.value).toContain('工具执行失败')
    } finally { await agent.mcp.closeAll(); server.stop(true) }
})

test('服务端的提示词和资源都变成同一张工具表里的条目', async () => {
    const { server, transport } = service()
    const agent = Agent.create({ mcp: { web: { transport, prefix: 'web_' } } })
    try {
        await agent.mcp.ready()
        const handlers = agent.mcp.tools().handlers
        const schema = agent.mcp.tools().schema
        expect(Object.keys(schema)).toContain('web_greet')                    // 提示词模板。
        expect(schema.web_greet.inputSchema.jsonSchema.required).toEqual(['who']) // 必填参数来自服务端声明。
        expect(schema.web_read_resource.description).toContain('note://demo')  // 模型从描述里知道有哪些地址。

        const greeting = await Agent.tool.execute({ name: 'web_greet', input: { who: '世界' }, handlers })
        expect(greeting.output.value.map(part => part.text).join('')).toContain('你好 世界')
        const note = await Agent.tool.execute({ name: 'web_read_resource', input: { uri: 'note://demo' }, handlers })
        expect(note.output.value[0].text).toContain('资源内容：note://demo')
    } finally { await agent.mcp.closeAll(); server.stop(true) }
})

test('stdio 服务：closeAll 后服务进程退出', async () => {
    const agent = Agent.create({ mcp: { files: { transport: STDIO } } })
    await agent.mcp.ready()
    const result = await Agent.tool.execute({ name: 'pid', input: {}, handlers: agent.mcp.tools().handlers }) // 服务返回自己的进程号。
    const pid = Number(result.output.value[0].text)
    expect(() => process.kill(pid, 0)).not.toThrow()      // 连接期间服务一直在跑。
    await agent.mcp.closeAll()
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) { try { process.kill(pid, 0); await Bun.sleep(20) } catch { break } }
    expect(() => process.kill(pid, 0)).toThrow()          // 关掉之后服务退出。
})

test('MCP 输出和本地工具共用同一条截断规则', async () => {
    const { server, transport } = service()
    const agent = Agent.create({ mcp: { web: { transport } } })
    try {
        await agent.mcp.ready()
        const result = await Agent.tool.execute({ name: 'echo', input: { value: 'x'.repeat(5000) }, handlers: agent.mcp.tools().handlers, limit: 1000 })
        expect(result.output.value[0].text.length).toBeLessThan(1200)
        expect(result.output.value[0].text).toContain('输出过长')
    } finally { await agent.mcp.closeAll(); server.stop(true) }
})