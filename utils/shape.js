/*
把一次工具调用的返回值变成模型能直接读的输出块。

调用：await shape(tool, result, input, toolCallId)。示例：
    await shape({}, '你好', {}, 'c1')                       // → { type: 'text', value: '你好' }
    await shape({}, { a: 1 }, {}, 'c1')                     // → { type: 'json', value: { a: 1 } }
    await shape({ toModelOutput: ({ output }) => output }, { output: { type: 'text', value: 'x' } }, {}, 'c1') // 工具自己接管

主线程里的内存工具用它。文件工具在工具进程里做同一件事，那边有一份自己的副本
（tool-process.js 以文本喂进子进程、不能 import），改这里的规则时要同步改那边。

规则：
    1. 工具自带 toModelOutput 时优先用它把返回值变成块（可以是 async）。
    2. 返回值自己就是成形的块（含合法 type）→ 原样。
    3. 空返回 → 一句交代，让模型知道工具跑成功了。
    4. 字符串 → 文字块；其余结构化值 → JSON 块。
形状不对时抛错，让这次调用变成一条正常的工具失败，而不是把非法块写进历史把会话毒死。

toModelOutput 的调用签名和 AI SDK 一致：toModelOutput({ output, input, toolCallId })。
这样从 @ai-sdk/mcp 等客户端拿来的工具不用做任何包装，它们自带的 toModelOutput 直接生效。
*/

// AI SDK 认得的输出块类型。工具可以直接返回一个成形的块，认出来才不会给它再套一层 json。
export const BLOCK = new Set(['text', 'json', 'content', 'error-text', 'error-json', 'execution-denied'])

// content 块里允许出现的部件类型。不在这张表里的部件会被 AI SDK 在本地拒绝，
// 而且是请求根本发不出去的那种拒绝——一旦写进 history 就是永久的，所以在这里挡住。
export const PART = new Set(['text', 'image', 'audio', 'video', 'file', 'file-data', 'file-url'])

// 一段媒体值能不能当内联数据：字符串（base64）、URL 对象、或二进制。别的（对象、数字）AI SDK 会拒收。
const isBytes = value => value instanceof Uint8Array || value instanceof ArrayBuffer || (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))
const okMedia = value => typeof value === 'string' || value instanceof URL || isBytes(value)
// file 块的 data 还可以是带标签的形状：{type:'data',data}（字符串/字节）或 {type:'url',url}（URL 对象或字符串）。
const okFileData = value => {
    if (okMedia(value)) return true
    if (!value || typeof value !== 'object' || value instanceof URL) return false
    if (value.type === 'data') return typeof value.data === 'string' || isBytes(value.data)
    if (value.type === 'url') return value.url instanceof URL || typeof value.url === 'string'
    return false
}
// 二进制要转成 base64 才能跨进程 / 进 JSON，否则会被 JSON.stringify 变成 {"0":..,"1":..} 的普通对象。
// URL 也会被 JSON.stringify 调 toJSON 变成字符串——这一步之后要重新校验，别让形状在“校验通过”和“真正发出”之间变样。
const jsonSafe = value => JSON.parse(JSON.stringify(value, (key, one) => one instanceof ArrayBuffer ? Buffer.from(new Uint8Array(one)).toString('base64') : one instanceof Uint8Array ? Buffer.from(one).toString('base64') : one))
// 一个内容块的值/字段是否不合法。PART 里的类型才会走到这里；两条公共检查先做，再按类型分派。
export const badPart = part => {
    if (part.mediaType !== undefined && typeof part.mediaType !== 'string') return true // mediaType / filename 非字符串：旧形状也一样要查。
    if (part.filename !== undefined && typeof part.filename !== 'string') return true
    if (part.type === 'text') return typeof part.text !== 'string'
    if (part.type === 'image') return !okMedia(part.image)
    if (part.type === 'audio') return !okMedia(part.audio)
    if (part.type === 'video') return !okMedia(part.video)
    if (part.type === 'file-data') return !okMedia(part.data)
    if (part.type === 'file-url') return !okMedia(part.url)
    return !okFileData(part.data) // file
}

const shape = async (tool, result, input, toolCallId) => {
    const value = result?.output ?? result                              // 工具可以返回 { output } 对象，也可以直接返回值。
    // 工具自带格式化时优先用它；AI SDK 允许它返回 Promise，所以 await（AI SDK 自己也 await）。
    const produced = tool.toModelOutput ? await tool.toModelOutput({ output: value, input, toolCallId })
        : BLOCK.has(result?.output?.type) ? result.output               // 工具自己就给了成形的输出块——图片和多模态结果走的就是这条路。
        : value === undefined || value === null || value === '' ? { type: 'text', value: '工具执行成功，但没有输出' } // 空返回也给一句交代。
        : typeof value === 'string' ? { type: 'text', value }           // 返回字符串，直接当文字给模型。
        : { type: 'json', value }                                       // 其余结构化值转成 JSON 块。

    // 先做纯 JSON 化（Date→字符串、NaN→null、二进制→base64、循环引用/函数→报错或丢字段），
    // 再对"真正要发出去的形状"做校验——不然会校验通过、发出去却是另一个形状。
    const output = jsonSafe(produced)

    if (!BLOCK.has(output?.type)) throw new TypeError(`工具输出块的 type 不合法：${JSON.stringify(output?.type)}，只能是 ${[...BLOCK].join(' / ')}`)
    // 顶层字段也必须齐：text/error-text 要字符串 value，json/error-json 要有 value，execution-denied 的 reason 若是给了就得是字符串。
    if ((output.type === 'text' || output.type === 'error-text') && typeof output.value !== 'string') throw new TypeError(`${output.type} 输出块必须有字符串 value`)
    if ((output.type === 'json' || output.type === 'error-json') && output.value === undefined) throw new TypeError(`${output.type} 输出块必须有 value`)
    if (output.type === 'execution-denied' && output.reason !== undefined && typeof output.reason !== 'string') throw new TypeError('execution-denied 输出块的 reason 必须是字符串')
    if (output.type === 'content' && !Array.isArray(output.value)) throw new TypeError('content 输出块的 value 必须是数组')
    const bad = output.type === 'content' && output.value.find(part => !PART.has(part?.type))
    if (bad) throw new TypeError(`content 块里的 ${JSON.stringify(bad.type)} 部件不合法，只能是 ${[...PART].join(' / ')}。媒体可以用旧 image/audio/video，也可以用 AI SDK 当前的 file`)
    // 类型对了、值也要对：各媒体部件的值必须是字符串 / URL / 二进制（file 的 data 还允许带标签），否则 AI SDK 本地拒收、毒死 history。
    const broken = output.type === 'content' && output.value.find(badPart)
    if (broken) throw new TypeError(`content 块里的 ${JSON.stringify(broken.type)} 部件的值不合法：text 要 text；媒体要是字符串 / URL / 二进制；file 的 data 还要 mediaType`)

    return output
}

export default shape
