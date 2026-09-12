/*
History 只创建“通用历史块”，不保存任何供应商专用字段。
Context.build() 会过滤 id、compact 等内部字段，只取 role 和 content 给 AI SDK。

// 1. 创建用户历史块
const userMessage = History.user({ content: '帮我写个爬虫' })
// 结果：{ id, role: 'user', content: '帮我写个爬虫' }

// 2. 创建 assistant 历史块
const assistantMessage = History.assistant({
    content: '好的',              // 普通文字；也可以传内容块数组
    toolCalls: [{                 // 可选，模型需要调用工具时传入
        id: 'call-1',
        name: 'finish',
        arguments: { result: '完成' }, // 支持对象，也支持 JSON 字符串
    }],
})

// 3. 创建工具结果历史块
const toolMessage = History.tool({
    toolCallId: 'call-1',
    toolName: 'finish',
    content: '工具执行结果',
})

// 4. 创建压缩总结历史块
const compactMessage = History.compact({ content: '之前的对话总结...' })

// 5. 需要完整内容块时，直接传 AI SDK 风格的 content 数组
const detailedMessage = History.assistant({
    content: [
        { type: 'reasoning', text: '我需要先调用工具。' },
        { type: 'text', text: '我先处理一下。' },
    ],
})
*/

import { nanoid } from 'nanoid'

// 统一检查字符串，避免历史里出现空的身份或内容。
const text = (value, name) => {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`)
    return value
}

// 每个历史块都有自己的 id；调用方传 id 时保留它，方便前端定位和更新消息。
const messageId = id => text(id ?? nanoid(), 'id')

// 字符串是最简单的写法；数组则原样保留 AI SDK 风格的内容块。
const contentParts = (content, name = 'content') => {
    if (Array.isArray(content)) return content
    if (content === null && name === 'assistant content') return []
    return [{ type: 'text', text: text(content, name) }]
}

// 创建用户历史块；Context.build() 最终会只取 role 和 content。
// content 既可以是一段纯文本，也可以是 AI SDK 风格的内容块数组——图片和文件就走数组这条路
// （AI SDK 的 UserContent 本来就是 string | Array<TextPart | ImagePart | FilePart>）。
const user = ({ id, content }) => {
    if (Array.isArray(content) && !content.length) throw new TypeError('content must not be an empty array') // 空消息会被供应商拒收。
    return { id: messageId(id), role: 'user', content: Array.isArray(content) ? content : text(content, 'content') }
}

// 创建 assistant 历史块；内容块和工具调用最终都放在同一个 content 数组里。
const assistant = ({ id, content = null, toolCalls = [] }) => ({
    id: messageId(id),
    role: 'assistant',
    content: [
        ...contentParts(content, 'assistant content'),
        ...toolCalls.map(({ id: callId, name, arguments: rawArguments, input }) => ({
            type: 'tool-call',
            toolCallId: text(callId, 'toolCalls[].id'),
            toolName: text(name, 'toolCalls[].name'),
            input: input ?? (typeof rawArguments === 'string' ? JSON.parse(text(rawArguments, 'toolCalls[].arguments')) : rawArguments),
        })),
    ],
})

// 创建工具结果历史块；toolCallId 必须和 assistant 的工具调用对应。
const tool = ({ id, toolCallId, toolName, content }) => ({
    id: messageId(id),
    role: 'tool',
    content: [{
        type: 'tool-result',
        toolCallId: text(toolCallId, 'toolCallId'),
        toolName: text(toolName, 'toolName'),
        output: typeof content === 'string' ? { type: 'text', value: text(content, 'content') } : content,
    }],
})

// 创建压缩总结块；它仍然是 user 角色，但 compact 标记让 Context 识别最新总结。
const compact = ({ id, content }) => ({ id: messageId(id), role: 'user', content: text(content, 'content'), compact: true })


// content 既可能是内容块数组，也可能是一段纯文本；纯文本里不会有工具调用。
const parts = message => (Array.isArray(message.content) ? message.content : [])


// --- 把平铺历史折成回合 ---
// 一个回合 = 用户的一次发言，或模型的一次响应连同它发起的全部工具调用与结果。
// 工具结果认的是发起它的 toolCallId，不是它在数组里排在谁后面，所以先把回合拼出来、
// 登记完每个回合欠下的调用，第二趟再统一分配结果——一趟边填边查会退化成"只有排在调用
// 后面的结果才认得出来"，历史被外部乱序拼接或按 id 从库里恢复时，结果会被悄悄丢掉。
//
// Context 裁剪上下文用它，上层要数"聊了几轮"、"取最近三个来回"也用它。
// 这条规则微妙，不暴露出去的话每个调用方都会自己推一遍，而且大概率推错。
const turns = history => {
    const list = []                                                                  // 回合列表：每个回合是一组永不拆开的消息。
    const caller = new Map()                                                         // toolCallId → 发起它的那个回合，工具结果靠这张表回家。
    let open = null                                                                  // 正在累积的模型响应；遇到工具结果或新的用户消息就收口。

    // --- 第一趟：拼回合，并登记每个回合欠下的工具调用 ---
    for (const message of history) {
        if (message.role === 'tool') { open = null; continue }                        // 工具结果自己不开回合，但它意味着上一轮响应已经说完了。

        if (message.role === 'assistant' && open) open.push(message)                  // 同一次响应拆成的多条 assistant（思考、文字、调用）属于同一个回合。
        else {
            open = message.role === 'assistant' ? [message] : null                    // user 和总结各自独占一个回合，不接纳后续消息。
            list.push(open ?? [message])
        }

        for (const part of parts(message)) if (part.type === 'tool-call') caller.set(part.toolCallId, list.at(-1))
    }

    // --- 第二趟：工具结果按 id 回到发起它的回合，跟它排在谁后面完全无关 ---
    for (const message of history) {
        if (message.role !== 'tool') continue
        caller.get(parts(message)[0]?.toolCallId)?.push(message)                      // 找不到发起者的结果不构成任何回合，自然消失。
    }

    return list
}


// 一个工具输出块长什么样是这个包定义的（text / json / content / error-text / …），
// 所以"怎么把它变成一句人能看的话"也该由这个包回答，而不是让每个调用方照着内部结构重写。
const readOutput = output => output?.type === 'content' ? output.value.map(part => part.type === 'text' ? part.text : `[${part.type}]`).join(' ')
    : typeof output?.value === 'string' ? output.value
    : JSON.stringify(output?.value ?? output)

// 每种内容块显示成什么样。思考和媒体折叠成一个标记，正文原样出。
const readPart = {
    text: part => part.text,
    reasoning: () => '[思考]',
    'tool-call': part => `[调用 ${part.toolName} ${JSON.stringify(part.input ?? {})}]`,
    'tool-result': part => `[${part.toolName} 返回] ${readOutput(part.output)}`,
    image: () => '[图片]',
    file: () => '[文件]',
}


// --- 把历史渲染成人能读的一段文本 ---
// IM 里回显、UI 里展示、日志里记录"刚才发生了什么"，都要先把内容块摊平成文字。
// 哪些块该显示、哪些该折叠，这份知识本来就在这个文件里；不暴露的话每个嵌入方都要
// 照着内部结构重写一遍，而且会随着内容块类型增加而悄悄过时。
// 想自己排版的，用 turns() 拿回合，再按下面这些块类型自己拼。
const render = history => history
    .map(message => `${message.role}: ${Array.isArray(message.content)
        ? message.content.map(part => (readPart[part.type] ?? (one => `[${one.type}]`))(part)).join(' ')
        : message.content}`)
    .join('\n')


export default { user, assistant, tool, compact, turns, render }
