/*
MCP 使用本地假服务验证完整协议路径，不需要联网或真实密钥。
调用：bun test tests/mcp.test.js。发现、执行、失败、取消都走真实工具子进程。
*/
import { test, expect } from 'bun:test'
import Agent from '../index.js'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// --- 同一台服务提供正常工具、失败工具和长期等待工具 ---
const service = () => {
    const calls = []
    const server = Bun.serve({
        port: 0,
        async fetch(request) {
            if (request.method !== 'POST') return new Response(null, { status: request.method === 'DELETE' ? 204 : 405 })
            const message = await request.json()
            if (message.id === undefined) return new Response(null, { status: 202 })
            let result
            if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
            else if (message.method === 'tools/list') result = { tools: ['echo', 'fail', 'wait'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: { value: { type: 'string' } } } })) }
            else if (message.method === 'tools/call') {
                calls.push(message.params)
                if (message.params.name === 'wait') await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))
                result = { content: [{ type: 'text', text: message.params.arguments.value ?? 'result' }], isError: message.params.name === 'fail' }
            } else return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
            return Response.json({ jsonrpc: '2.0', id: message.id, result })
        },
    })
    return { server, calls, transport: { type: 'http', url: `http://127.0.0.1:${server.port}/mcp` } }
}

test('发现的 MCP 工具能和本地工具合并，前缀不改变远端名字', async () => {
    const { server, calls, transport } = service()
    try {
        const remote = await Agent.tool.mcp({ transport, prefix: 'remote_' })
        const local = await Agent.tool.scan(new URL('./fixtures/tools', import.meta.url))
        const tools = Agent.tool.merge(local, remote)
        expect(Object.keys(tools.schema)).toContain('echo')
        expect(tools.schema.remote_echo.inputSchema.jsonSchema.type).toBe('object')
        const result = await Agent.tool.execute({ name: 'remote_echo', input: { value: 'hello' }, handlers: tools.handlers })
        expect(result.output).toEqual({ type: 'content', value: [{ type: 'text', text: 'hello' }] })
        expect(calls[0].name).toBe('echo')
        const failed = await Agent.tool.execute({ name: 'remote_fail', input: {}, handlers: tools.handlers })
        expect(failed.output.type).toBe('error-json')
    } finally { server.stop(true) }
})

test('取消长期等待的 MCP 调用后能够重新执行', async () => {
    const { server, calls, transport } = service()
    const controller = new AbortController()
    try {
        const tools = await Agent.tool.mcp({ transport })
        const pending = Agent.tool.execute({ name: 'wait', input: {}, handlers: tools.handlers, signal: controller.signal })
        // 等请求真正到达远端，再测取消；不能只取消一条还在排队的调用。
        const deadline = Date.now() + 3000
        while (!calls.length && Date.now() < deadline) await Bun.sleep(10)
        expect(calls).toHaveLength(1)
        const start = Date.now()
        controller.abort()
        expect((await pending).interrupted).toBe(true)
        expect(Date.now() - start).toBeLessThan(1000)
        const next = await Agent.tool.execute({ name: 'echo', input: { value: 'again' }, handlers: tools.handlers })
        expect(next.output.value[0].text).toBe('again')
    } finally { controller.abort(); server.stop(true) }
})

test('stdio 服务可发现和调用，描述和执行地址一起合并', async () => {
    const tools = await Agent.tool.mcp({ transport: { type: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-server.js', import.meta.url))] } })
    const result = await Agent.tool.execute({ name: 'echo', input: { value: 'stdio' }, handlers: tools.handlers })
    expect(result.output.value[0].text).toBe('stdio')
    const merged = Agent.tool.merge(tools, { schema: { echo: { description: 'replacement' } }, handlers: { echo: { url: 'replacement' } } })
    expect(merged.schema.echo.description).toBe('replacement')
    expect(merged.handlers.echo.url).toBe('replacement')
})

test('客户端函数不能作为 MCP 连接配置跨进程传递', async () => {
    await expect(Agent.tool.mcp({ transport: { type: 'http', url: 'http://localhost/mcp', authProvider: () => 'secret' } })).rejects.toThrow()
})

test('取消 stdio MCP 时真正杀掉不响应取消的本地服务', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'mcp-kill-'))
    const file = join(folder, 'pid')
    const controller = new AbortController()
    let pid
    try {
        const tools = await Agent.tool.mcp({ transport: { type: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-server.js', import.meta.url))] } })
        const pending = Agent.tool.execute({ name: 'wait', input: { value: file }, handlers: tools.handlers, signal: controller.signal })
        const deadline = Date.now() + 3000
        while (!await Bun.file(file).exists() && Date.now() < deadline) await Bun.sleep(10)
        pid = Number(await Bun.file(file).text())
        controller.abort()
        expect((await pending).interrupted).toBe(true)
        await Bun.sleep(50) // 操作系统回收进程句柄。
        expect(() => process.kill(pid, 0)).toThrow()
    } finally {
        controller.abort()
        if (pid) { try { process.kill(pid, 'SIGKILL') } catch {} } // 失败也只清理这条测试启动的进程。
        await rm(folder, { recursive: true, force: true })
    }
})
