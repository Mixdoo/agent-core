/*
MCP 的连接与调用，只在工具子进程中使用。
外部入口是 Agent.tool.mcp({ transport: { type: 'http', url }, prefix: 'search_' })。

服务端公开的三种原语都会被接上，而且都变成同一个形状（工具集合），上层不需要再学一套东西：
  tools      → 每个远端工具变成一个本地工具；
  prompts    → 每个提示词模板变成一个本地工具，模型调用它就等于按参数取回这段提示；
  resources  → 服务端公开的资源合并成一个 read_resource 工具，参数是要读的 uri。
于是"这个服务端能用什么"只取决于它公开了什么，模型能调用的东西始终是一张工具表。

只问服务端声明支持的原语：resources / prompts 没声明就不去问，问了会被拒，还会让整次发现失败。

每次发现或调用都打开独立连接，并在结束后关闭。这样一个调用被杀不会切断另一个调用。
连接配置必须能跨进程序列化；HTTP headers、stdio command / args / env 都是普通数据。
不接收主进程的客户端对象、OAuth 回调或闭包。需要登录时先由调用方取得 token，再放进 headers。
这条路径适合无会话状态的工具；跨工具共享服务端 session 的流程需要由服务端用业务 ID 保存状态。
取消会终止本地执行进程，不能撤销远端已经完成的写入。
*/

import { createMCPClient } from '@ai-sdk/mcp' // 使用与本包 AI SDK 配套的 MCP 实现。
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio' // 本地服务通过标准输入输出通信。

// 二进制内容按本包统一的 file 块交给模型；服务端没给类型时用通用二进制类型。
const file = (mimeType, data) => ({ type: 'file', mediaType: mimeType ?? 'application/octet-stream', data: { type: 'data', data: data ?? '' } })

// --- 一个 MCP 内容块变成模型能读的输出块 ---
// 远端可能给文字、图片、内嵌资源或资源链接；协议以后加新块时兜底成原文，不静默丢弃。
const block = one => {
    if (one?.type === 'text') return { type: 'text', text: one.text }                                              // 文字原样。
    if (one?.type === 'image') return file(one.mimeType, one.data)                                                 // 图片变成 file 块，模型能看图就看得到。
    if (one?.type === 'resource') return one.resource?.text !== undefined ? { type: 'text', text: one.resource.text } : file(one.resource?.mimeType, one.resource?.blob) // 内嵌资源：有文字用文字，否则当文件。
    if (one?.type === 'resource_link') return { type: 'text', text: `[资源] ${one.uri}${one.description ? `：${one.description}` : ''}` } // 资源链接给模型一个可读的地址。
    return { type: 'text', text: JSON.stringify(one) }                                                             // 没见过的块，序列化后交出去，不丢。
}

// --- 翻完游标分页 ---
// 工具由 SDK 自己翻；资源和提示词是游标分页，由调用方翻，这里统一收口。
const pages = async (load, pick) => {
    const all = []                     // 攒下来的全部条目。
    let cursor                         // 下一页的游标；没有就是最后一页。
    while (true) {
        const page = await load(cursor) // 取一页。
        all.push(...pick(page))         // 只要这一页里我们需要的那部分。
        cursor = page.nextCursor        // 拿下一页的游标。
        if (!cursor) return all         // 没有下一页就结束。
    }
}

// --- 发现工具或调用一个工具 ---
// kind 决定这次连接要做哪件事，全部在子进程里完成；协议解析和媒体转换复用上游。
const run = async ({ transport, kind = 'discover', name }, input, onProcess) => {
    const connection = transport.type === 'stdio'                     // 本地服务走标准输入输出，远端走 HTTP / SSE。
        ? new Experimental_StdioMCPTransport(transport)
        : transport // HTTP / SSE 配置由 SDK 建立连接。
    if (transport.type === 'stdio') {
        // 本地服务起来之后，把它的进程号告诉主进程，取消时主进程靠它把服务一起杀掉。
        const start = connection.start.bind(connection)
        connection.start = async () => {
            await start()
            onProcess(connection.process.pid) // 固定版本 2.0.40 的 stdio transport 持有启动的进程；初始化未完成也要能强杀。
        }
    }
    let client // 初始化失败也要关闭已经启动的 stdio transport。
    try {
        client = await createMCPClient({ transport: connection, maxRetries: 0 }) // 不重复重试可能有副作用的工具。
        const offers = client.initializeResult.capabilities // 服务端声明的能力，只读一次，后面全部信任它。

        // --- 发现：把服务端公开的三种原语读回来，跨进程只送普通数据 ---
        if (kind === 'discover') {
            const value = { tools: [], prompts: [], resources: [] } // 三种原语各收一份。
            if (offers.tools) {
                const tools = await client.tools() // SDK 自动读取所有分页，并建立标准工具定义。
                value.tools = Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema.jsonSchema })) // 只留模型需要的那几项。
            }
            if (offers.prompts) {
                const prompts = await pages(cursor => client.experimental_listPrompts({ params: cursor ? { cursor } : undefined }), page => page.prompts) // 翻完所有页。
                value.prompts = prompts.map(one => ({ name: one.name, description: one.description, arguments: one.arguments ?? [] }))
            }
            if (offers.resources) {
                const listed = await pages(cursor => client.listResources({ params: cursor ? { cursor } : undefined }), page => page.resources) // 列出的具体资源。
                const templates = (await client.listResourceTemplates()).resourceTemplates                                                            // 资源模板也要列给模型。
                value.resources = [
                    ...listed.map(one => ({ uri: one.uri, name: one.name, description: one.description, mimeType: one.mimeType })),
                    ...templates.map(one => ({ uri: one.uriTemplate, name: one.name, description: one.description, mimeType: one.mimeType, template: true })), // 模板的占位由模型自己填。
                ]
            }
            return { output: { type: 'json', value } } // 发现结果就是一份纯数据，交给主进程。
        }

        // --- 读一个资源：地址由模型给出，这里不做白名单校验 ---
        if (kind === 'resource') {
            const read = await client.readResource({ uri: input.uri })
            return { output: { type: 'content', value: read.contents.map(block) } } // 内容可能是文字也可能是图，逐块转换。
        }

        // --- 取一段提示词：模板参数就是工具参数，取回来的消息带上角色，模型看得出这是谁说的话 ---
        if (kind === 'prompt') {
            const got = await client.experimental_getPrompt({ name, arguments: input })
            return { output: { type: 'content', value: got.messages.flatMap(one => [{ type: 'text', text: `${one.role}：` }, block(one.content)]) } } // 每条消息前面标上角色。
        }

        // --- 执行一个工具 ---
        const tools = await client.tools()
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