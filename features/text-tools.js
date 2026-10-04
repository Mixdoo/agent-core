/*
文字工具协议：让没有原生工具能力的模型（纯对话模型）也能使用工具。

原生的工具调用是接口层的一个字段：请求里带 tools，响应里回 tool_calls。
纯对话模型不认这个字段，它只输出文字。Loop 在问模型的前后各调一次这里：

    const spec = await TextTools.prepare(tools)                    // 把工具表写成说明书
    const messages = TextTools.wrap(context.messages, spec)       // 说明书进 system，历史里的工具记录改写成文字
    const result = TextTools.read(await LLM.chat({ messages }), spec, { loose: true }) // 从回复文字里读回工具调用

auto 模式还要记住"哪个模型不认原生工具字段"，下次直接走文字：
    TextTools.refused(error)   // 这个错误是不是接口拒收了工具字段
    TextTools.remember(llm)    // 记住这个模型
    TextTools.remembered(llm)  // 这个模型是不是已经记住了

收进来、发出去的都是 AI SDK 的消息格式；history 本身永远是标准形状，
这个文件只在"出门"和"进门"两个边界上做转换，所以同一个 Agent 中途换模型、换协议都不会破坏历史。

格式（Roo Code / Cline 同样用带标签的文本，这里选 JSON 体是因为它能保住参数的原始类型，
不用像纯 XML 那样把 number / object / array 再猜回来）：

    <tool_call>
    {"name": "add", "arguments": {"a": 1, "b": 2}}
    </tool_call>

同一个回复里可以有多个块。工具结果用 <tool_result> 回给模型，也只有运行时会写这个标签。
*/

import { asSchema } from 'ai'
import { nanoid } from 'nanoid'
import History from './history.js' // 「消息内容怎么变成块数组」由 History 定义，这里直接用它的


// --- 给模型的说明书：一句话说清格式，再列出每个工具的 JSON Schema ---
const HEADER = `# Tool calling

You can use the tools listed at the end of this message. To call a tool, output exactly this block:

<tool_call>
{"name": "tool_name", "arguments": {"argument": "value"}}
</tool_call>

Rules:
- Put one JSON object inside each <tool_call> block. "name" is the tool name, "arguments" is an object of arguments.
- You may emit several <tool_call> blocks in one reply.
- After emitting tool calls, stop immediately and wait. The results come back in a message containing <tool_result> blocks.
- Never write a <tool_result> block yourself; only the runtime produces those.
- When no tool is needed, answer normally without any <tool_call> block.

Tools:`


// --- 工具 schema 是异步取出来的（zod 要现算），同一个工具表只算一次 ---
const cache = new WeakMap() // 工具表 → 已经算好的说明书；同一份工具表不会被算第二遍。

// 取出一个工具的 JSON Schema：zod 这类写法要现算，算出来的是 Promise，等它落地。
const jsonSchemaOf = async schema => {
    if (!schema) return undefined                                          // 工具没写参数描述，就当没有 schema。
    const resolved = asSchema(schema).jsonSchema                           // asSchema 把各种写法的 schema 统一成 JSON Schema。
    return resolved && typeof resolved.then === 'function' ? await resolved : resolved // 是 Promise 就等它，不是就直接用。
}

// 参数名 → 类型，用于把纯 XML 写法的字符串参数转回 number / boolean / object。
const typeMap = schema => schema?.properties
    ? Object.fromEntries(Object.entries(schema.properties).map(([name, one]) => [name, one?.type])) // 每个参数取它的 type。
    : {}                                                                                            // 没有 properties 就没有可转的参数。

// --- 把一张工具表写成给模型的说明书 ---
// 返回 { names, params, instructions }：
//   names        所有工具名，用来判断模型写的调用是不是真的存在
//   params       每个工具的参数名和类型，XML 写法靠它把 "7" 转回数字 7
//   instructions 要塞进 system 的那段文字
const prepare = tools => {
    if (!tools || !Object.keys(tools).length) return null // 没有工具就没有说明书，system 不用动。
    if (cache.has(tools)) return cache.get(tools)         // 算过就直接用，同一轮里模型可能请求很多次。

    const built = (async () => {
        const names = Object.keys(tools)                                        // 工具表里的所有名字。
        const params = {}                                                       // 工具名 → { 参数名: 类型 }。
        const lines = []                                                        // 说明书里一个工具占一行。
        for (const name of names) {
            const tool = tools[name]
            let schema
            try { schema = await jsonSchemaOf(tool.inputSchema) } catch { schema = undefined } // 工具 schema 坏掉不该拖垮整台 Agent，缺 schema 就用空参数。
            params[name] = typeMap(schema)                                                     // 记下这个工具的参数类型表。
            lines.push(`- ${name}: ${tool.description ?? ''}${schema ? `\n  arguments: ${JSON.stringify(schema)}` : ''}`) // 名字、说明、参数一起列出来。
        }
        return { names, params, instructions: `${HEADER}\n${lines.join('\n')}` }               // 说明书 = 格式说明 + 每个工具一行。
    })()

    cache.set(tools, built) // 先存进缓存再返回：它是 Promise，多个调用方等的是同一份。
    return built
}


// 把工具名里的特殊字符转义，才能安全地拼进正则（工具名一般是字母数字，这里是保险）。
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 去掉 ```json 围栏，模型经常习惯性套一层。开头和结尾各去一次。
const stripFence = raw => raw.trim().replace(/^```(?:json|JSON)?\s*/,'').replace(/\s*```$/,'').trim()

// 把 XML 里读到的字符串参数转回它该有的类型：schema 说这个参数是 number，就转成数字。
// 不转换的话，工具收到的 {"a": "1"} 和模型想表达的 {"a": 1} 对不上，工具可能算错。
const coerce = (value, type) => {
    if (type === 'number' || type === 'integer') { const n = Number(value); return Number.isNaN(n) ? value : n } // 转不动就原样留着。
    if (type === 'boolean') return value === 'true'                                                           // "true" → true。
    if (type === 'object' || type === 'array') { try { return JSON.parse(value) } catch { return value } }    // 嵌套结构按 JSON 解析。
    return value                                                                                              // 其余（string）原样返回。
}

// --- 一个 <tool_call> 块里的 JSON 体 ---
// 模型写出来的 JSON 不一定标准，这里尽量把它读出来；实在读不出来就返回一条"无效调用"，
// 让模型重写，而不是当成普通回答悄悄丢掉。
const readJson = raw => {
    const body = stripFence(raw)                                                                                  // 先去掉可能的 Markdown 围栏。
    if (!body) return null                                                                                         // 空的块，不算调用。

    let obj
    try { obj = JSON.parse(body) } catch {                                                                        // 先按标准 JSON 解析。
        try { obj = JSON.parse(body.replace(/,\s*([}\]])/g, '$1')) }                                              // 尾逗号是最常见的坏法，先修一次。
        catch { return { toolName: /"name"\s*:\s*"([^"]+)"/.exec(body)?.[1], input: {}, invalid: true, error: new Error('工具调用里的 JSON 解析失败') } } // 实在读不出来，至少把名字抠出来，让模型知道是哪次调用坏了。
    }
    if (Array.isArray(obj)) obj = obj[0] // 模型偶尔套一层数组，取第一个。

    // 工具名可能在几个不同的位置：标准写法直接在顶层，OpenAI 风格套一层 function。
    const fn = obj?.function ?? obj?.tool ?? obj
    const name = fn?.name ?? obj?.tool_name ?? obj?.tool_call?.name
    if (!name || typeof name !== 'string') return null // 读不出名字，就当这不是一次工具调用。

    // 参数也在几个位置，按常见程度依次找。
    let args = fn?.arguments ?? fn?.parameters ?? fn?.input ?? fn?.args ?? fn?.arguments_json
    if (typeof args === 'string') {
        try { args = JSON.parse(args) } catch { return { toolName: name, input: {}, invalid: true, error: new Error('工具参数不是合法的 JSON 字符串') } } // OpenAI 风格里 arguments 常是字符串。
    }
    if (args === undefined) {
        // 有的模型把参数平铺在同一层：{"name":"add","a":1,"b":2}。把名字相关的字段剔掉，剩下的就是参数。
        const { name: _, function: __, tool: ___, tool_name: ____, type: _____, tool_call: ______, ...rest } = obj
        args = Object.keys(rest).length ? rest : {}
    }
    return { toolName: name, input: args && typeof args === 'object' ? args : {} } // 参数必须是对象，不是就当成空参数。
}

// --- Roo Code / Cline 风格：工具名做标签，参数做子标签 ---
// 兼容这一套是因为很多本地小模型被喂过这种样本，会本能地这么写。例如：
//   <read_file><path>a.js</path></read_file>
// 子标签里的值是字符串，靠 coerce 按 schema 转回原来的类型。
const readXml = (inner, name, params = {}) => {
    const input = {}
    let found = false
    for (const child of inner.matchAll(/<([a-zA-Z_][\w-]*)>([\s\S]*?)<\/\1>/g)) {              // 逐个读出 <参数名>值</参数名>。
        found = true
        input[child[1]] = coerce(child[2].trim(), params[child[1]])                            // 按 schema 转类型。
    }
    if (found) return { toolName: name, input }                                                // 标准写法：每个参数一个子标签。

    const value = inner.trim()                                                                 // 没有子标签，标签体本身就是参数值。
    if (!value) return { toolName: name, input: {} }                                           // 空标签 = 没有参数的工具。
    const keys = Object.keys(params)
    if (keys.length === 1) return { toolName: name, input: { [keys[0]]: coerce(value, params[keys[0]]) } } // 只有一个参数时，把标签体直接当成它。
    return { toolName: name, input: {}, invalid: true, error: new Error('工具参数格式无法识别') }            // 多个参数却没有子标签，认不出来。
}

// 一个位置是否落在已经认出来的调用范围内——防止同一段文字被两种写法重复认领。
const overlaps = (ranges, index) => ranges.some(([start, end]) => index >= start && index < end)


// --- 从一段模型输出里读回工具调用 ---
// loose=true（文字模式）时额外认裸 JSON 代码块；native 兜底时只认显式标签，避免把讲解示例当成调用。
// 返回 { text, calls }：text 是摘掉调用之后的说明文字，calls 是读出来的调用（按模型写下的顺序）。
const parse = (text, spec, { loose = false } = {}) => {
    const source = typeof text === 'string' ? text : ''                                        // 模型什么都没说时按空串处理。
    const calls = []                                                                            // 认出来的调用，连它在原文里的位置一起记着，最后好按顺序排。
    const ranges = []                                                                           // 已经被认领的文字范围，避免重复。
    const add = (call, start, end) => { calls.push({ call, start }); ranges.push([start, end]) }

    // 模型有时会自己编造工具结果。从这里往后全丢掉——把幻觉当上下文会让它以为工具真跑过了。
    const hallucinated = source.search(/<tool_result[\s>]/)
    const body = hallucinated >= 0 ? source.slice(0, hallucinated) : source

    // 主格式：<tool_call>{...}</tool_call>。也容忍没闭合：模型被截断时最后一块就是这样。
    const blockRe = /<tool_call>\s*([\s\S]*?)(?:<\/tool_call>|$)/g
    for (const match of body.matchAll(blockRe)) {
        const call = readJson(match[1])
        if (call) add(call, match.index, match.index + match[0].length)
    }

    // Roo Code / Cline 风格：用每个已注册工具名当一个标签去匹配。
    for (const name of spec.names) {
        const tagRe = new RegExp(`<${escape(name)}>([\\s\\S]*?)<\\/${escape(name)}>`, 'g')
        for (const match of body.matchAll(tagRe)) {
            if (overlaps(ranges, match.index)) continue                                        // 已经在 <tool_call> 里认过了，跳过。
            const call = readXml(match[1], name, spec.params[name])
            if (call) add(call, match.index, match.index + match[0].length)
        }
    }

    // 宽松模式（文字模式）再认一层裸 JSON 代码块，但只认已注册的工具名，避免把举例当成真调用。
    if (loose) {
        for (const match of body.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)) {
            if (overlaps(ranges, match.index)) continue
            const call = readJson(match[1])
            if (call && spec.names.includes(call.toolName)) add(call, match.index, match.index + match[0].length)
        }
    }

    // 把认出来的调用从说明文字里删掉，剩下的才是模型真正想说的话。
    let cleaned = body
    for (const [start, end] of [...ranges].sort((a, b) => b[0] - a[0])) cleaned = cleaned.slice(0, start) + cleaned.slice(end) // 从后往前删，位置才不会错位。
    return {
        text: cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), // 删完之后收拾一下多余空行。
        calls: calls.sort((a, b) => a.start - b.start).map(one => one.call),        // 按模型写下的先后顺序执行，而不是按工具表顺序。
    }
}


// --- 把工具输出块变成一段人/模型都能读的文字；媒体块原样保留（模型支持图就能继续看） ---
// 工具的输出块有几种固定形状（见 tool-process.js 的 shape），这里一个个转成文字块。
// 媒体块不在这里转换格式：LLM.chat 出门前会统一把旧 image / audio / video 块转成 file。
const outputBlocks = output => {
    if (!output) return []                                                                                        // 没有输出就没有内容。
    if (output.type === 'text' || output.type === 'error-text') return [{ type: 'text', text: output.value }]      // 普通文字和报错文字，原样就是给模型看的。
    if (output.type === 'json') return [{ type: 'text', text: JSON.stringify(output.value) }]                     // 结构化结果转成 JSON 文字。
    if (output.type === 'execution-denied') return [{ type: 'text', text: `execution denied: ${output.reason ?? ''}` }] // 用户拒绝了这次调用。
    if (output.type === 'content') return output.value.map(part => part.type === 'text' ? { type: 'text', text: part.text } : part) // 多模态：文字照抄，媒体块原样留着。
    return [{ type: 'text', text: JSON.stringify(output.value ?? output) }]                                       // 兜底：整个序列化成文字。
}

// 把一次工具调用写回成模型当初写它的那种文字。
const asToolCallText = part => `<tool_call>\n${JSON.stringify({ name: part.toolName, arguments: part.input ?? {} })}\n</tool_call>`

// --- 出门前的降级：标准消息 → 纯对话接口认的 user / assistant 消息 ---
const downgrade = messages => {
    const out = []
    for (const message of messages) {
        if (message.role === 'system') { out.push(message); continue }

        if (message.role === 'tool') {
            // 一条工具结果消息可能带着多个结果块，每个都写成一段 <tool_result> 文字，媒体块跟着保留。
            const content = History.parts(message).flatMap(part => {
                const blocks = outputBlocks(part.output)
                const text = blocks.filter(one => one.type === 'text').map(one => one.text).join('\n')
                return [{ type: 'text', text: `<tool_result name="${part.toolName}">\n${text}\n</tool_result>` }, ...blocks.filter(one => one.type !== 'text')]
            })
            out.push({ role: 'user', content })
            continue
        }

        if (message.role === 'assistant') {
            // 标准消息里的工具调用块，在这里改写成模型当初写的那样一段文字。
            const content = History.parts(message).flatMap(part => part.type === 'tool-call' ? [{ type: 'text', text: asToolCallText(part) }] : [part])
            out.push({ ...message, content })
            continue
        }

        out.push(message)
    }

    // 相邻同角色合并：tool 结果降级后会和后面的 user 挨在一起，部分接口不接受连续的同角色消息。
    return out.reduce((list, message) => {
        const previous = list.at(-1)
        if (!previous || previous.role !== message.role || message.role === 'system') { list.push(message); return list } // 不同角色或不合并，原样放一条。
        list[list.length - 1] = { ...previous, content: [...History.parts(previous), ...History.parts(message)] } // 合并成一条新消息，不改调用方传进来的对象。
        return list
    }, [])
}


// --- 出门：说明书并进 system，工具记录改写成文字 ---
// Context 给出的消息开头可能有一条 system；有就把说明书接在它后面，没有就新加一条。
const wrap = (messages, spec) => {
    const [first, ...rest] = downgrade(messages)
    if (first?.role === 'system') return [{ ...first, content: [first.content, spec.instructions].filter(Boolean).join('\n\n') }, ...rest]
    return [{ role: 'system', content: spec.instructions }, ...(first ? [first] : []), ...rest]
}


// --- 进门：从模型回复的文字里读回工具调用，改写成和原生调用完全一样的结果形状 ---
// 历史里存的是标准 tool-call 块，Loop / Context / 下一轮无论走哪种协议都认得。
// 回复里已经有原生调用就原样返回：auto 模式下模型支持原生工具时不走这条路。
const read = (result, spec, options) => {
    if (result.toolCalls?.length) return result
    const parsed = parse(result.text, spec, options)
    if (!parsed.calls.length) return result // 没读到调用就是普通回答，原样返回，不动它。

    const toolCalls = parsed.calls.map(one => ({
        type: 'tool-call',
        toolCallId: `call_${nanoid(12)}`,              // 和原生工具调用的 id 形状一致。
        toolName: one.toolName ?? 'invalid_tool_call', // 坏块读不出名字时也要有名字，否则历史块不合法。
        input: one.input ?? {},
        ...(one.invalid ? { invalid: true, error: one.error } : {}),
    }))

    // 只替换 assistant 里的文字块，思考等其他块原样保留。
    const assistant = [...result.responseMessages].reverse().find(message => message.role === 'assistant')
    const kept = assistant ? History.parts(assistant).filter(part => part.type !== 'text' && part.type !== 'tool-call') : []
    const content = [...kept, ...(parsed.text ? [{ type: 'text', text: parsed.text }] : []), ...toolCalls.map(({ invalid, error, ...part }) => part)]
    const responseMessages = [...result.responseMessages.filter(message => message !== assistant), { role: 'assistant', content }]

    return { ...result, text: parsed.text, toolCalls, responseMessages, finishReason: 'tool-calls' }
}


// --- auto 模式：记住"这个模型不认原生工具字段"，同一模型之后直接走文字，不再撞墙 ---
// 进程级记忆：同一个进程里所有 Agent 共用，条目是模型的标识字符串，很小。
const refusing = new Set()
const modelName = ({ model, protocol, baseURL }) => typeof model === 'string' ? `${protocol}:${baseURL}:${model}` : `instance:${model.provider}:${model.modelId}` // 这里只用于记住"哪个模型拒收过原生工具"，和 tokens.js 的 modelKey 不是一回事。
const remember = llm => refusing.add(modelName(llm))
const remembered = llm => refusing.has(modelName(llm))

// 这个错误是不是接口拒收了工具字段：必须是请求被拒（4xx）或服务端报错（5xx），
// 而且错误信息里确实提到 tool / function——不能只凭一个 4xx 就认定，否则上下文超长、
// 参数写错这类和工具无关的 400 也会让这个模型在本进程里被永久降级成文字协议。
const refused = error => (error?.kind === 'request' || error?.kind === 'server') && /tool|function/i.test(`${error.message ?? ''} ${error.responseBody ?? ''}`)

export default { prepare, parse, downgrade, wrap, read, refused, remember, remembered }
