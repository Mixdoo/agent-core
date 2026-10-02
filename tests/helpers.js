/*
测试之间共用的夹具和断言工具。这个文件不叫 *.test.js，所以 bun test 不会把它当成测试文件。

放在这里的东西必须满足一条：它描述的是"这个项目的对外契约"，不是某一个模块的内部细节。
只被一个测试文件用到的辅助函数，直接写在那个文件里，不要搬过来——
共用文件一旦什么都装，改任何一处测试都得先读懂全部测试。
*/

import History from '../utils/history.js'

// 专门放"坏"工具的目录：会循环引用、会自杀、会死循环。scan 直接收 URL，不用自己拼路径。
export const BROKEN = new URL('./fixtures/broken', import.meta.url)
export const CYCLIC_FORMAT = new URL('./fixtures/cyclicformat', import.meta.url)  // 单独放一个目录，免得污染其它用例的工具表。
export const TOOLS = new URL('./fixtures/tools', import.meta.url)
export const MEDIA = new URL('./fixtures/media', import.meta.url)
export const LIMITS = new URL('./fixtures/limits', import.meta.url)
export const PROTO = new URL('./fixtures/proto', import.meta.url)  // 工具名故意叫 __proto__，验证工具表不会被写穿原型链。


// --- 造一段真实形态的历史：用户指令 + 若干轮工具调用 ---
export const withTurns = rounds => {
    const history = [History.user({ content: '帮我重构项目' })]
    for (let i = 1; i <= rounds; i += 1) {
        history.push(History.assistant({ content: null, toolCalls: [{ id: `call-${i}`, name: 'read', arguments: { path: `f${i}` } }] }))
        history.push(History.tool({ toolCallId: `call-${i}`, toolName: 'read', content: `文件${i}的内容` }))
    }
    return history
}


// --- 每条 tool 消息都必须能在它前面找到发起它的 tool-call，反之亦然 ---
// 供应商就是按这条规则校验的，配不上就是 400。这是"上下文合法"最硬的一条判据，
// 所以它跟着夹具一起共用，而不是让每个测试文件各写一遍。
export const pairing = messages => {
    const called = new Set()
    const answered = new Set()
    for (const message of messages) {
        if (!Array.isArray(message.content)) continue
        for (const part of message.content) {
            if (part.type === 'tool-call') called.add(part.toolCallId)
            if (part.type === 'tool-result') {
                if (!called.has(part.toolCallId)) return { ok: false, why: `孤儿工具结果 ${part.toolCallId}` } // 没人发起过它。
                answered.add(part.toolCallId)
            }
        }
    }
    const missing = [...called].find(id => !answered.has(id))
    return missing ? { ok: false, why: `工具调用 ${missing} 没有结果` } : { ok: true }
}


// --- 一个只会报错的假中转站：真实服务报错时就是这个形状 ---
// 它同时被 LLM 和压缩两条路径的测试用到，所以建在这里，调用方自己负责 stop。
// port 默认 0：让系统分配一个空闲端口。写死端口在 CI 并行跑时会偶发 EADDRINUSE，
// 把整条流水线堵住，而失败原因和被测代码毫无关系。
export const failingServer = (port = 0) => Bun.serve({
    port,
    fetch: () => Response.json({ error: { message: '上游负载已满', type: 'server_error' } }, { status: 503 }),
})


// --- 一个把收到的请求体记下来的假服务：用来确认我们到底发了什么字段 ---
export const echoServer = (port = 0) => {
    const recorded = []
    const server = Bun.serve({
        port,
        async fetch(request) {
            recorded.push(await request.json())
            return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }], usage: {} })
        },
    })
    return { server, recorded }
}

