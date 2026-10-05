/* 这个文件管最小可运行的 agent 示例：起一个假的 OpenAI 兼容模型，
   用"文件工具 + 内存工具"跑通一次完整循环，全程离线、不需要任何 API 密钥。

   运行（Bun 直接跑仓库源码，不需要 build，也不需要 npm install 依赖）：

       bun examples/minimal/main.js

   循环过程：问模型 → 模型要求调用 say_hello → 执行工具 → 把结果再喂给模型 → 模型给出文字。
*/

import Agent from '../../index.js' // 直接 import 仓库源码入口，Bun 会就地编译运行，不用打包。

// --- 假模型：一个最小的 OpenAI 兼容接口，只按"有没有收到工具结果"回两种回答 ---
// 第一次收到请求时消息里还没有 role=tool，就回一个 tool_calls（要调 say_hello）；
// 收到工具结果后（消息里出现 role=tool）就回一段文字。这样循环一定能走完。
const server = Bun.serve({
    port: 0, // 0 让系统分配空闲端口，避免和别的程序抢端口。
    async fetch(request) {
        const { pathname } = new URL(request.url)
        if (!pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })

        const body = await request.json()
        const answered = body.messages.some(message => message.role === 'tool')

        const message = answered
            ? { role: 'assistant', content: '招呼已经打完了，任务结束。' }
            : {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'say_hello', arguments: '{"who":"世界"}' } }],
            }

        return Response.json({
            choices: [{ index: 0, message, finish_reason: answered ? 'stop' : 'tool_calls' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
    },
})

// --- 两种工具来源拼在一起：目录里的文件工具 + 这里现写的内存工具 ---
// 用 new URL(..., import.meta.url) 拼目录，和当前工作目录无关，从哪运行都对。
const tools = await Agent.tool.from(
    new URL('./tools', import.meta.url), // 文件工具：扫描 say_hello（子进程执行）。
    {
        weather: { // 内存工具：直接写在 main.js 里，主进程内执行。
            description: '查询某个城市的天气',
            inputSchema: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
            },
            async execute(input) {
                return `${input.city}：晴，25 度`
            },
        },
    },
)

console.log('已注册工具：', Object.keys(tools.schema).join('、'))

// --- 创建 Agent：config 指向上面的假模型 ---
const agent = Agent.create({
    config: {
        baseURL: `http://127.0.0.1:${server.port}/v1`,
        apiKey: 'k',        // 假模型不校验，随便填一个。
        model: 'mock',
        stream: false,      // 用非流式，响应形状最简单。
        system: '你是一个助手，需要打招呼时请调用 say_hello 工具。',
        noToolRounds: 1,    // 优化演示：模型一停手就结束，循环只走"问 → 工具 → 再问"两轮。
    },
    tools,
    callbacks: {
        // 工具执行完的回调：打印工具名和它返回给模型的内容。
        onToolResult: result => console.log('工具执行完了：', result.toolName, '→', result.output.value),
    },
})

// --- 发指令，等循环结束 ---
// 有工具时 reason 通常是 'no-tool'（模型不再调工具就收手），这是这个包的正常出口。
const answer = await agent.send('请向世界打个招呼')
console.log(answer.text, answer.reason)

server.stop(true) // 用完关掉假模型，进程才能正常退出。
