/*
工具这个主体的全部操作都在这里：从目录里找出工具、把工具交给工具进程执行。

MCP 服务也返回同样的工具集合，可以直接混用：
    const remote = await Tool.mcp({ transport: { type: 'http', url: 'http://localhost:3000/mcp' }, prefix: 'web_' })
    const all = Tool.merge(await Tool.scan('./tools'), remote)
服务端的 tools、prompts、resources 都会变成这张工具表里的条目，上层不需要区分来源。
发现和执行都在子进程里；每次 MCP 调用独立连接、结束即关闭。

    // 积木 1：扫描工具目录，得到一份独立的工具集合
    const tools = await Tool.scan('./tools')
    // tools.schema   → 给 LLM 的 AI SDK 标准工具描述，直接放进 LLM.chat 的 tools
    // tools.handlers → 给执行器用的工具地址表，直接放进 Tool.execute 的 handlers

    // 积木 2：执行工具（模型要调工具时调用）
    const result = await Tool.execute({
        name: 'finish',              // 要执行哪个工具
        input: { result: '任务完成' }, // 工具参数，直接传给工具的 execute
        handlers: tools.handlers,    // 工具地址表，用来找到 finish 在哪个文件里
        signal: abortSignal,         // 触发即杀，工具瞬间死
        onOutput: output => {},      // 工具产生一段输出时调用，调用方决定如何展示或转发
        limit: Infinity,             // 不设输出上限；需要保护上下文时由调用方主动设置
        concurrency: 8,              // 这一轮（同一个 signal）最多同时跑几个，超出的排队；不影响别的 Agent
    })
    // result = { output, stop }            工具正常结束，output 是模型能直接读的输出块
    // result = { output, error }           工具抛错了，错误也作为一条结果交给模型
    // result = { output, interrupted }     被 signal 取消，已产出的内容一起还给模型

工具跑在独立的 bun 子进程里（见 tool-process.js），所以工具碰不到 Agent 的任何状态，
死循环的工具也能被一刀杀掉——进程内的 await 永远做不到这一点。

为什么是子进程而不是 Worker 线程：Worker 被 terminate 之后 Bun 不归还它占的约 22MB，
而且杀线程带不走它 spawn 出来的孙进程。常驻 agent 天天要杀工具进程（工具崩溃、超时、用户打断），
两笔账会一直累积。换成子进程后实测 200 次「起→用→杀」主进程只涨 2MB（Worker 版是 4.4GB），
孙进程一起带走，而且主进程退出时工具进程全部跟着死，不留孤儿。

工具进程是一池、全进程共用，用完还池。一次调用独占一个工具进程，所以并发跑的两个工具
不会把 console 输出串到一起。取消只杀 signal 相同的那些——Loop 给同一轮所有并行工具的
本来就是同一个 signal，"取消"在语义上就是"这一轮全部取消"，别的 Agent 不会被连坐。

工具想要超时保护，自己在工具文件里写 timeout（毫秒）。这个包没有全局超时，
因为阻塞型工具（等 IM 消息、盯文件变化）是它支持的正常用法，全局超时会把这类工具全废掉。
*/

import { pathToFileURL, fileURLToPath } from 'node:url'
import { basename } from 'node:path'
import { jsonSchema } from 'ai'
import PQueue from 'p-queue' // 排队与并发上限交给它，这个包不再自己数名额、维护等待队列。
import toolProcessSource from './tool-process.js' with { type: 'text' } // 工具进程源码以文本引入，打包成单文件时会被原样内联成字符串。
import Notify from '../utils/notify.js' // 实时输出回调统一从这里调用，出错不影响工具执行。
export { MCP } from './mcp.js' // 供子进程按当前模块地址导入，源码和单文件产物使用同一入口。

// 工具进程要用一个"能跑脚本的 bun"来启动。宿主自己通常就是，用它比在 PATH 上碰运气可靠：
// 不依赖环境变量，也不会和宿主用的 bun 版本不一致。
// 但宿主被 bun build --compile 成单可执行文件时，execPath 是那个 exe 自己，
// 拿它当解释器等于把整个 app 再跑一遍——实测确实会，而且看起来像是工具挂了，很难查。
// 所以只认"execPath 本身就是个 bun 可执行文件"这一种情况，认不出来就退回 PATH 上的 bun：
// 判反的代价不对称，退回去只是回到最普通的做法，判错了却会让 app 自我重入。
const runtime = /^bun(\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : 'bun'

// 一池工具进程，全进程共用。不按工具集合分池：取消已经按 signal 精确到轮次了，
// 再按集合分池只会让每次 Tool.scan 都新建一池、旧池的空闲进程永远没人回收。
// 工具在忙时按各自的 signal 控制并发；空闲进程最多留 8 个，避免多个 Agent 跑完后长期占内存。
const pool = { live: new Set(), idle: [], busy: new Map(), limit: 8 } // busy：工具进程 → 它手上那次调用。
let sequence = 0                                                       // 调用流水号，一池同时跑多次调用时靠它区分谁是谁。

// --- 并发上限按"一次运行"（同一个 signal）分开 ---
// 每次运行一个队列：p-queue 保证同一队列内同时最多跑 concurrency 个，超出的自己排队。
// 队列彼此独立，所以一台 Agent 调窄自己的上限，不会影响另一台。
// 直接调用（没有 signal）共用一个队列，和以前"共用默认批次"的行为一致。
const queues = new WeakMap()   // signal → 它的队列。
const direct = new PQueue({ concurrency: 8 }) // 无 signal 的直接调用共用的队列，默认受池子上限约束。

const queueOf = (signal, concurrency) => {
    if (!signal) { direct.concurrency = concurrency ?? pool.limit; return direct } // 没给上限就用池子上限，避免一次涌进几十个进程。
    let queue = queues.get(signal)                                                 // 这次运行已经有队列就复用。
    if (!queue) { queue = new PQueue({ concurrency: Infinity }); queues.set(signal, queue) } // 先建队列，再设上限。
    queue.concurrency = concurrency ?? Infinity // 本次调用给的上限就是这一批的上限。
    return queue
}


// --- 扫描工具目录，返回一份完全独立的工具集合 ---
// 不写任何模块级变量，所以多次扫描互不影响，多个 Agent 可以各用各的工具目录。
//
//   Tool.scan('./tools')                                   一个目录
//   Tool.scan(builtinDir, userDir)                         多个目录，后面的覆盖前面的同名工具
//   Tool.scan(new URL('./tools', import.meta.url))         直接给 URL——嵌进别人项目时手边就是它
//
// 路径字符串是相对宿主进程当前目录解析的。作为被嵌入的库，这一点很容易出错，
// 所以直接收 URL：`new URL('./tools', import.meta.url)` 永远指向调用方自己那份代码旁边的目录。
const scan = async (...directories) => {
    const schema = Object.create(null)   // 工具名 → 给 LLM 的工具描述（不含执行信息）。null 原型防止工具名为 __proto__ 时污染对象原型链。
    const handlers = Object.create(null) // 工具名 → 工具在哪个文件里、它自己声明的超时（不给 LLM 看）。
    const files = []    // 所有目录里找到的工具文件，按顺序排好。

    // 先收集完整文件列表再排序，保证每次扫描同一目录的加载顺序都一样。
    // 目录之间保持传入顺序，所以"内置工具目录在前、用户工具目录在后"就等于让用户能覆盖内置工具。
    // 这个包只跑在 Bun 上，Bun 直接执行 TypeScript，所以 .ts 工具和 .js 一样认；.d.ts 只有类型、没有代码，跳过。
    for (const directory of directories.flat()) {
        const cwd = directory instanceof URL ? fileURLToPath(directory) : String(directory) // URL 和字符串都收，统一变成路径。
        const found = []
        for await (const file of new Bun.Glob('**/*.{js,mjs,ts,mts}').scan({ cwd, absolute: true, onlyFiles: true })) if (!/\.d\.m?ts$/.test(file)) found.push(file) // 递归找工具文件，跳过纯类型声明。
        files.push(...found.sort())                                                         // 排序，保证加载顺序稳定。
    }

    for (const file of files) {
        const url = pathToFileURL(file).href                                 // 绝对 file:// 地址；工具进程靠它自己重新加载工具文件（函数没法跨进程传）。
        const module = await import(url)                                     // 加载工具文件，拿到它的默认导出。

        for (const tool of [module.default].flat()) {                        // 一个文件可以导出一个工具，也可以导出一组工具。
            // scan 是工具文件进入系统的唯一入口，"什么算工具"只在这里判定一次。
            // 跳过而不是报错，工具目录里才能自由放共享常量、辅助函数和测试文件。
            if (!tool?.name || typeof tool.execute !== 'function') continue  // 没有名字或没有执行函数的，不是工具。

            const { execute, toModelOutput, timeout, ...modelTool } = tool   // 执行相关的字段剥离出来，剩下的才给模型看。

            // schema 只放模型需要的东西：工具叫什么、干什么、要什么参数。
            schema[tool.name] = {
                ...modelTool,
                inputSchema: tool.inputSchema?.['~standard']
                    ? tool.inputSchema                                       // 工具作者用 zod 之类写的，本来就是标准格式。
                    : jsonSchema({ type: 'object', properties: {}, ...tool.inputSchema }), // 缺什么补什么：无参工具也必然带一份合法 Schema（少了它 Anthropic 和 OpenAI 都会 400），工具自己写的字段一个不丢。
            }

            handlers[tool.name] = { url, timeout }                           // 只记住工具在哪个文件和它的超时；具体是文件里的哪一个，工具进程按名字自己找。
        }
    }

    return { schema, handlers }
}


// --- 一次调用的实时输出缓冲：有界 ---
// 中断和超时要把"已经产出的内容"还给模型，所以得攒着；但必须有界：
// 阻塞型工具边跑边输出，一次 3 秒的打断实测能攒出 356 万字符（111 倍上限），
// 而它会原样写进 history 且永远删不掉。头尾都留，和工具正常返回时的截断同一个语义。
const buffer = limit => {
    const head = []   // 开头那段，装满就不再变，够模型判断这是什么内容。
    const tail = []   // 结尾那段，滚动保留，结论和报错通常在这里。
    let headSize = 0  // head 已经攒了多少字符。
    let tailSize = 0  // tail 当前占了多少字符。
    let dropped = 0   // 中间被丢掉多少字符，要如实告诉模型。

    return {
        push(chunk) {
            if (headSize < limit * 0.7) { head.push(chunk); headSize += chunk.length; return } // 先装满开头那 70%。
            tail.push(chunk)                                                                   // 之后都往结尾滚。
            tailSize += chunk.length
            while (tailSize > limit * 0.3) { const gone = tail.shift(); tailSize -= gone.length; dropped += gone.length } // 结尾只留 30%，超了就从最旧的开始丢。
        },
        text: () => dropped
            ? `${head.join('')}\n\n……[输出过长，中间省略 ${dropped} 个字符]……\n\n${tail.join('')}` // 两头拼起来，中间如实标注丢了多少。
            : head.join('') + tail.join(''),                                                     // 没丢过就直接拼。
    }
}


// --- 一个工具进程空出来了：先还池，再让排队的人去借 ---
const release = child => {
    child.unref()                  // 空闲工具进程不能吊住事件循环，否则跑过一次工具的进程就再也退不出去。
    pool.idle.push(child)          // 放进空闲池，等下一次调用复用。
    if (pool.idle.length > pool.limit) { // 忙时允许多开，闲下来后仍只留默认数量。
        const extra = pool.idle.shift()  // 多出来的进程。
        pool.live.delete(extra)
        extra.kill()                     // 杀掉，把内存还给系统。
    }
}


// --- 收回本次调用启动的 MCP 服务进程 ---
// SDK 的 close 发出正常退出信号，拒绝配合的服务仍需强制终止。完成和取消共用这一个出口。
const stopChildren = call => {
    for (const pid of call?.children ?? []) {                 // children 是这次调用起的本地服务进程。
        try { process.kill(pid, 'SIGKILL') }
        catch (error) { if (error.code !== 'ESRCH') throw error } // 服务可能已经自行退出。
    }
}

// --- 一个工具进程废了（自己死掉、或被我们杀掉）：它不能再被借出去 ---
// 借进程的动作由队列负责，这里只需要把它从池子里摘掉，让后来的人开新的。
const retire = child => {
    stopChildren(pool.busy.get(child)) // 主进程登记了服务 PID，执行进程崩溃时也能清理。
    if (!pool.live.delete(child)) return // 已经退役过了。主动杀掉时这里会走一遍，child.exited 之后还会再走一遍。
    pool.busy.delete(child)              // 不再记着它手上有哪次调用。
    pool.idle = pool.idle.filter(one => one !== child) // 从空闲池里也摘掉。
}


// --- 开一个新工具进程：一个独立的 bun 进程，源码从 stdin 喂进去 ---
// 用 stdin 而不是临时文件或 bun -e：不落盘、不用清理、没有命令行长度上限
// （bun -e 在 8KB 到 32KB 之间就会 ENAMETOOLONG，而工具进程源码已经接近 8KB，没有余量）。
const open = () => {
    let ready                                   // 握手完成时调用它。
    const waiting = new Promise(resolve => { ready = resolve }) // 等工具进程报告"我起来了"。

    const child = Bun.spawn([runtime, '-'], {   // 起一个 bun 进程，源码从标准输入喂进去。
        stdin: 'pipe',
        stdout: 'inherit', // 工具的输出走 IPC，这里留给 bun 自己的启动报错，坏了能看见。
        stderr: 'inherit',
        ipc(message) {   // 工具进程发回来的每条消息都在这里处理。
            if (message.ready) return ready(child) // 握手：工具进程起来了才派活。

            const call = pool.busy.get(child)      // 这个进程当前在跑哪次调用。
            if (call?.id !== message.callId) return  // 上一次调用的迟到消息；这个工具进程已经换人了，丢掉。

            if (message.type === 'child') {
                (call.children ??= new Set()).add(message.pid) // 本地 MCP 服务随这一调用一起取消。
                return
            }

            if (message.type === 'output') {
                call.output.push(String(message.data))                                          // 攒着，中断时把已产出的内容一起还给模型。
                Notify.tell(call.onOutput, { tool: call.name, stream: message.stream, data: message.data }) // 实时通知上层；不等它，它出错也不影响工具执行。
                return
            }

            stopChildren(call) // 每次调用独立连接，服务进程在成功或失败返回时都应结束。
            pool.busy.delete(child)                                                             // 这次干完了，
            release(child)                                                                      // 让给下一个人，或者还池。
            if (message.type === 'error') call.finish({ output: { type: 'error-text', value: `工具执行失败：${message.message}` }, error: message.message }) // 工具失败也是一条结果，模型需要知道。
            else call.finish({ output: message.output, stop: message.stop })                    // output 在工具进程里就已经成形，主线程不再加工。
        },
    })

    pool.live.add(child)  // 同步记账，必须在返回 promise 之前：同一 tick 里的并发调用要立刻看得见它。
    child.stdin.write(toolProcessSource)
    child.stdin.end()

    // 工具进程整个死掉（工具里 process.exit、原生崩溃、工具文件语法错误）时既没有 done 也没有 error。
    // 不接住它，这次调用就永远不结算，整个 Agent 会无声卡死。
    // 被我们主动杀掉时这里也会走一遍，但那次调用早已结算过，finish 自带一次性语义，不会重复。
    // 握手完成前就死掉时 ready 还没被调用，waiting 会永远挂着——用 ready(null) 解除挂起，
    // borrow 收到 null 就知道进程启动失败，给出错误结果而不是卡死。
    child.exited.then(code => {
        ready(null)   // 握手前死掉：解除 borrow 那一侧的等待；握手后 ready 已调用、这次是空操作。
        const call = pool.busy.get(child)
        retire(child)
        call?.finish({ output: { type: 'error-text', value: `工具执行失败：工具进程退出（代码 ${code}）` }, error: 'process-exited' })
    })

    return waiting
}


// --- 借一个工具进程：池里有空闲就直接用，没有就开一个新的 ---
const borrow = async () => {
    const free = pool.idle.pop() // 从空闲池拿一个。
    const child = free ? (free.ref(), free) : await open() // 有空闲就借，没有就开新的。
    if (!child) throw new Error('工具进程启动失败：进程在握手完成前就退出了') // open() 返回 null 说明进程握手前已死。
    return child
}


// --- 执行一个工具。handlers 必须由调用方明确传入，不存在默认工具表 ---
const execute = ({ name, input, handlers, signal, onOutput, limit = Infinity, concurrency }) => {
    const handler = handlers?.[name] // 用工具名从地址表里找到它在哪个文件。
    if (!handler?.url && !handler?.builtin) throw new Error(`Tool ${name} was not found in handlers`) // 认 url / builtin 而不是认对象，'__proto__' 这种名字才不会蒙混过关。
    const call = { id: String(++sequence), name, signal, onOutput, output: buffer(limit), done: false } // 这次调用的全部状态。
    const queue = queueOf(signal, concurrency) // 这次调用属于哪一批；同一批共用同一个上限。

    return new Promise(resolve => {
        const interrupted = one => ({ output: { type: 'error-text', value: `${one.output.text()}\n工具执行已中断` }, interrupted: true }) // 被取消时把已产出的内容一起交回。

        // 取消：把这一轮的工具全部杀掉，触发即死，已产出的输出拼进结果还给模型。
        // 只杀 signal 相同的那些，另一台 Agent 的工具不会被连坐。
        // 用 resolve 而不是 reject —— 取消也是一条模型能读的工具结果，历史里不会留下没人应答的调用。
        const stop = () => {
            for (const [child, running] of [...pool.busy]) {   // 池里正在跑的所有调用。
                if (running.signal !== signal) continue // 不是这一轮的工具，让它继续跑。
                retire(child)                           // 从池子里摘掉。
                child.kill()                            // 工具此刻在跑什么都不重要，进程被杀就是杀，孙进程一起带走。
                running.finish(interrupted(running))    // 那次调用也收口。
            }
            call.finish(interrupted(call))              // 这次调用自己也要收口：它还排在队里、或已经借到进程，都算结束。
        }

        // 五条收尾路径（跑完、抛错、工具进程死掉、超时、被取消）共用这一个出口，所以"结算两次"在结构上不存在。
        call.finish = result => {
            if (call.done) return                       // 已经结算过了，后到的消息不再改变结果。
            call.done = true
            clearTimeout(call.timer)                    // 超时看门狗跟着这次调用一起结束。
            signal?.removeEventListener('abort', stop)  // 一次调用只挂一个监听器，跑完就摘，不随调用次数累积。
            call.done2?.()                              // 告诉队列这次调用真的结束了，名额可以让给同批的下一个。
            resolve(result)                             // 把结果交给等待这次调用的上层。
        }

        // 真正开跑：占住一个进程，挂上看门狗，把活派给它。
        const start = child => {
            if (call.done) return release(child)        // 排队时就被取消了，拿到也不跑，直接把进程让回池子。
            pool.busy.set(child, call)                  // 记下这个进程现在归这次调用。

            // 只有工具自己声明了 timeout 才有看门狗。不设全局超时是有意的：
            // 阻塞型工具（等 IM 消息、盯文件变化）是这个包支持的正常用法，全局超时会把它们全废掉。
            if (handler.timeout) call.timer = setTimeout(() => {
                retire(child)                           // 超时的进程不回池。
                child.kill()                            // 挂死的工具只能杀；杀掉的工具进程不回池。
                call.finish({ output: { type: 'error-text', value: `${call.output.text()}\n工具执行超时（${handler.timeout}ms）` }, error: 'timeout' })
            }, handler.timeout)

            // 进程可能在借出后、发消息前这一刻退出；那时 send 会同步抛错。
            // 抛出去会让这次调用永远不结算（没有人接住这个拒绝），所以在这里就地收口。
            try { child.send({ callId: call.id, url: handler.url, mcp: handler.mcp, builtin: handler.builtin, skills: handler.skills, name, input, limit }) } // MCP 连接只传数据，不能把执行函数移进主进程。
            catch (error) {
                retire(child)
                call.finish({ output: { type: 'error-text', value: `工具执行失败：无法派发到工具进程（${error.message}）` }, error: error.message })
            }
        }

        signal?.addEventListener('abort', stop, { once: true }) // 取消信号一到就停。
        if (signal?.aborted) return stop()              // 进来之前就已经取消了，直接停。

        // 排队、并发上限、占住名额都由队列负责：这个任务要等整次调用结束才算完，
        // 所以同一批里同一时刻最多有 concurrency 个在跑，超出的等前一个结算。
        queue.add(async () => {
            let child
            // 工具进程起不来（bun 不在 PATH、系统进程数满）时 spawn 会直接抛错。
            // 不接住的话这次调用永远不结算，整个 Agent 无声卡死，还会多一条未处理的拒绝。
            try { child = await borrow() }
            catch (error) { return call.finish({ output: { type: 'error-text', value: `工具执行失败：工具进程启动失败（${error.message}）` }, error: error.message }) }
            if (call.done) return release(child)        // 排队时就被取消了，拿到也不跑，直接把进程让回池子。
            await new Promise(done => { call.done2 = done; start(child) }) // 等这次调用结算，队列才知道可以让下一个上。
        })
    })
}


// --- 提示词模板的参数声明变成一份 JSON Schema ---
// MCP 的参数描述里只有名字、说明和是否必填，正好是一个对象 Schema 的全部内容。
const promptSchema = parameters => jsonSchema({
    type: 'object',
    properties: Object.fromEntries(parameters.map(one => [one.name, { type: 'string', ...(one.description ? { description: one.description } : {}) }])), // 每个参数都当字符串。
    required: parameters.filter(one => one.required).map(one => one.name), // 标了必填的才进 required。
})

// --- 服务端公开的资源写进工具描述，模型才知道有哪些地址可读 ---
// 资源和工具描述一样是发现时固定的；服务端资源变了要重新扫一次。
const resourceTool = resources => ({
    description: `读取 MCP 服务端公开的资源，uri 从下面挑：\n${resources.map(one => `- ${one.uri}${one.template ? '（模板，占位符自行替换）' : ''}${one.description ? `：${one.description}` : ''}`).join('\n')}`, // 可用地址直接列给模型。
    inputSchema: jsonSchema({ type: 'object', properties: { uri: { type: 'string', description: '要读取的资源地址' } }, required: ['uri'] }),
})

// --- 从 MCP 服务发现工具 ---
// const remote = await Agent.tool.mcp({ transport: { type: 'http', url: 'http://localhost:3000/mcp' }, prefix: 'web_' })
// 服务端的 tools、prompts、resources 都会变成同一张工具表：工具直连，提示词按参数取回，资源按 uri 读取。
// signal 可取消发现过程；timeout 是调用方主动选择的工具超时，未设置就不加上限。
const mcp = async ({ transport, prefix = '', signal, timeout }) => {
    transport = structuredClone(transport) // 入口只接受连接数据；函数或客户端对象在派发前直接报错，避免 IPC 无法序列化后挂起。
    const source = { url: import.meta.url, timeout } // 打包后 import.meta.url 自动指向完整产物。
    const listed = await execute({ name: 'discover', input: {}, handlers: { discover: { ...source, mcp: { transport, kind: 'discover' } } }, signal }) // 发现也在可强杀进程中完成。
    if (listed.interrupted) throw new DOMException('MCP discovery aborted', 'AbortError') // 发现被取消。
    if (listed.error) throw new Error(listed.output.value) // 发现失败必须通知调用方，不返回空集合伪装成功。
    const discovered = listed.output.value                // 服务端公开的三种原语。
    const schema = Object.create(null) // 外部工具名不影响对象原型。
    const handlers = Object.create(null)

    for (const tool of discovered.tools) {
        const name = prefix + tool.name // 多个服务用不同前缀就不会撞名。
        schema[name] = { description: tool.description, inputSchema: jsonSchema(tool.inputSchema) } // 远端工具直接变成一个本地工具。
        handlers[name] = { ...source, mcp: { transport, kind: 'tool', name: tool.name } } // 原始名字留给服务端。
    }

    for (const prompt of discovered.prompts) {
        const name = prefix + prompt.name // 提示词和工具共用一个命名空间，同名时后发现的覆盖先发现的。
        schema[name] = { description: prompt.description ?? `MCP 提示词 ${prompt.name}`, inputSchema: promptSchema(prompt.arguments) } // 提示词也变成一个带参数的工具。
        handlers[name] = { ...source, mcp: { transport, kind: 'prompt', name: prompt.name } }
    }

    if (discovered.resources.length) { // 服务端没公开资源时不多一个用不上的工具。
        const name = prefix + 'read_resource' // 所有资源合并成一个读取工具，uri 当参数。
        schema[name] = resourceTool(discovered.resources)
        handlers[name] = { ...source, mcp: { transport, kind: 'resource' } }
    }

    return { schema, handlers } // 与 scan 完全相同的形状，Agent 无需区分工具来源。
}

// --- 合并本地和远端工具集合 ---
// 同名时后面的整项覆盖前面，描述和执行地址一起更新，不会各来自不同集合。
const merge = (...sets) => ({
    schema: Object.assign(Object.create(null), ...sets.map(set => set.schema ?? {})),     // 只取工具集合的 schema 部分。
    handlers: Object.assign(Object.create(null), ...sets.map(set => set.handlers ?? {})), // 和 handlers 部分。
})

export default { scan, execute, mcp, merge }
