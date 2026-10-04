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

const shape = async (tool, result, input, toolCallId) => {
    const value = result?.output ?? result                              // 工具可以返回 { output } 对象，也可以直接返回值。
    // 工具自带格式化时优先用它；AI SDK 允许它返回 Promise，所以 await（AI SDK 自己也 await）。
    const output = tool.toModelOutput ? await tool.toModelOutput({ output: value, input, toolCallId })
        : BLOCK.has(result?.output?.type) ? result.output               // 工具自己就给了成形的输出块——图片和多模态结果走的就是这条路。
        : value === undefined || value === null || value === '' ? { type: 'text', value: '工具执行成功，但没有输出' } // 空返回也给一句交代。
        : typeof value === 'string' ? { type: 'text', value }           // 返回字符串，直接当文字给模型。
        : { type: 'json', value }                                       // 其余结构化值转成 JSON 块。

    if (!BLOCK.has(output?.type)) throw new TypeError(`工具输出块的 type 不合法：${JSON.stringify(output?.type)}，只能是 ${[...BLOCK].join(' / ')}`)
    // 顶层字段也必须齐：text/error-text 要字符串 value，json/error-json 要有 value。缺了写进 history 会让 AI SDK 本地拒收。
    if ((output.type === 'text' || output.type === 'error-text') && typeof output.value !== 'string') throw new TypeError(`${output.type} 输出块必须有字符串 value`)
    if ((output.type === 'json' || output.type === 'error-json') && output.value === undefined) throw new TypeError(`${output.type} 输出块必须有 value`)
    const bad = output.type === 'content' && output.value.find(part => !PART.has(part?.type))
    if (bad) throw new TypeError(`content 块里的 ${JSON.stringify(bad.type)} 部件不合法，只能是 ${[...PART].join(' / ')}。媒体可以用旧 image/audio/video，也可以用 AI SDK 当前的 file`)
    // 类型对了、字段缺了也不行：各媒体部件缺必需字段，写进 history 一样会让 AI SDK 本地拒收。
    const broken = output.type === 'content' && output.value.find(part => {
        if (part.type === 'text') return typeof part.text !== 'string'
        if (part.type === 'image') return part.image == null
        if (part.type === 'audio') return part.audio == null
        if (part.type === 'video') return part.video == null
        if (part.type === 'file-data') return part.data == null
        if (part.type === 'file-url') return part.url == null
        return !part.mediaType || part.data == null // file
    })
    if (broken) throw new TypeError(`content 块里的 ${JSON.stringify(broken.type)} 部件缺少必需字段：text 要 text；image/audio/video 各自的字段；file-data 要 data；file-url 要 url；file 要 mediaType 和 data`)

    return JSON.parse(JSON.stringify(output)) // 只传纯 JSON：Date 变字符串、NaN 变 null、循环引用在这里变成一条正常的工具错误。
}

export default shape
