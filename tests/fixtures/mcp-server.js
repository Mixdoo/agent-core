/* stdio MCP 测试服务：bun tests/fixtures/mcp-server.js。按行读取 JSON-RPC。 */
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
    const message = JSON.parse(line)
    if (message.id === undefined) return
    let result
    if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stdio-test', version: '1' } }
    else if (message.method === 'tools/list') result = { tools: ['echo', 'wait'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: { value: { type: 'string' } } } })) }
    else if (message.method === 'tools/call') {
        if (message.params.name === 'wait') { writeFileSync(message.params.arguments.value, String(process.pid)); while (true) {} } // 真死循环，不能靠关闭 stdin 配合退出。
        result = { content: [{ type: 'text', text: message.params.arguments.value }] }
    }
    else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown' } }) + '\n'); return }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
})
lines.on('close', () => process.exit(0)) // 正常关闭连接后不留测试进程。
