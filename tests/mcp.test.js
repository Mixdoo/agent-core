/*
MCP 使用本地假服务验证完整协议路径，不需要联网或真实密钥。
调用：bun test tests/mcp.test.js。连接一次、复用到底；取消和超时按 MCP 自己的方式，不杀进程。
*/
import { test, expect } from 'bun:test'
import Agent from '../index.js'
import { fileURLToPath } from 'node:url'

const STDIO = { type: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-server.js', import.meta.url))] }

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

test('MCP 工具能和本地工具合并，前缀不改变远端名字；连接只建一次', async () => {
    const { server, calls, initialized, transport } = service()
    const remote = await Agent.mcp({ transport, prefix: 'remote_' })
    try {
        const local = await Agent.tool.scan(new URL('./fixtures/tools', import.meta.url))
        const tools = Agent.tool.merge(local, remote)
        expect(Object.keys(tools.schema)).toContain('echo')
        expect(tools.schema.remote_echo.inputSchema.jsonSchema.type).toBe('object')
        const result = await Agent.tool.execute({ name: 'remote_echo', input: { value: 'hello' }, handlers: tools.handlers })
        expect(result.output).toEqual({ type: 'content', value: [{ type: 'text', text: 'hello' }] })
        expect(calls[0].name).toBe('echo')                                // 发给服务端的是原始名字。
        const failed = await Agent.tool.execute({ name: 'remote_fail', input: {}, handlers: tools.handlers })
        expect(failed.output.type).toBe('error-json')                     // 服务端说失败，也作为结果交给模型。
        expect(initialized).toHaveLength(1)                               // 三次操作共用同一个连接。
    } finally { await remote.close(); server.stop(true) }
})

test('MCP、结构化结果可以在同一台 Agent 中组合', async () => {
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
    const tools = await Agent.mcp({ transport: remote.transport, prefix: 'web_' })
    try {
        const permissions = []
        const events = []
        const agent = Agent.create({
            tools,
            config: { baseURL: `http://127.0.0.1:${model.port}/v1`, model: 'test', stream: false, output: Agent.output.object({ schema: Agent.schema.object({ total: Agent.schema.number() }) }) },
            callbacks: { onPermission: call => { permissions.push(call.toolName); return true }, onStep: step => events.push(step) },
        })
        const result = await agent.send('调用工具后给出总数')
        expect(events).toHaveLength(2)                       // 第一轮调工具，第二轮收尾，每轮结束后通知一次。
        expect(events[0].toolResults).toHaveLength(1)         // 第一轮确实执行了 MCP 工具。
        expect(result.output).toEqual({ total: 42 })
        expect(permissions).toEqual(['web_echo'])
        expect(remote.calls).toHaveLength(1)
        expect(round).toBe(2)
    } finally { await tools.close(); model.stop(true); remote.server.stop(true) }
})

test('取消长期等待的 MCP 调用：立刻返回中断，连接还能继续用', async () => {
    const { server, calls, transport } = service()
    const controller = new AbortController()
    const tools = await Agent.mcp({ transport })
    try {
        const pending = Agent.tool.execute({ name: 'wait', input: {}, handlers: tools.handlers, signal: controller.signal })
        const deadline = Date.now() + 3000
        while (!calls.length && Date.now() < deadline) await Bun.sleep(10) // 等请求真正到达远端，再测取消。
        expect(calls).toHaveLength(1)
        const start = Date.now()
        controller.abort()
        expect((await pending).interrupted).toBe(true)
        expect(Date.now() - start).toBeLessThan(1000)
        const next = await Agent.tool.execute({ name: 'echo', input: { value: 'again' }, handlers: tools.handlers })
        expect(next.output.value[0].text).toBe('again')        // 同一个连接，取消之后照常可用。
    } finally { controller.abort(); await tools.close(); server.stop(true) }
})

test('设置 timeout 后，超时的 MCP 调用按失败返回', async () => {
    const { server, transport } = service()
    const tools = await Agent.mcp({ transport, timeout: 200 })
    try {
        const result = await Agent.tool.execute({ name: 'wait', input: {}, handlers: tools.handlers })
        expect(result.error).toBeTruthy()
        expect(result.output.value).toContain('工具执行失败')
    } finally { await tools.close(); server.stop(true) }
})

test('服务端的提示词和资源都变成同一张工具表里的条目', async () => {
    const { server, transport } = service()
    const remote = await Agent.mcp({ transport, prefix: 'web_' })
    try {
        expect(Object.keys(remote.schema)).toContain('web_greet')                    // 提示词模板。
        expect(remote.schema.web_greet.inputSchema.jsonSchema.required).toEqual(['who']) // 必填参数来自服务端声明。
        expect(remote.schema.web_read_resource.description).toContain('note://demo')  // 模型从描述里知道有哪些地址。
        expect(remote.schema.web_read_resource.description).toContain('note://{id}')  // 模板地址也列出来。

        const greeting = await Agent.tool.execute({ name: 'web_greet', input: { who: '世界' }, handlers: remote.handlers })
        const text = greeting.output.value.map(part => part.text).join('')
        expect(text).toContain('你好 世界')
        expect(text).toContain('user：')                     // 角色标签让模型知道这是谁说的话。

        const note = await Agent.tool.execute({ name: 'web_read_resource', input: { uri: 'note://demo' }, handlers: remote.handlers })
        expect(note.output.value[0].text).toContain('资源内容：note://demo')
    } finally { await remote.close(); server.stop(true) }
})

test('stdio 服务：工具、提示词、资源都能用，close 后服务进程退出', async () => {
    const tools = await Agent.mcp({ transport: STDIO })
    const result = await Agent.tool.execute({ name: 'pid', input: {}, handlers: tools.handlers }) // 服务返回自己的进程号。
    const pid = Number(result.output.value[0].text)
    try {
        expect(Object.keys(tools.schema)).toEqual(expect.arrayContaining(['echo', 'greet', 'read_resource']))
        expect((await Agent.tool.execute({ name: 'echo', input: { value: 'stdio' }, handlers: tools.handlers })).output.value[0].text).toBe('stdio')
        const greeting = await Agent.tool.execute({ name: 'greet', input: { who: 'stdio' }, handlers: tools.handlers })
        expect(greeting.output.value.map(part => part.text).join('')).toContain('你好 stdio')
        const note = await Agent.tool.execute({ name: 'read_resource', input: { uri: 'note://demo' }, handlers: tools.handlers })
        expect(note.output.value[0].text).toContain('资源内容：note://demo')
        expect(() => process.kill(pid, 0)).not.toThrow()      // 连接期间服务一直在跑，可以反复用。

        await tools.close()
        const deadline = Date.now() + 3000
        while (Date.now() < deadline) { try { process.kill(pid, 0); await Bun.sleep(20) } catch { break } }
        expect(() => process.kill(pid, 0)).toThrow()          // close 之后服务进程退出。
    } finally { try { process.kill(pid, 'SIGKILL') } catch {} }
})

test('MCP 输出和本地工具共用同一条截断规则', async () => {
    const { server, transport } = service()
    const tools = await Agent.mcp({ transport })
    try {
        const result = await Agent.tool.execute({ name: 'echo', input: { value: 'x'.repeat(5000) }, handlers: tools.handlers, limit: 1000 })
        expect(result.output.value[0].text.length).toBeLessThan(1200)
        expect(result.output.value[0].text).toContain('输出过长')
    } finally { await tools.close(); server.stop(true) }
})
