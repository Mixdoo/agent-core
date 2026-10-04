/*
把一次工具调用的返回值变成模型能直接读的输出块。

调用：shape(tool, result, input)。示例：
    shape({}, '你好', {})                       // → { type: 'text', value: '你好' }
    shape({}, { a: 1 }, {})                     // → { type: 'json', value: { a: 1 } }
    shape({ toModelOutput: ({ output }) => output }, { output: { type: 'text', value: 'x' } }, {}) // 工具自己接管

主线程里的内存工具用它。文件工具在工具进程里做同一件事，那边有一份自己的副本
（tool-process.js 以文本喂进子进程、不能 import），改这里的规则时要同步改那边。

规则：
    1. 工具自带 toModelOutput 时优先用它把返回值变成块。
    2. 返回值自己就是成形的块（含合法 type）→ 原样。
    3. 空返回 → 一句交代，让模型知道工具跑成功了。
    4. 字符串 → 文字块；其余结构化值 → JSON 块。
形状不对时抛错，让这次调用变成一条正常的工具失败，而不是把非法块写进历史把会话毒死。

toModelOutput 的调用签名和 AI SDK 一致：toModelOutput({ output, input })。这样从 @ai-sdk/mcp
等客户端拿来的工具不用做任何包装，它们自带的 toModelOutput 直接生效。
*/

// AI SDK 认得的输出块类型。工具可以直接返回一个成形的块，认出来才不会给它再套一层 json。
export const BLOCK = new Set(['text', 'json', 'content', 'error-text', 'error-json', 'execution-denied'])

// content 块里允许出现的部件类型。不在这张表里的部件会被 AI SDK 在本地拒绝，
// 而且是请求根本发不出去的那种拒绝——一旦写进 history 就是永久的，所以在这里挡住。
export const PART = new Set(['text', 'image', 'audio', 'video', 'file', 'file-data', 'file-url'])

const shape = (tool, result, input) => {
    const value = result?.output ?? result                              // 工具可以返回 { output } 对象，也可以直接返回值。
    const output = tool.toModelOutput ? tool.toModelOutput({ output: value, input }) // AI SDK 的签名：把返回值和入参包成一个对象。
        : BLOCK.has(result?.output?.type) ? result.output               // 工具自己就给了成形的输出块——图片和多模态结果走的就是这条路。
        : value === undefined || value === null || value === '' ? { type: 'text', value: '工具执行成功，但没有输出' } // 空返回也给一句交代。
        : typeof value === 'string' ? { type: 'text', value }           // 返回字符串，直接当文字给模型。
        : { type: 'json', value }                                       // 其余结构化值转成 JSON 块。

    if (!BLOCK.has(output?.type)) throw new TypeError(`工具输出块的 type 不合法：${JSON.stringify(output?.type)}，只能是 ${[...BLOCK].join(' / ')}`)
    const bad = output.type === 'content' && output.value.find(part => !PART.has(part?.type))
    if (bad) throw new TypeError(`content 块里的 ${JSON.stringify(bad.type)} 部件不合法，只能是 ${[...PART].join(' / ')}。媒体可以用旧 image/audio/video，也可以用 AI SDK 当前的 file`)
    // 类型对了、字段缺了也不行：text 部件没 text、file 部件没 mediaType/data，写进 history 一样会让 AI SDK 本地拒收。
    const broken = output.type === 'content' && output.value.find(part => (part.type === 'text' && typeof part.text !== 'string') || (part.type === 'file' && (!part.mediaType || part.data == null)))
    if (broken) throw new TypeError(`content 块里的 ${JSON.stringify(broken.type)} 部件缺少必需字段：text 要有 text；file 要有 mediaType 和 data`)

    return JSON.parse(JSON.stringify(output)) // 只传纯 JSON：Date 变字符串、NaN 变 null、循环引用在这里变成一条正常的工具错误。
}

export default shape
