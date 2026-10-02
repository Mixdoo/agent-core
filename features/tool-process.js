/*
工具进程这一半：主线程把工具文件地址和执行参数发进来，这里加载工具、跑它、把结果成形成模型能读的输出块。
本文件不是普通模块，调用方不要 import 它——它没有任何导出，靠被 features/tool.js 当文本内联进一个新的 bun 进程才生效：

    import source from './tool-process.js' with { type: 'text' }   // tool.js 的写法
    const child = Bun.spawn(['bun', '-'], { stdin: 'pipe', ipc: handle })
    child.stdin.write(source); child.stdin.end()

隔着进程的约定是几条消息，工具作者和调用方都不需要手写它们：
    主线程 → 工具进程   { callId, url, name, input, limit }      执行哪个文件里的哪个工具，输出最多留多长
    主线程 → 工具进程   { callId, builtin, name, input, skills } 执行包内置的动作（目前只有按需加载技能）
    工具进程 → 主线程   { type: 'ready' }                        我起来了，可以派活
    工具进程 → 主线程   { callId, type: 'child', pid }           这次调用起了本地服务，取消时一起杀
    工具进程 → 主线程   { callId, type: 'output', stream, data } 工具产生了一段实时输出
    工具进程 → 主线程   { callId, type: 'done', output, stop }   跑完了，output 已经是模型能直接读的形态
    工具进程 → 主线程   { callId, type: 'error', message }       工具抛错了

它隔离的是生命周期，不是环境。工具在这里拥有和 Agent 完全相同的权限：
读写任意文件、执行任意命令、联网、读到父进程的全部环境变量（包括 apiKey）。
这是有意的——「电脑任务 agent」的工具本来就得能干这些，约束工具是上层的事，不是这个包的事。
它真正隔离的是四样：失控（死循环工具能被一刀杀掉）、崩溃（工具死了 Agent 继续）、
内存（独立堆）、以及 Agent 自己的状态（工具碰不到 history、config、running）。

为什么是子进程而不是 Worker 线程：Worker 被 terminate 之后 Bun 不归还它占的约 22MB，
而且杀线程带不走它 spawn 出来的孙进程（每个还活着、还在烧 CPU）。常驻 agent 天天要杀工具进程
（工具崩溃、工具超时、用户打断），于是两笔账都会一直累积。换成子进程之后，杀一次内存完整还给
操作系统、孙进程一起带走——实测 200 次「起→用→杀」主进程只涨 2MB，而 Worker 版是 4.4GB。

一个工具进程长期存活、一次只服务一次调用，所以每条消息都带 callId，主线程靠它认领结果。

工具文件默认导出一个工具或一组工具：

    export default {
        name: 'read',
        description: '读取文件',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        timeout: 30000,                                  // 可选，不写就一直等（阻塞型工具靠这个）
        async execute(input) { return await Bun.file(input.path).text() },
    }

工具作者不需要写任何流式输出代码：console.log 和 Bun.spawn 的子进程输出都会被自动转发；
execute 写成 async * 时，每个 yield 也会实时发出去。

约束（改这个文件时必须守住）：本文件内不能出现任何 import 或 require。
它以 stdin 喂进来的匿名程序身份运行，相对路径和裸包名会按进程当前目录解析、必然出错；
工具文件由主线程以绝对 file:// URL 传进来，不受这条限制影响。
*/


const encoder = new TextEncoder()               // 重放给工具的那一份要再变回字节流。
const KEEP = 8 << 20                            // 替工具留着的子进程输出上限（8MB）：正常构建/测试日志都装得下，工具永远不读时内存也有天花板。

let current = null                              // 当前正在执行的 callId；空闲时为 null。

// --- 把一段实时输出报给主线程 ---
// 空闲时直接丢弃：工具返回之后还在打日志（自己起了不 await 的后台任务），
// 那些输出不属于任何一次调用，发出去只会被记到下一次调用头上。
const report = (stream, data) => current && process.send({ callId: current, type: 'output', stream, data })


// --- 子进程输出：工具进程是唯一读者，读到的每段既发给主线程，也留一份给工具自己读 ---
// 不用 tee()：tee 的两路里只要有一路没人读，另一路读多少就在内存里堆多少，没有上限。
const relay = (source, stream) => {
    const decoder = new TextDecoder()                                   // 每条流各用一个解码器：共用的话，一个汉字被拆成两块时残留字节会拼到别的流上变成乱码。
    const kept = []                                                     // 留给工具读的副本，只保留尾部 KEEP 字节。
    let size = 0                                                        // 副本当前占用的字符数。
    let ended = false                                                   // 子进程这条流是否已经读完。
    let wake = null                                                     // 工具正等着新数据时，用它唤醒。

    void (async () => {                                                 // 后台一路读原始管道，读到什么就转发什么。
        try {
            for await (const chunk of source) {
                const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }) // 字节流转文字。
                report(stream, text)                                    // 实时转发给主线程，发完即走，不占内存。
                kept.push(text)                                         // 同一段也留给工具，它可能自己要读。
                size += text.length
                while (size > KEEP) size -= kept.shift().length         // 工具不读时丢最旧的，内存有明确上限。
                wake?.()                                                // 有新数据了，叫醒正在等的工具。
            }
        } catch {}                                                      // 管道被重置、孙进程被杀：当成流结束，不能让读这条流的工具永远等下去。
        ended = true                                                    // 子进程关流了，等待中的工具该收尾了。
        wake?.()
    })()

    // 工具拿到的是这份重放流，不是原始管道，所以原始管道永远只有一个读者。
    return new ReadableStream({
        async pull(controller) {
            while (!kept.length && !ended) await new Promise(resolve => { wake = resolve }) // 没有新数据就挂起，等 relay 唤醒。
            if (kept.length) controller.enqueue(encoder.encode(kept.shift()))               // 有数据就给它一段。
            else controller.close()                                     // 数据取完且子进程已结束，工具读到流尾。
        },
    })
}


// --- 劫持 Bun.spawn：工具照常写 spawn，子进程输出自动变成流式事件 ---
// 工具进程被杀时这些孙进程会跟着一起死，所以这里不需要额外做生命周期管理。
const spawn = Bun.spawn
Bun.spawn = (command, options = {}) => {
    const child = spawn(command, {
        ...options,
        stdout: options.stdout ?? 'pipe',                               // 工具自己指定了就不插手，那是它要自己读。
        stderr: options.stderr ?? 'pipe',
    })

    const stdout = child.stdout && relay(child.stdout, 'stdout')        // 接管这一路，工具改读重放流。
    const stderr = child.stderr && relay(child.stderr, 'stderr')

    return new Proxy(child, {                                          // 用代理把 stdout / stderr 换成重放流，其余照旧。
        get(target, property) {
            if (property === 'stdout') return stdout
            if (property === 'stderr') return stderr
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value // kill()、exited 这些照常可用。
        },
    })
}
const relaySpawn = Bun.spawn // 本地工具需要自动转发输出，MCP 的协议管道则由客户端独占。


// --- 劫持 console：工具里的 console.log 直接变成流式输出 ---
for (const name of ['log', 'info', 'warn', 'error']) {
    // 字符串原样输出，其余交给 Bun.inspect —— 和 console 自己的行为一致；
    // 不用 String()，它会被 Object.create(null) 这类没有 toString 的值抛穿，把跑成功的工具报成失败。
    console[name] = (...args) => report('console', args.map(value => typeof value === 'string' ? value : Bun.inspect(value)).join(' '))
}

// --- 异步生成器工具：每个 yield 立刻发出去，最后把全部片段作为返回值 ---
const collect = async result => {
    if (!result || typeof result[Symbol.asyncIterator] !== 'function') return result // 普通返回值，不用收集。
    const chunks = []                                                                 // 攒下每个 yield 出来的片段。
    for await (const chunk of result) {
        chunks.push(chunk)
        report('result', chunk)                                         // 逐段实时送达，上层不用等工具跑完。
    }
    return chunks                                                                     // 全部片段一起作为工具的返回值。
}


// AI SDK 认得的输出块类型。工具可以直接返回一个成形的块（README 里 finish 和截图工具都这么写），
// 认出来才不会给它再套一层 json —— 套了之后模型看到的是 {"type":"json","value":{"type":"text",...}}。
const BLOCK = new Set(['text', 'json', 'content', 'error-text', 'error-json', 'execution-denied'])

// content 块里允许出现的部件类型。不在这张表里的部件会被 AI SDK 在本地拒绝，
// 而且是在 standardizePrompt 里抛、请求根本发不出去、Retry 认不出来——一旦写进 history 就是永久的。
// 所以在这里挡住：非法块变成一条普通的工具失败，让模型知道并换个方式，而不是把会话毒死。
const PART = new Set(['text', 'image', 'audio', 'video', 'file', 'file-data', 'file-url'])


// --- 截断一段文本：头尾都留，开头说明这是什么，结尾通常是结论或报错 ---
const cut = (text, limit) => text.length <= limit ? text
    : `${text.slice(0, Math.floor(limit * 0.7))}\n\n……[输出过长，中间省略 ${text.length - limit} 个字符。请缩小范围或分页重新获取]……\n\n${text.slice(-Math.floor(limit * 0.3))}` // 明确告诉模型被截了，它才知道该换个问法。


// --- 截断：一次工具输出不能大到把整个会话撑死 ---
// 不截断时实测：1MB 的工具返回值 = 31 万 token，超过大多数模型的整个上下文窗口，
// 而且它会永久留在历史里——连压缩都救不回来，压缩本身就要把这坨东西发给模型去总结。
// 但只截文本：图片这类媒体内容截一刀就彻底废了，截图工具的返回值本来就大，原样放行。
const clip = (output, limit) => {
    if (!limit) return output // 没设上限就原样返回。

    // 多模态结果：逐块处理，文字块该截就截，媒体块一个字节不动。
    if (output.type === 'content') return { ...output, value: output.value.map(part => part.type === 'text' ? { ...part, text: cut(part.text, limit) } : part) }

    const text = typeof output.value === 'string' ? output.value : JSON.stringify(output.value) // 先把输出变成一段文字。
    return text.length <= limit ? output : { type: 'text', value: cut(text, limit) }            // 超了才截，并且明确告诉模型截过。
}


// --- 成形：在跨进程之前就把返回值变成模型能读的输出块 ---
// 放在工具进程里而不是主线程，是因为这一步要执行工具作者写的 toModelOutput、要做 JSON 化、要校验块形状，
// 三件事都可能抛错；抛在这里只是一条正常的工具失败，抛在主线程会让那次调用永远不结算。
const shape = (tool, result, limit) => {
    const value = result?.output ?? result                              // 工具可以返回 { output } 对象，也可以直接返回值。
    const output = tool.toModelOutput ? tool.toModelOutput(value)       // 工具自带格式化函数时优先用它。
        : BLOCK.has(result?.output?.type) ? result.output               // 工具自己就给了成形的输出块——图片和多模态结果走的就是这条路。
        : value === undefined || value === null || value === '' ? { type: 'text', value: '工具执行成功，但没有输出' } // 空返回也给一句交代。
        : typeof value === 'string' ? { type: 'text', value }           // 返回字符串，直接当文字给模型。
        : { type: 'json', value }                                       // 其余结构化值转成 JSON 块。

    // 边界校验：形状不对就在这里变成工具失败，绝不让它穿过去写进 history。
    if (!BLOCK.has(output?.type)) throw new TypeError(`工具输出块的 type 不合法：${JSON.stringify(output?.type)}，只能是 ${[...BLOCK].join(' / ')}`)
    const bad = output.type === 'content' && output.value.find(part => !PART.has(part?.type))
    if (bad) throw new TypeError(`content 块里的 ${JSON.stringify(bad.type)} 部件不合法，只能是 ${[...PART].join(' / ')}。媒体可以用旧 image/audio/video，也可以用 AI SDK 当前的 file`)

    // 跨进程只传纯 JSON，自带格式化的那条路也一样要过这一关：
    // Date 变字符串、NaN 变 null、循环引用在这里变成一条正常的工具错误，不会写进 history 把 Agent 毒死。
    return clip(JSON.parse(JSON.stringify(output)), limit)
}


// --- 内置动作：主线程把 handler.builtin 发过来时，跑包自己的一小段逻辑 ---
// 目前只有「按需加载技能」这一个动作：技能正文在扫描时就读好了，这里按名字取出来交给模型。
const builtin = data => {
    if (data.name !== 'skill') throw new Error(`未知的内置动作：${data.name}`)             // 只认识 skill 一个动作。
    // Object.fromEntries 建出的对象有原型链，名字是 constructor / toString 等时会取到继承的方法而不是 undefined。
    // 用 hasOwn 挡住这条路，继承来的东西不算技能。
    const skillName = data.input?.skill ?? ''
    const body = Object.hasOwn(data.skills ?? {}, skillName) ? data.skills[skillName] : undefined
    if (body === undefined) throw new Error(`找不到技能 "${skillName}"。可用的技能见系统提示词的「可用技能」列表。`) // 名字写错时告诉模型去哪里找对的名字。
    return { type: 'text', value: body }                                                  // 正文原样交给模型。
}


// --- 收到一次执行请求：找工具 → 跑工具 → 把成形后的结果发回去 ---
process.on('message', async data => {
    current = data.callId                                                       // 本次调用的身份，console 输出也归到它名下。
    try {
        if (data.builtin) {                                                     // 内置动作不加载任何工具文件。
            const output = builtin(data)
            process.send({ callId: data.callId, type: 'done', output, stop: false }) // 内置动作不会要求停止循环。
            return
        }

        if (data.mcp) Bun.spawn = spawn                                        // MCP 客户端内部可能使用 Bun 的 spawn，不能把协议字节当普通日志读走。
        const module = await import(data.url)                                   // 工具进程是独立进程，工具文件在这里重新加载。
        const tool = data.mcp
            ? { execute: input => module.MCP.run(data.mcp, input ?? {}, pid => process.send({ callId: data.callId, type: 'child', pid })) } // 主进程持有本地服务 PID，取消时一起终止。
            : [module.default].flat().find(one => one.name === data.name) // 本地文件仍按工具名定位。
        const result = await collect(await tool.execute(data.input))            // 跑工具；生成器工具顺便把每个 yield 实时发出去。
        process.send({ callId: data.callId, type: 'done', output: shape(tool, result, data.limit), stop: result?.stop === true }) // stop 是工具主动要求结束整个循环。
    } catch (error) {
        process.send({ callId: data.callId, type: 'error', message: error?.message || String(error) }) // 工具抛错、toModelOutput 抛错、输出块非法、JSON 化失败，对模型来说都是"这个工具没成功"。
    } finally {
        Bun.spawn = relaySpawn                                                 // 进程归还池前恢复普通文件工具的输出转发。
        current = null                                                          // 交还身份：这之后再有输出就不属于任何一次调用了。
    }
})


process.send({ ready: true }) // 告诉主线程可以派活了；在这之前发过来的消息会排队，但握手让借用逻辑不必猜。
