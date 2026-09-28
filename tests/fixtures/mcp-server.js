/* stdio MCP 测试服务：bun tests/fixtures/mcp-server.js。按行读取 JSON-RPC。 */
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'
const lines = createInterface({ input: process.stdin })
let keep = false // 用来验证拒绝正常退出的 MCP 服务也会被清理。
process.on('SIGTERM', () => { if (!keep) process.exit(0) })
lines.on('line', line => {
    const message = JSON.parse(line)
    if (message.id === undefined) return
    let result
    if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: 'stdio-test', version: '1' } }
    else if (message.method === 'tools/list') result = { tools: ['echo', 'wait', 'sticky'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: { value: { type: 'string' } } } })) }
    else if (message.method === 'tools/call') {
        if (message.params.name === 'wait') { writeFileSync(message.params.arguments.value, String(process.pid)); while (true) {} } // 真死循环，不能靠关闭 stdin 配合退出。
        if (message.params.name === 'sticky') { keep = true; setInterval(() => {}, 1000); message.params.arguments.value = String(process.pid) }
        result = { content: [{ type: 'text', text: message.params.arguments.value }] }
    }
    else if (message.method === 'prompts/list') result = { prompts: [{ name: 'greet', description: '打个招呼', arguments: [{ name: 'who', description: '称呼', required: true }] }] }
    else if (message.method === 'prompts/get') result = { messages: [{ role: 'user', content: { type: 'text', text: `你好 ${message.params.arguments.who}` } }] }
    else if (message.method === 'resources/list') result = { resources: [{ uri: 'note://demo', name: 'demo', description: '示例资源', mimeType: 'text/plain' }] }
    else if (message.method === 'resources/templates/list') result = { resourceTemplates: [] }
    else if (message.method === 'resources/read') result = { contents: [{ uri: message.params.uri, mimeType: 'text/plain', text: `资源内容：${message.params.uri}` }] }
    else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown' } }) + '\n'); return }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
})
lines.on('close', () => { if (!keep) process.exit(0) }) // sticky 故意忽略关闭，检测主进程是否真正清理。
