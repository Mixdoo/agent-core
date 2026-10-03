/*
MCP：连上一个 MCP 服务，把它公开的东西变成和本地工具同一个形状的工具集合；再往上给 Agent 一组
带状态的槽位，启动即连、随时开关。

对调用方：

    const agent = Agent.create({
        config, tools,
        mcp: {
            web:   { transport: { type: 'http', url: 'http://localhost:3000/mcp' }, prefix: 'web_' },
            files: { transport: { type: 'stdio', command: 'bun', args: ['/abs/server.js'] }, enabled: false },
        },
    })
    await agent.mcp.ready()          // 等启动时的首批连接全部有结果
    agent.mcp.status()               // { web: { state: 'open', tools: 12 }, files: { state: 'closed' } }
    await agent.mcp.open('files')    // 连上，返回 { state: 'open', tools: 5 }；连不上返回 { state: 'error', error }
    await agent.mcp.close('web')     // 关掉，返回 { state: 'closed' }
    await agent.mcp.closeAll()

每个服务是一个槽位，状态只有四种：
  closed      没连，或已关闭；
  connecting  正在连；
  open        已连，它的工具对模型可见；
  error       连不上，错误写进状态交给上层，不抛异常。
连不上的服务停在 error，不会拖住 Agent；再次 open() 就是重试。

Agent 启动时先把自身建好并返回，再让每个 enabled 的服务后台连接（默认 enabled 为 true）。
send 的时候才把"本地工具 + 当前开着的 MCP 工具 + 技能工具"合成一张表，所以开关随时生效。

服务端公开的三种原语都会变成工具表里的条目，模型不需要区分来源：
  tools      → 每个远端工具变成一个工具；
  prompts    → 每个提示词模板变成一个工具，模型传参调用就取回这段提示；
  resources  → 合并成一个 read_resource 工具，参数是要读的 uri，可用地址写在描述里。
只问服务端声明支持的原语：没声明 resources / prompts 就不去问，问了会被拒，还会让整次连接失败。

执行不走工具子进程，按 MCP 自己的方式控制：
  取消 → 把 signal 交给 SDK，这次请求立刻结束；远端已经做完的事撤不回来。
  超时 → timeout（毫秒）交给 SDK，到点按失败返回。
  关闭 → close() 断开连接；stdio 服务会收到终止信号。
所以 Loop 拿到的结果和本地工具一样：正常是 { output }，失败是 { output, error }，取消是 { output, interrupted }。
*/

import { createMCPClient } from '@ai-sdk/mcp' // 使用与本包 AI SDK 配套的 MCP 实现。
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio' // 本地服务通过标准输入输出通信。
import { jsonSchema } from 'ai'

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

// --- 提示词模板的参数声明变成一份 JSON Schema ---
// MCP 的参数描述里只有名字、说明和是否必填，正好是一个对象 Schema 的全部内容。
const promptSchema = parameters => jsonSchema({
    type: 'object',
    properties: Object.fromEntries(parameters.map(one => [one.name, { type: 'string', ...(one.description ? { description: one.description } : {}) }])), // 每个参数都当字符串。
    required: parameters.filter(one => one.required).map(one => one.name), // 标了必填的才进 required。
})

// --- 服务端公开的资源写进工具描述，模型才知道有哪些地址可读 ---
// 资源和工具描述一样是连接时固定的；服务端资源变了要重新连一次。
const resourceTool = resources => ({
    description: `读取 MCP 服务端公开的资源，uri 从下面挑：\n${resources.map(one => `- ${one.uri}${one.template ? '（模板，占位符自行替换）' : ''}${one.description ? `：${one.description}` : ''}`).join('\n')}`, // 可用地址直接列给模型。
    inputSchema: jsonSchema({ type: 'object', properties: { uri: { type: 'string', description: '要读取的资源地址' } }, required: ['uri'] }),
})


// --- 执行一次：取消和超时都交给 SDK，结果变成和本地工具一样的形状 ---
// 正常返回 { output }；服务端说失败、或调用抛错，返回 { output, error }；被取消返回 { output, interrupted }。
const call = async (run, { signal, timeout }) => {
    if (signal?.aborted) return { output: { type: 'error-text', value: '工具执行已中断' }, interrupted: true } // 进来之前就已经取消了。
    try { return await run({ signal, ...(timeout ? { timeout } : {}) }) }
    catch (error) {
        if (signal?.aborted) return { output: { type: 'error-text', value: '工具执行已中断' }, interrupted: true } // 取消导致的失败按中断交回，模型知道这次没做完。
        return { output: { type: 'error-text', value: `工具执行失败：${error?.message || String(error)}` }, error: error?.message || String(error) } // 连接断了、服务端报错，都是这个工具没成功。
    }
}

// --- 一个远端工具：按原始名字调用，服务端说失败时也作为结果交给模型 ---
const remoteTool = (client, name) => options => call(async request => {
    const value = await client.callTool({ name, arguments: options.input ?? {}, options: request }) // 外部前缀不发给服务端。
    if (value.isError) return { output: { type: 'error-json', value }, error: '服务端返回了工具失败' } // 服务端返回的工具失败也交给模型处理。
    const parts = [...(value.content ?? []).map(block), ...(value.structuredContent !== undefined ? [{ type: 'text', text: JSON.stringify(value.structuredContent) }] : [])] // MCP 结构化结果不丢弃。
    return { output: { type: 'content', value: parts } }
}, options)

// --- 一段提示词：模板参数就是工具参数，取回来的消息带上角色，模型看得出这是谁说的话 ---
const remotePrompt = (client, name) => options => call(async request => {
    const got = await client.experimental_getPrompt({ name, arguments: options.input ?? {}, options: request })
    return { output: { type: 'content', value: got.messages.flatMap(one => [{ type: 'text', text: `${one.role}：` }, block(one.content)]) } } // 每条消息前面标上角色。
}, options)

// --- 读一个资源：地址由模型给出，这里不做白名单校验 ---
const remoteResource = client => options => call(async request => {
    const read = await client.readResource({ uri: options.input?.uri, options: request })
    return { output: { type: 'content', value: read.contents.map(block) } } // 内容可能是文字也可能是图，逐块转换。
}, options)


// --- 连一个 MCP 服务，返回和 Tool.scan 同一个形状的工具集合，外加 close ---
// signal 可取消这次握手；timeout 是调用方主动选择的单次调用超时，未设置就不加上限。
// 连不上时抛异常，由上面的 manager 收进槽位的 error 状态。
const connect = async ({ transport, prefix = '', signal, timeout }) => {
    const connection = transport.type === 'stdio' ? new Experimental_StdioMCPTransport(transport) : transport // 本地服务走标准输入输出，远端由 SDK 按配置建立 HTTP / SSE 连接。
    const client = await createMCPClient({ transport: connection, maxRetries: 0, initializationOptions: signal ? { signal } : undefined }) // 不重复重试可能有副作用的工具。
    try {
        const offers = client.initializeResult.capabilities // 服务端声明的能力，只读一次，后面全部信任它。
        const schema = Object.create(null)                  // 外部工具名不影响对象原型。
        const handlers = Object.create(null)
        const add = (name, description, run) => { schema[prefix + name] = description; handlers[prefix + name] = { run: options => run({ ...options, timeout }) } } // 多个服务用不同前缀就不会撞名。

        if (offers.tools) {
            const listed = await client.tools()   // SDK 自动读取所有分页，并建立标准工具定义。
            for (const [name, tool] of Object.entries(listed)) add(name, { description: tool.description, inputSchema: jsonSchema(tool.inputSchema.jsonSchema) }, remoteTool(client, name))
        }
        if (offers.prompts) {
            const prompts = await pages(cursor => client.experimental_listPrompts({ params: cursor ? { cursor } : undefined }), page => page.prompts) // 翻完所有页。
            for (const prompt of prompts) add(prompt.name, { description: prompt.description ?? `MCP 提示词 ${prompt.name}`, inputSchema: promptSchema(prompt.arguments ?? []) }, remotePrompt(client, prompt.name)) // 提示词和工具共用一个命名空间，同名时后发现的覆盖先发现的。
        }
        if (offers.resources) {
            const listed = await pages(cursor => client.listResources({ params: cursor ? { cursor } : undefined }), page => page.resources) // 列出的具体资源。
            const templates = (await client.listResourceTemplates()).resourceTemplates                                                            // 资源模板也要列给模型。
            const resources = [
                ...listed.map(one => ({ uri: one.uri, description: one.description })),
                ...templates.map(one => ({ uri: one.uriTemplate, description: one.description, template: true })), // 模板的占位由模型自己填。
            ]
            if (resources.length) add('read_resource', resourceTool(resources), remoteResource(client)) // 服务端没公开资源时不多一个用不上的工具。
        }

        return { schema, handlers, close: () => client.close() } // 与 scan 相同的形状，多一个 close；Agent 无需区分工具来源。
    } catch (error) {
        await client.close() // 发现失败也要把已经建立的连接关掉，不留 stdio 服务。
        throw error
    }
}


// --- 一组 MCP 服务：每个是一个带状态的槽位，挂在 Agent 上，随时可开关 ---
const manager = (defs = {}) => {
    const slots = new Map()   // 服务名 → 槽位。

    // 一个槽位对外的样子：状态 + 错误（有的话）+ 工具数（开着才有）。
    const looks = slot => ({ state: slot.state, ...(slot.error ? { error: slot.error } : {}), ...(slot.state === 'open' ? { tools: Object.keys(slot.schema).length } : {}) })

    // 认不出的名字也返回状态，不抛异常。
    const unknown = name => ({ state: 'error', error: `未知的 MCP 服务 "${name}"` })

    // 连上一个槽位：已经开着直接返回；正在连就等同一个 Promise；否则开始连。
    const raise = slot => {
        if (slot.state === 'open') return Promise.resolve(looks(slot))
        if (slot.pending) return slot.pending
        slot.state = 'connecting'
        slot.error = null
        slot.abort = new AbortController() // 握手中途 close 时用它取消。
        slot.pending = connect({ transport: slot.def.transport, prefix: slot.def.prefix ?? '', timeout: slot.def.timeout, signal: slot.def.signal ?? slot.abort.signal })
            .then(connection => {
                slot.connection = connection
                slot.schema = connection.schema
                slot.handlers = connection.handlers
                slot.state = 'open'
            })
            .catch(error => {
                if (slot.abort.signal.aborted) slot.state = 'closed'                        // 是我们自己取消的，不算错误。
                else { slot.state = 'error'; slot.error = error?.message || String(error) } // 连不上：停在 error，交给上层。
            })
            .then(() => { slot.pending = null; return looks(slot) })
        return slot.pending
    }

    // 关掉一个槽位：握手中的先取消，已连的按 MCP 的方式关闭。
    const lower = async slot => {
        slot.abort?.abort()
        if (slot.pending) await slot.pending.catch(() => {})
        try { await slot.connection?.close() } catch { /* 服务可能已经自行退出。 */ }
        slot.connection = null
        slot.schema = Object.create(null)
        slot.handlers = Object.create(null)
        slot.state = 'closed'
        slot.error = null
        return looks(slot)
    }

    // 组装所有开着的服务，得到当前可用的 MCP 工具表。
    const tools = () => {
        const schema = Object.create(null)
        const handlers = Object.create(null)
        for (const slot of slots.values()) if (slot.state === 'open') {
            Object.assign(schema, slot.schema)       // 前缀已经在各槽位里加好了，这里直接合。
            Object.assign(handlers, slot.handlers)
        }
        return { schema, handlers }
    }

    // 建槽位；enabled 的立刻后台连接，结果用 status()/ready() 看。
    for (const [name, def] of Object.entries(defs)) {
        const slot = { name, def: def ?? {}, state: 'closed', error: null, schema: Object.create(null), handlers: Object.create(null), connection: null, pending: null, abort: null }
        slots.set(name, slot)
        if (slot.def.enabled !== false) raise(slot)
    }

    const status = name => name === undefined
        ? Object.fromEntries([...slots].map(([one, slot]) => [one, looks(slot)])) // 不带参数：全部服务的状态。
        : (slots.has(name) ? looks(slots.get(name)) : unknown(name))              // 带名字：这一个服务的状态。

    return {
        name: 'mcp',                                                                   // 便于上层认出这是 MCP 管理器。
        status,
        open: name => (slots.has(name) ? raise(slots.get(name)) : Promise.resolve(unknown(name))),   // 重试或打开某个服务。
        close: name => (slots.has(name) ? lower(slots.get(name)) : Promise.resolve(unknown(name))),  // 关掉某个服务。
        closeAll: () => Promise.all([...slots.values()].map(lower)).then(() => undefined),           // 全部关掉。
        ready: () => Promise.all([...slots.values()].map(slot => slot.pending).filter(Boolean)).then(() => status()), // 等启动首批连接结束。
        tools,                                                                          // 当前开着的服务合并出的工具表。
    }
}

export default { connect, manager }