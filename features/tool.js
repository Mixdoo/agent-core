/*
工具这个主体的全部操作都在这里：从目录里找出工具、把工具交给工具进程执行。

工具进程是一池、全进程共用，用完还池。一次调用独占一个工具进程，所以并发跑的两个工具
不会把 console 输出串到一起。取消只杀 signal 相同的那些——Loop 给同一轮所有并行工具的
本来就是同一个 signal，"取消"在语义上就是"这一轮全部取消"，别的 Agent 不会被连坐。

并发上限分两层，各管各的：pool.limit 是池子的上限，池子里最多同时存在几个工具进程，
它是内存的天花板；concurrency 是每次调用自己的参数，表示"这一批活同时跑几个"。
同一批 = 同一份 handlers 表 + 同一个 signal，也就是同一轮工具调用。
两层都要满足才上得来，所以一台 Agent 调并发不会改到另一台——它们本来就是两批。

工具想要超时保护，自己在工具文件里写 timeout（毫秒）。这个包没有全局超时，
因为阻塞型工具（等 IM 消息、盯文件变化）是它支持的正常用法，全局超时会把这类工具全废掉。
*/

import { fileURLToPath, pathToFileURL } from 'url'
import { basename } from 'path'
import { jsonSchema as aiJsonSchema } from 'ai'

const toolProcessSource = Buffer.from(`
// 这一段在工具进程里跑。bun 会在第一次 --ipc 消息到来之前把 stdin 读完。
// 以 stdin 而不是临时文件喂源码：不落盘，Windows 上拿临时目录权限也麻烦。
const tools = {}
const load = async url => {
    const mod = await import(url)
    for (const t of [mod.default].flat()) {
        if (t?.name && typeof t.execute === 'function') tools[t.name] = t
    }
}
process.on('message', async ({ callId, url, name, input, limit }) => {
    if (!tools[name]) await load(url)  // 首次使用时才加载，同一工具进程后续调用直接用缓存。
    const tool = tools[name]
    if (!tool) { process.send({ callId, type: 'error', message: \`工具 \${name} 未找到\` }); return }

    // 工具用 console.log 输出，在进程间以 IPC 消息传回主线程：
    // 这样取消时已经产出的内容不会丢，实时输出也能转发给上层 UI。
    const orig = console.log.bind(console)
    console.log = (...args) => { process.send({ callId, type: 'output', stream: 'stdout', data: args.join(' ') }); orig(...args) }
    console.error = (...args) => { process.send({ callId, type: 'output', stream: 'stderr', data: args.join(' ') }); orig(...args) }

    let raw
    // async generator 工具：execute 是 async generator 函数，调用它得到的是 AsyncGenerator（不是 Promise）。
    // 识别时机：调用之后，await 之前——如果先 await 就只能拿到 GeneratorResult。
    const maybeGen = tool.execute(input)
    if (maybeGen && typeof maybeGen[Symbol.asyncIterator] === 'function') {
        const parts = []
        try {
            for await (const part of maybeGen) {
                console.log(part)  // 每个 yield 值实时输出，触发 IPC 消息。
                parts.push(part)
            }
        } catch (error) {
            process.send({ callId, type: 'error', message: error?.message ?? String(error) })
            return
        }
        raw = parts
    } else {
        try {
            raw = await maybeGen
        } catch (error) {
            process.send({ callId, type: 'error', message: error?.message ?? String(error) })
            return
        }
    }

    // toModelOutput 允许工具控制"结果如何进 history"：返回的对象直接当 content 块用。
    // 如果没有 toModelOutput，主线程会把结果自己包装成标准形式。
    let output
    if (tool.toModelOutput) {
        try { output = await tool.toModelOutput(raw) }
        catch (error) { process.send({ callId, type: 'error', message: \`toModelOutput 失败：\${error?.message ?? error}\` }); return }
    }

    // 把结果规整成纯 JSON：循环引用、Map、Date、NaN 这类东西跨进程传 IPC 会直接崩或丢数据。
    const sanitize = value => {
        if (value === null || value === undefined) return value
        try { return JSON.parse(JSON.stringify(value, (_k, v) => {
            if (v instanceof Date) return v.toISOString()
            if (v instanceof Map) return Object.fromEntries(v)
            if (typeof v === 'number' && !isFinite(v)) return null
            return v
        })) } catch { return { __sanitize_failed: true } }
    }

    // output 已经通过 toModelOutput 成形了，直接用；否则从 raw 推断。
    if (output !== undefined) {
        const clean = sanitize(output)
        if (clean?.__sanitize_failed) { process.send({ callId, type: 'error', message: '工具输出包含无法序列化的内容（循环引用或不可克隆对象）' }); return }
        process.send({ callId, type: 'done', output: clean, stop: raw?.stop })
        return
    }

    const stop = raw?.stop
    const value = raw?.output !== undefined ? raw.output : raw   // 支持 return { output, stop } 和直接 return value 两种写法。
    const clean = sanitize(value)
    if (clean?.__sanitize_failed) { process.send({ callId, type: 'error', message: '工具输出包含无法序列化的内容（循环引用或不可克隆对象）' }); return }

    // 截断超长输出：已经在主线程的 buffer 里控制了，但工具自己返回的结果也要过这关。
    const truncate = (str, lim) => {
        if (typeof str !== 'string' || str.length <= lim) return str
        const head = str.slice(0, Math.floor(lim * 0.7))
        const tail = str.slice(str.length - Math.floor(lim * 0.3))
        return head + '\\n\\n……[输出过长，中间省略 ' + (str.length - lim) + ' 个字符]……\\n\\n' + tail
    }

    const text = typeof clean === 'string' ? truncate(clean, limit)
        : clean?.type === 'content' && Array.isArray(clean?.value)
            ? { ...clean, value: clean.value.map(part => part.type === 'text' ? { ...part, text: truncate(part.text ?? '', limit) } : part) }
            : typeof clean?.value === 'string' ? { ...clean, value: truncate(clean.value, limit) } : clean
    const isContent = text?.type === 'content' && Array.isArray(text?.value)
    const output_final = isContent ? text : typeof text === 'string' ? { type: 'text', value: text }
        : { type: 'json', value: text }

    // 检查已成形的 content 块有没有非法形状。AI SDK v7 的联合类型没有 type:'media'，用了它
    // standardizePrompt 会在本地直接抛 AI_InvalidPromptError，整次请求发不出去。
    if (isContent) {
        const bad = output_final.value.find(part => part.type === 'media')
        if (bad) { process.send({ callId, type: 'error', message: '工具返回了非法内容块类型 "media"，应改用 "file"（AI SDK v7）' }); return }
    }

    process.send({ callId, type: 'done', output: output_final, stop })
})
process.send({ ready: true })
`)


const jsonSchema = ({ type, properties, required }) => ({ jsonSchema: { type, properties: properties ?? {}, ...(required ? { required } : {}) } })
const runtime = /^bun(\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : 'bun'

// 一池工具进程，全进程共用。不按工具集合分池：取消已经按 signal 精确到轮次了，
// 再按集合分池只会让每次 Tool.scan 都新建一池、旧池的空闲进程永远没人回收。
// live 是"活着的工具进程"，正在启动的也算在内——上限要按它算：开工具进程是异步的，
// 只按 busy 算的话，同一 tick 里涌进来的并发调用全都看到 busy 是空的，于是各开各的，上限形同虚设。
const pool = { live: new Set(), idle: [], busy: new Map(), queue: [], limit: 8 } // busy：工具进程 → 它手上那次调用；queue：等着借工具进程的调用。
let sequence = 0                                                // 调用流水号，一池同时跑多次调用时靠它区分谁是谁。


// --- 并发上限：每一批活自己的旋钮，不是池子的 ---
// 曾经把它写成 pool.limit = concurrency，于是两台 Agent 互相改对方的上限，谁后调用谁说话。
// 同一批 = 同一个 handlers 表 + 同一个 signal，也就是同一轮工具调用：
// 不同 Agent、不同轮次各有各的 handlers/signal，天然分开。
// 外层 WeakMap 挂在 handlers 上，内层用普通 Map（signal 常常是 undefined，不能当 WeakMap key）。
//
// batch.running 是"这一批此刻占着几个工具进程"。
// 占名额和借进程必须在同一个同步步骤里完成（见 claim 函数），否则：
// 12 个调用在同一 tick 里全部涌进来，都看到 running === 0，全部通过检查，各自开进程，
// 上限形同虚设——实测 12 个活、上限 3，起了 12 个进程。
const batches = new WeakMap()

const batchOf = (handlers, signal, concurrency) => {
    if (!concurrency) return null
    if (!batches.has(handlers)) batches.set(handlers, new Map())
    const bySignal = batches.get(handlers)
    if (!bySignal.has(signal)) bySignal.set(signal, { concurrency, running: 0 })
    return bySignal.get(signal)
}


// --- claim：检查能不能上、占名额、取工具进程，三件事在一个同步块里完成 ---
// 如果这次能上：占名额，同步取一个空闲进程（或开一个新进程），返回 Promise<child>。
// 如果这次不能上：把 resolve 推进 pool.queue，稍后由 give 叫醒。
const claim = (call, resolve) => {
    const b = call.batch
    if (b && b.running >= b.concurrency) { pool.queue.push({ call, resolve }); return } // 自己这一批到上限了。
    if (!pool.idle.length && pool.live.size >= pool.limit) { pool.queue.push({ call, resolve }); return } // 池子满了。

    if (b) b.running += 1   // 同步占名额：这一步和检查紧挨着，不能分开。

    const free = pool.idle.pop()
    if (free) { free.ref(); resolve(free); return }
    open().then(resolve)
}


// --- give：把一个工具进程交给队列里第一个能上的人 ---
// 归还进程和占名额也必须在同一个同步块：claim 把名额检查和占用放一起，所以 give 遍历
// 队列时对每一个候选者都重新过一遍"能不能上"，而不是直接取队首——队首可能属于一个已经
// 到自己上限的批次，把进程交给它等于超编，后面本来能上的人白白多等一轮。
const give = child => {
    for (let i = 0; i < pool.queue.length; i++) {
        const waiter = pool.queue[i]
        const b = waiter.call.batch
        if (b && b.running >= b.concurrency) continue // 这一批到上限了，跳过。
        pool.queue.splice(i, 1)
        if (b) b.running += 1 // 同步占名额，和上面的检查紧挨着。
        child.ref()
        waiter.resolve(child)
        return true
    }
    return false
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
    const schema = {}   // 工具名 → 给 LLM 的工具描述（不含执行信息）。
    const handlers = {} // 工具名 → 工具在哪个文件里、它自己声明的超时（不给 LLM 看）。
    const files = []

    // 先收集完整文件列表再排序，保证每次扫描同一目录的加载顺序都一样。
    // 目录之间保持传入顺序，所以"内置工具目录在前、用户工具目录在后"就等于让用户能覆盖内置工具。
    for (const directory of directories.flat()) {
        const cwd = directory instanceof URL ? fileURLToPath(directory) : String(directory)
        const found = []
        for await (const file of new Bun.Glob('**/*.js').scan({ cwd, absolute: true, onlyFiles: true })) found.push(file)
        files.push(...found.sort())
    }

    for (const file of files) {
        const url = pathToFileURL(file).href                                 // 绝对 file:// 地址；工具进程靠它自己重新加载工具文件（函数没法跨进程传）。
        const module = await import(url)

        for (const tool of [module.default].flat()) {                        // 一个文件可以导出一个工具，也可以导出一组工具。
            // scan 是工具文件进入系统的唯一入口，"什么算工具"只在这里判定一次。
            // 跳过而不是报错，工具目录里才能自由放共享常量、辅助函数和测试文件。
            if (!tool?.name || typeof tool.execute !== 'function') continue

            const { execute, toModelOutput, timeout, ...modelTool } = tool   // 执行相关的字段剥离出来，剩下的才给模型看。

            // schema 只放模型需要的东西：工具叫什么、干什么、要什么参数。
            schema[tool.name] = {
                ...modelTool,
                inputSchema: tool.inputSchema?.['~standard']
                    ? tool.inputSchema                                       // 工具作者用 zod 之类写的，本来就是标准格式。
                    : aiJsonSchema({ type: 'object', properties: {}, ...tool.inputSchema }), // 缺什么补什么：无参工具也必然带一份合法 Schema（少了它 Anthropic 和 OpenAI 都会 400），工具自己写的字段一个不丢。
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
    let headSize = 0
    let tailSize = 0
    let dropped = 0   // 中间被丢掉多少字符，要如实告诉模型。

    return {
        push(chunk) {
            if (headSize < limit * 0.7) { head.push(chunk); headSize += chunk.length; return }
            tail.push(chunk)
            tailSize += chunk.length
            while (tailSize > limit * 0.3) { const gone = tail.shift(); tailSize -= gone.length; dropped += gone.length }
        },
        text: () => dropped
            ? `${head.join('')}\n\n……[输出过长，中间省略 ${dropped} 个字符]……\n\n${tail.join('')}`
            : head.join('') + tail.join(''),
    }
}


// --- 一个工具进程空出来了：优先交给排队的人，没人排队才还池 ---
const release = child => {
    if (give(child)) return // give 已经在内部做了 ref()，直接转手。

    child.unref()  // 空闲工具进程不能吊住事件循环，否则跑过一次工具的进程就再也退不出去。
    pool.idle.push(child)
}


// --- 一个工具进程废了（自己死掉、或被我们杀掉）：不能再借出去，排队的人开一个新的 ---
const retire = child => {
    if (!pool.live.delete(child)) return // 已经退役过了。主动杀掉时这里会走一遍，child.exited 之后还会再走一遍。
    pool.busy.delete(child)
    pool.idle = pool.idle.filter(one => one !== child)

    // 池子腾出一个名额，队列里等着的人现在可能能上了。
    for (let i = 0; i < pool.queue.length; i++) {
        const waiter = pool.queue[i]
        const b = waiter.call.batch
        if (b && b.running >= b.concurrency) continue // 自己这一批还满着，继续等。
        if (pool.live.size >= pool.limit) break        // 池子还是满的，没有意义再看了。
        pool.queue.splice(i, 1)
        if (b) b.running += 1
        open().then(waiter.resolve)
        return
    }
}


// --- 开一个新工具进程：一个独立的 bun 进程，源码从 stdin 喂进去 ---
// 用 stdin 而不是临时文件或 bun -e：不落盘、不用清理、没有命令行长度上限
// （bun -e 在 8KB 到 32KB 之间就会 ENAMETOOLONG，而工具进程源码已经接近 8KB，没有余量）。
const open = () => {
    let ready
    const waiting = new Promise(resolve => { ready = resolve })

    const child = Bun.spawn([runtime, '-'], {
        stdin: 'pipe',
        stdout: 'inherit', // 工具的输出走 IPC，这里留给 bun 自己的启动报错，坏了能看见。
        stderr: 'inherit',
        ipc(message) {
            if (message.ready) return ready(child) // 握手：工具进程起来了才派活。

            const call = pool.busy.get(child)
            if (call?.id !== message.callId) return  // 上一次调用的迟到消息；这个工具进程已经换人了，丢掉。

            if (message.type === 'output') {
                call.output.push(String(message.data))                                          // 攒着，中断时把已产出的内容一起还给模型。
                call.onOutput?.({ tool: call.name, stream: message.stream, data: message.data }) // 实时通知上层，上层决定如何展示。
                return
            }

            pool.busy.delete(child)
            if (message.type === 'error') call.finish({ output: { type: 'error-text', value: `工具执行失败：${message.message}` }, error: message.message })
            else call.finish({ output: message.output, stop: message.stop })
            release(child) // finish 之后再 release：finish 还掉名额，release 再叫醒排队的人——顺序不能反。
        },
    })

    pool.live.add(child)  // 同步记账，必须在返回 promise 之前：同一 tick 里的并发调用要立刻看得见它。
    child.stdin.write(toolProcessSource)
    child.stdin.end()

    // 工具进程整个死掉（工具里 process.exit、原生崩溃、工具文件语法错误）时既没有 done 也没有 error。
    // 不接住它，这次调用就永远不结算，整个 Agent 会无声卡死。
    // 被我们主动杀掉时这里也会走一遍，但那次调用早已结算过，finish 自带一次性语义，不会重复。
    child.exited.then(code => {
        const call = pool.busy.get(child)
        retire(child)
        call?.finish({ output: { type: 'error-text', value: `工具执行失败：工具进程退出（代码 ${code}）` }, error: 'process-exited' })
    })

    return waiting
}


// --- 执行一个工具。handlers 必须由调用方明确传入，不存在默认工具表 ---
const execute = ({ name, input, handlers, signal, onOutput, limit = 32000, concurrency }) => {
    const handler = handlers?.[name] // 用工具名从地址表里找到它在哪个文件。
    if (!handler?.url) throw new Error(`Tool ${name} was not found in handlers`) // 认 url 而不是认对象，'__proto__' 这种名字才不会蒙混过关。

    const call = { id: String(++sequence), name, signal, batch: batchOf(handlers, signal, concurrency), onOutput, output: buffer(limit), done: false }

    return new Promise(resolve => {
        const interrupted = one => ({ output: { type: 'error-text', value: `${one.output.text()}\n工具执行已中断` }, interrupted: true })

        // 取消：把这一轮的工具全部杀掉，触发即死，已产出的输出拼进结果还给模型。
        // 只杀 signal 相同的那些，另一台 Agent 的工具不会被连坐。
        // 用 resolve 而不是 reject —— 取消也是一条模型能读的工具结果，历史里不会留下没人应答的调用。
        const stop = () => {
            for (const [child, running] of [...pool.busy]) {
                if (running.signal !== signal) continue // 不是这一轮的工具，让它继续跑。
                retire(child)
                child.kill()                            // 工具此刻在跑什么都不重要，进程被杀就是杀，孙进程一起带走。
                running.finish(interrupted(running))
            }
            // 还在排队的同批调用也在这里收口：retire 不会处理还没借到进程的那些。
            for (let i = pool.queue.length - 1; i >= 0; i--) {
                const waiter = pool.queue[i]
                if (waiter.call.signal !== signal) continue
                pool.queue.splice(i, 1)
                const b = waiter.call.batch
                if (b) b.running -= 1 // 这个人还没拿到进程就被取消了：名额还没占上，不还。
                waiter.call.finish(interrupted(waiter.call))
            }
            call.finish(interrupted(call)) // 这次调用本身（可能还在排队）。
        }

        // 五条收尾路径（跑完、抛错、工具进程死掉、超时、被取消）共用这一个出口，所以"结算两次"在结构上不存在。
        call.finish = result => {
            if (call.done) return                       // 已经结算过了，后到的消息不再改变结果。
            call.done = true
            if (call.batch && call.claimed) call.batch.running -= 1 // 还名额：只有真的拿到进程（claim 成功）才有名额要还。
            clearTimeout(call.timer)                    // 超时看门狗跟着这次调用一起结束。
            signal?.removeEventListener('abort', stop)  // 一次调用只挂一个监听器，跑完就摘，不随调用次数累积。
            resolve(result)
        }

        // 拿到工具进程就开跑。如果在排队期间就被取消，stop 会在 finish 里把 done 置真，
        // 拿到工具进程时这里就知道不用跑了，直接还进程。
        const start = child => {
            if (call.done) {
                // 这次调用已经被取消：名额在 claim/give 里占上了，这里还掉，再把进程让出去。
                if (call.batch) call.batch.running -= 1
                call.claimed = false
                release(child)
                return
            }
            pool.busy.set(child, call)

            // 只有工具自己声明了 timeout 才有看门狗。不设全局超时是有意的：
            // 阻塞型工具（等 IM 消息、盯文件变化）是这个包支持的正常用法，全局超时会把它们全废掉。
            if (handler.timeout) call.timer = setTimeout(() => {
                retire(child)
                child.kill()                            // 挂死的工具只能杀；杀掉的工具进程不回池。
                call.finish({ output: { type: 'error-text', value: `${call.output.text()}\n工具执行超时（${handler.timeout}ms）` }, error: 'timeout' })
            }, handler.timeout)

            child.send({ callId: call.id, url: handler.url, name, input, limit }) // 告诉工具进程：去哪个文件、找哪个名字的工具、用什么参数、输出最多留多长。
        }

        signal?.addEventListener('abort', stop, { once: true })
        if (signal?.aborted) return stop()              // 进来之前就已经取消了，直接停。

        // claim 是唯一的名额检查+占用入口。它在内部同步完成"能不能上 → 占名额 → 排队或取进程"，
        // 所以同一 tick 里涌进来的 12 个调用只有 concurrency 个能立刻拿到进程，其余的进队列。
        claim(call, child => { call.claimed = true; start(child) })
    })
}


export default { scan, execute }
