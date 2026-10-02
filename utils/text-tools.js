/*
文字工具协议：让没有原生工具能力的模型（纯对话模型）也能使用工具。

原生的工具调用是接口层的一个字段：请求里带 tools，响应里回 tool_calls。
纯对话模型不认这个字段，它只输出文字。这个文件回答三件事：

1. prepare(tools)  把工具说明写成一段能放进 system 的文字，模型从文字里学会怎么"调用"。
2. parse(text, spec)  从模型输出的一段文字里，把工具调用读回来（读不回就是普通回答）。
3. downgrade(messages)  把标准历史里的 tool-call / tool-result 内容块降级成文字，
   因为纯对话接口不认 tool 角色，只认 user / assistant。

历史本身永远是标准形状（assistant 的 tool-call 块 + tool 角色的 tool-result 块），
这个文件只在"出门"和"进门"两个边界上做转换。所以同一个 Agent 中途换模型、
换协议都不会破坏历史，Loop / Context / turns 也一行都不用改。

格式（Roo Code / Cline 同样用带标签的文本，这里选 JSON 体是因为它能保住参数的原始类型，
不用像纯 XML 那样把 number / object / array 再猜回来）：

    <tool_call>
    {"name": "add", "arguments": {"a": 1, "b": 2}}
    </tool_call>

同一个回复里可以有多个块。工具结果用 <tool_result> 回给模型，也只有运行时会写这个标签。
*/

import { asSchema } from 'ai'
import { nanoid } from 'nanoid'


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
const cache = new WeakMap()

const jsonSchemaOf = async schema => {
    if (!schema) return undefined
    const resolved = asSchema(schema).jsonSchema
    return resolved && typeof resolved.then === 'function' ? await resolved : resolved
}

// 参数名 → 类型，用于把纯 XML 写法的字符串参数转回 number / boolean / object。
const typeMap = schema => schema?.properties
    ? Object.fromEntries(Object.entries(schema.properties).map(([name, one]) => [name, one?.type]))
    : {}

const prepare = tools => {
    if (!tools || !Object.keys(tools).length) return null
    if (cache.has(tools)) return cache.get(tools)

    const built = (async () => {
        const names = Object.keys(tools)
        const params = {}
        const lines = []
        for (const name of names) {
            const tool = tools[name]
            let schema
            try { schema = await jsonSchemaOf(tool.inputSchema) } catch { schema = undefined } // 工具 schema 坏掉不该拖垮整台 Agent，缺 schema 就用空参数。
            params[name] = typeMap(schema)
            lines.push(`- ${name}: ${tool.description ?? ''}${schema ? `\n  arguments: ${JSON.stringify(schema)}` : ''}`)
        }
        return { names, params, instructions: `${HEADER}\n${lines.join('\n')}` }
    })()

    cache.set(tools, built)
    return built
}


const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 去掉 ```json 围栏，模型经常习惯性套一层。
const stripFence = raw => raw.trim().replace(/^```(?:json|JSON)?\s*/,'').replace(/\s*```$/,'').trim()

const coerce = (value, type) => {
    if (type === 'number' || type === 'integer') { const n = Number(value); return Number.isNaN(n) ? value : n }
    if (type === 'boolean') return value === 'true'
    if (type === 'object' || type === 'array') { try { return JSON.parse(value) } catch { return value } }
    return value
}

// --- 一个 <tool_call> 块里的 JSON 体 ---
const readJson = raw => {
    const body = stripFence(raw)
    if (!body) return null

    let obj
    try { obj = JSON.parse(body) } catch {
        try { obj = JSON.parse(body.replace(/,\s*([}\]])/g, '$1')) } // 尾逗号是最常见的坏法，先修一次。
        catch { return { toolName: /"name"\s*:\s*"([^"]+)"/.exec(body)?.[1], input: {}, invalid: true, error: new Error('工具调用里的 JSON 解析失败') } }
    }
    if (Array.isArray(obj)) obj = obj[0]

    const fn = obj?.function ?? obj?.tool ?? obj
    const name = fn?.name ?? obj?.tool_name ?? obj?.tool_call?.name
    if (!name || typeof name !== 'string') return null

    let args = fn?.arguments ?? fn?.parameters ?? fn?.input ?? fn?.args ?? fn?.arguments_json
    if (typeof args === 'string') {
        try { args = JSON.parse(args) } catch { return { toolName: name, input: {}, invalid: true, error: new Error('工具参数不是合法的 JSON 字符串') } } // OpenAI 风格里 arguments 常是字符串。
    }
    if (args === undefined) {
        // 有的模型把参数平铺在同一层：{"name":"add","a":1,"b":2}。
        const { name: _, function: __, tool: ___, tool_name: ____, type: _____, tool_call: ______, ...rest } = obj
        args = Object.keys(rest).length ? rest : {}
    }
    return { toolName: name, input: args && typeof args === 'object' ? args : {} }
}

// --- Roo Code / Cline 风格：工具名做标签，参数做子标签 ---
// 兼容这一套是因为很多本地小模型被喂过这种样本，会本能地这么写。
const readXml = (inner, name, params = {}) => {
    const input = {}
    let found = false
    for (const child of inner.matchAll(/<([a-zA-Z_][\w-]*)>([\s\S]*?)<\/\1>/g)) {
        found = true
        input[child[1]] = coerce(child[2].trim(), params[child[1]])
    }
    if (found) return { toolName: name, input }

    const value = inner.trim()
    if (!value) return { toolName: name, input: {} }
    const keys = Object.keys(params)
    if (keys.length === 1) return { toolName: name, input: { [keys[0]]: coerce(value, params[keys[0]]) } }
    return { toolName: name, input: {}, invalid: true, error: new Error('工具参数格式无法识别') }
}

const overlaps = (ranges, index) => ranges.some(([start, end]) => index >= start && index < end)


// --- 从一段模型输出里读回工具调用 ---
// loose=true（文字模式）时额外认裸 JSON 代码块；native 兜底时只认显式标签，避免把讲解示例当成调用。
const parse = (text, spec, { loose = false } = {}) => {
    const source = typeof text === 'string' ? text : ''
    const calls = []
    const ranges = []
    const add = (call, start, end) => { calls.push({ call, start }); ranges.push([start, end]) }

    // 模型有时会自己编造工具结果。从这里往后全丢掉——把幻觉当上下文会让它以为工具真跑过了。
    const hallucinated = source.search(/<tool_result[\s>]/)
    const body = hallucinated >= 0 ? source.slice(0, hallucinated) : source

    const blockRe = /<tool_call>\s*([\s\S]*?)(?:<\/tool_call>|$)/g // 也容忍没闭合：模型被截断时最后一块就是这样。
    for (const match of body.matchAll(blockRe)) {
        const call = readJson(match[1])
        if (call) add(call, match.index, match.index + match[0].length)
    }

    for (const name of spec.names) {
        const tagRe = new RegExp(`<${escape(name)}>([\\s\\S]*?)<\\/${escape(name)}>`, 'g')
        for (const match of body.matchAll(tagRe)) {
            if (overlaps(ranges, match.index)) continue
            const call = readXml(match[1], name, spec.params[name])
            if (call) add(call, match.index, match.index + match[0].length)
        }
    }

    if (loose) {
        for (const match of body.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)) {
            if (overlaps(ranges, match.index)) continue
            const call = readJson(match[1])
            if (call && spec.names.includes(call.toolName)) add(call, match.index, match.index + match[0].length)
        }
    }

    let cleaned = body
    for (const [start, end] of [...ranges].sort((a, b) => b[0] - a[0])) cleaned = cleaned.slice(0, start) + cleaned.slice(end)
    return {
        text: cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
        calls: calls.sort((a, b) => a.start - b.start).map(one => one.call), // 按模型写下的先后顺序执行，而不是按工具表顺序。
    }
}


// --- 把工具输出块变成一段人/模型都能读的文字；媒体块原样保留（模型支持图就能继续看） ---
const outputBlocks = output => {
    if (!output) return []
    if (output.type === 'text' || output.type === 'error-text') return [{ type: 'text', text: output.value }]
    if (output.type === 'json') return [{ type: 'text', text: JSON.stringify(output.value) }]
    if (output.type === 'execution-denied') return [{ type: 'text', text: `execution denied: ${output.reason ?? ''}` }]
    if (output.type === 'content') return output.value.flatMap(part => part.type === 'text' ? [{ type: 'text', text: part.text }] : part.type === 'file' ? [{ type: 'file', mediaType: part.mediaType, data: part.data }] : [])
    return [{ type: 'text', text: JSON.stringify(output.value ?? output) }]
}

const asToolCallText = part => `<tool_call>\n${JSON.stringify({ name: part.toolName, arguments: part.input ?? {} })}\n</tool_call>`

// --- 出门前的降级：标准历史 → 纯对话接口认的 user / assistant 消息 ---
const downgrade = messages => {
    const out = []
    for (const message of messages) {
        if (message.role === 'system') { out.push(message); continue }

        if (message.role === 'tool') {
            const content = (Array.isArray(message.content) ? message.content : []).flatMap(part => {
                const blocks = outputBlocks(part.output)
                return [{ type: 'text', text: `<tool_result name="${part.toolName}">\n${blocks.filter(one => one.type === 'text').map(one => one.text).join('\n')}\n</tool_result>` }, ...blocks.filter(one => one.type !== 'text')]
            })
            out.push({ role: 'user', content })
            continue
        }

        if (message.role === 'assistant' && Array.isArray(message.content)) {
            const content = message.content.flatMap(part => part.type === 'tool-call' ? [{ type: 'text', text: asToolCallText(part) }] : [part])
            out.push({ ...message, content })
            continue
        }

        out.push(message)
    }

    // 相邻同角色合并：tool 结果降级后会和后面的 user 挨在一起，部分接口不接受连续的同角色消息。
    return out.reduce((list, message) => {
        const previous = list.at(-1)
        if (!previous || previous.role !== message.role || message.role === 'system') { list.push(message); return list }
        const asArray = one => Array.isArray(one.content) ? one.content : [{ type: 'text', text: String(one.content) }]
        previous.content = [...asArray(previous), ...asArray(message)]
        return list
    }, [])
}


// --- 给调用方（LLM.chat）统一的 id，和原生工具调用的形状保持一致 ---
const newCallId = () => `call_${nanoid(12)}`

export default { prepare, parse, downgrade, newCallId }
