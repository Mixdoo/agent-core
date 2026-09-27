/*
MCP 工具的连接与调用，只在工具子进程中使用。
外部入口是 Agent.tool.mcp({ transport: { type: 'http', url }, prefix: 'search_' })。

每次发现或调用都打开独立连接，并在结束后关闭。这样一个调用被杀不会切断另一个调用。
连接配置必须能跨进程序列化；HTTP headers、stdio command / args / env 都是普通数据。
不接收主进程的客户端对象、OAuth 回调或闭包。需要登录时先由调用方取得 token，再放进 headers。
这条路径适合无会话状态的工具；跨工具共享服务端 session 的流程需要由服务端用业务 ID 保存状态。
取消会终止本地执行进程，不能撤销远端已经完成的写入。
*/

import { createMCPClient } from '@ai-sdk/mcp' // 使用与本包 AI SDK 配套的 MCP 实现。
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio' // 本地服务通过标准输入输出通信。

// --- 发现工具或调用一个工具 ---
// 没有 name 表示发现工具；有 name 表示执行。协议解析、分页与媒体转换全部复用上游。
const run = async ({ transport, name }, input, onProcess) => {
    const connection = transport.type === 'stdio'
        ? new Experimental_StdioMCPTransport(transport)
        : transport // HTTP / SSE 配置由 SDK 建立连接。
    if (transport.type === 'stdio') {
        const start = connection.start.bind(connection)
        connection.start = async () => {
            await start()
            onProcess(connection.process.pid) // 固定版本 2.0.40 的 stdio transport 持有启动的进程；初始化未完成也要能强杀。
        }
    }
    let client // 初始化失败也要关闭已经启动的 stdio transport。
    try {
        client = await createMCPClient({ transport: connection, maxRetries: 0 }) // 不重复重试可能有副作用的工具。
        const tools = await client.tools() // SDK 自动读取所有分页，并建立标准工具定义。
        if (!name) return { output: { type: 'json', value: Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema.jsonSchema })) } } // 跨进程只送普通数据。

        const tool = tools[name] // 重连后按原始名字找工具，外部前缀不发给服务端。
        if (!tool) throw new Error(`MCP tool not found: ${name}`) // 服务端工具变更属于外部错误。
        const value = await tool.execute(input, { toolCallId: name, messages: [] }) // 真正的工具执行始终发生在子进程。
        if (value.isError) return { output: { type: 'error-json', value } } // 服务端返回的工具失败也交给模型处理。
        const output = await tool.toModelOutput({ output: value, input, toolCallId: name }) // 文字、图片等沿用 SDK 转换。
        if (output.type === 'content' && value.structuredContent !== undefined) output.value.push({ type: 'text', text: JSON.stringify(value.structuredContent) }) // MCP 结构化结果不丢弃。
        return { output }
    } finally { await (client ?? connection).close?.() } // 正常和初始化失败都清理本地连接。
}

export const MCP = { run } // 子进程按固定入口调用；打包后同一入口仍然存在。
