/*
工具这个主体的全部操作都在这里：从目录里找出工具、接纳内存工具对象、执行工具、合并工具集合。

    // 积木 1：扫描工具目录，得到一份独立的工具集合
    const tools = await Tool.scan('./tools')
    // tools.schema   → 给 LLM 的 AI SDK 标准工具描述，直接放进 LLM.chat 的 tools
    // tools.handlers → 给执行器用的工具地址表，直接放进 Tool.execute 的 handlers

    // 积木 2：把内存工具对象归一化成同样的形状
    // 接受数组：[{ name, description, inputSchema, execute }, ...]
    // 接受 record：{ echo: { description, inputSchema, execute } }
    // 接受 AI SDK tool() 产物（有 inputSchema + execute 字段的对象）
    // 接受已经是 { schema, handlers } 的集合 → 原样通过
    const tools = Tool.adopt(mcpClient.tools())

    // 积木 3：执行工具（模型要调工具时调用）
    const result = await Tool.execute({
        name: 'finish',              // 要执行哪个工具
        input: { result: '任务完成' }, // 工具参数，直接传给工具的 execute
        handlers: tools.handlers,    // 工具地址表，用来找到 finish 在哪里
        signal: abortSignal,         // 触发即杀，工具瞬间死（文件工具）/ 透传（内存工具）
        onOutput: output => {},      // 工具产生一段输出时调用，调用方决定如何展示或转发
        limit: Infinity,             // 不设输出上限；需要保护上下文时由调用方主动设置
        concurrency: 8,              // 这一轮最多同时跑几个文件工具，超出的排队
    })
    // result = { output, stop }            工具正常结束
    // result = { output, error }           工具抛错了，错误也作为一条结果交给模型
    // result = { output, interrupted }     被 signal 取消

    // 积木 4：合并工具集合
    const all = Tool.merge(local, remote)

工具集合里的条目有两种执行方式，execute 一处分开：
  文件工具   → handler 带 url，交给工具子进程（见 tool-process.js），排队、取消、超时都在这里管；
  内存工具   → handler 带 execute 函数，在主进程直接调，结果经过和文件工具一致的成形规则。

文件工具跑在独立的 bun 子进程里，所以工具碰不到 Agent 的任何状态，
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
import PQueue from 'p-queue'
import toolProcessSource from './tool-process.js' with { type: 'text' }
import Notify from '../utils/notify.js'
import normalizeInputSchema from '../utils/schema.js'
import shape from '../utils/shape.js'

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
const pool = { live: new Set(), idle: [], busy: new Map(), limit: 8 }
let sequence = 0

// 每次运行一个队列：p-queue 保证同一队列内同时最多跑 concurrency 个，超出的自己排队。
const queues = new WeakMap()
const direct = new PQueue({ concurrency: 8 })

const queueOf = (signal, concurrency) => {
    if (!signal) { direct.concurrency = concurrency ?? pool.limit; return direct }
    let queue = queues.get(signal)
    if (!queue) { queue = new PQueue({ concurrency: Infinity }); queues.set(signal, queue) }
    queue.concurrency = concurrency ?? Infinity
    return queue
}


// --- 扫描工具目录，返回一份完全独立的工具集合 ---
//
//   Tool.scan('./tools')
//   Tool.scan(builtinDir, userDir)         后面的覆盖前面的同名工具
//   Tool.scan(new URL('./tools', import.meta.url))
//
const scan = async (...directories) => {
    const schema = Object.create(null)
    const handlers = Object.create(null)
    const files = []

    for (const directory of directories.flat()) {
        const cwd = directory instanceof URL ? fileURLToPath(directory) : String(directory)
        const found = []
        for await (const file of new Bun.Glob('**/*.{js,mjs,ts,mts}').scan({ cwd, absolute: true, onlyFiles: true })) if (!/\.d\.m?ts$/.test(file)) found.push(file)
        files.push(...found.sort())
    }

    for (const file of files) {
        const url = pathToFileURL(file).href
        const module = await import(url)

        for (const tool of [module.default].flat()) {
            if (!tool?.name || typeof tool.execute !== 'function') continue

            const { execute, toModelOutput, timeout, ...modelTool } = tool

            schema[tool.name] = {
                ...modelTool,
                inputSchema: normalizeInputSchema(tool.inputSchema),
            }

            handlers[tool.name] = { url, timeout }
        }
    }

    return { schema, handlers }
}


// --- 接纳内存工具对象，归一化成 { schema, handlers } ---
// 接受：
//   数组   [{ name, description, inputSchema, execute, toModelOutput?, timeout? }, ...]
//   record { toolName: { description, inputSchema, execute, ... } }（AI SDK / MCP toolset 形状）
//   已归一化的 { schema, handlers } → 原样通过
//   null / undefined → 空工具集
//
// inputSchema 三种写法都认：裸 JSON Schema、zod/valibot（~standard）、AI SDK jsonSchema()。
// 调用方不需要手动转；采纳 MCP 客户端的 tools() 直接传进来就能用。
//
// MCP 工具的 execute 返回 CallToolResult（{ content: [...] }）；核心只管通用契约，
// 转成输出块是应用层的事——可以在工具对象上加 toModelOutput 来接管。
const adopt = (input) => {
    if (!input) return { schema: Object.create(null), handlers: Object.create(null) }

    // 目录只有 scan 会扫，adopt 不扫。传错了当场说清楚，而不是悄悄得到一份空工具表。
    if (typeof input === 'string' || input instanceof URL) throw new TypeError(`Tool.adopt 不接受路径；要扫描目录用 await Tool.from(${JSON.stringify(String(input))}) 或 Tool.scan(...)`)
    if (Array.isArray(input) && input.some(one => typeof one === 'string' || one instanceof URL)) throw new TypeError('Tool.adopt 的工具数组里不能放路径；要扫描多个目录用 await Tool.from(dir1, dir2) 或 Tool.scan(dir1, dir2)')

    // 已经是归一化集合：有 schema 和 handlers 两个自有属性
    if (!Array.isArray(input) && typeof input === 'object' && 'schema' in input && 'handlers' in input) return input

    // 把 record 或数组都统一成条目列表
    const entries = Array.isArray(input)
        ? input.map(tool => [tool.name, tool])                     // 数组：工具对象自带 name
        : Object.entries(input).map(([name, tool]) => [name, { name, ...tool }]) // record：名字从键来

    const schema = Object.create(null)
    const handlers = Object.create(null)

    for (const [name, tool] of entries) {
        if (!name || typeof tool?.execute !== 'function') continue // 没有名字或没有执行函数的，跳过。

        const { execute, toModelOutput, timeout, ...modelTool } = tool

        schema[name] = {
            ...modelTool,
            name,
            inputSchema: normalizeInputSchema(tool.inputSchema),
        }

        handlers[name] = { execute, toModelOutput, timeout }
    }

    return { schema, handlers }
}


// --- 一行拿到工具集合：每个参数可以是目录、内存工具或已有集合，按顺序合并 ---
//   await Tool.from('./tools', mcpClient.tools(), { skill })
// 字符串和 URL 当目录扫描，其余交给 adopt；Promise 会先等它。同名时后面的覆盖前面的。
const from = async (...sources) => {
    const sets = []
    for (const source of sources) {
        const value = await source
        sets.push(typeof value === 'string' || value instanceof URL ? await scan(value) : adopt(value))
    }
    return merge(...sets)
}


// --- 一次调用的实时输出缓冲：有界 ---
const buffer = limit => {
    const head = []
    const tail = []
    let headSize = 0
    let tailSize = 0
    let dropped = 0

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


// --- 一个工具进程空出来了：先还池，再让排队的人去借 ---
const release = child => {
    child.unref()
    pool.idle.push(child)
    if (pool.idle.length > pool.limit) {
        const extra = pool.idle.shift()
        pool.live.delete(extra)
        extra.kill()
    }
}


// --- 一个工具进程废了：它不能再被借出去 ---
const retire = child => {
    if (!pool.live.delete(child)) return
    pool.busy.delete(child)
    pool.idle = pool.idle.filter(one => one !== child)
}


// --- 开一个新工具进程 ---
const open = () => {
    let ready
    const waiting = new Promise(resolve => { ready = resolve })

    const child = Bun.spawn([runtime, '-'], {
        stdin: 'pipe',
        stdout: 'inherit',
        stderr: 'inherit',
        ipc(message) {
            if (message.ready) return ready(child)

            const call = pool.busy.get(child)
            if (call?.id !== message.callId) return

            if (message.type === 'output') {
                call.output.push(String(message.data))
                Notify.tell(call.onOutput, { tool: call.name, stream: message.stream, data: message.data })
                return
            }

            pool.busy.delete(child)
            release(child)
            if (message.type === 'error') call.finish({ output: { type: 'error-text', value: `工具执行失败：${message.message}` }, error: message.message })
            else call.finish({ output: message.output, stop: message.stop })
        },
    })

    pool.live.add(child)
    child.stdin.write(toolProcessSource)
    child.stdin.end()

    child.exited.then(code => {
        ready(null)
        const call = pool.busy.get(child)
        retire(child)
        call?.finish({ output: { type: 'error-text', value: `工具执行失败：工具进程退出（代码 ${code}）` }, error: 'process-exited' })
    })

    return waiting
}


// --- 借一个工具进程 ---
const borrow = async () => {
    const free = pool.idle.pop()
    const child = free ? (free.ref(), free) : await open()
    if (!child) throw new Error('工具进程启动失败：进程在握手完成前就退出了')
    return child
}


// --- 截断 ---
const cut = (text, limit) => text.length <= limit ? text
    : `${text.slice(0, Math.floor(limit * 0.7))}\n\n……[输出过长，中间省略 ${text.length - limit} 个字符。请缩小范围或分页重新获取]……\n\n${text.slice(-Math.floor(limit * 0.3))}`

const clip = (output, limit) => {
    if (!Number.isFinite(limit)) return output
    if (output.type === 'content') return { ...output, value: output.value.map(part => part.type === 'text' ? { ...part, text: cut(part.text, limit) } : part) }
    const text = typeof output.value === 'string' ? output.value : JSON.stringify(output.value)
    return text.length <= limit ? output : { type: 'text', value: cut(text, limit) }
}


// --- 执行一个工具 ---
// handler.execute（内存工具）→ 主进程直接调；handler.url（文件工具）→ 工具子进程。
const execute = async ({ name, input, handlers, signal, onOutput, limit = Infinity, concurrency }) => {
    const handler = handlers?.[name]
    if (!handler?.execute && !handler?.url) throw new Error(`Tool ${name} was not found in handlers`)
    const result = handler.execute
        ? await memory({ name, input, handler, signal, onOutput, limit })
        : await local({ name, input, handler, signal, onOutput, limit, concurrency })
    return { ...result, output: clip(result.output, limit) }
}


// --- 在主进程里执行一个内存工具 ---
const memory = async ({ name, input, handler, signal, onOutput, limit }) => {
    try {
        // signal 透传给工具；工具本身决定要不要响应它（MCP execute 不用 signal 也没关系）。
        const raw = await handler.execute(input, { signal })
        const output = shape(handler, raw)
        const stop = raw?.stop === true
        return { output, stop }
    } catch (error) {
        return { output: { type: 'error-text', value: `工具执行失败：${error?.message || String(error)}` }, error: error?.message || String(error) }
    }
}


// --- 在工具进程里执行一个文件工具 ---
const local = ({ name, input, handler, signal, onOutput, limit, concurrency }) => {
    const call = { id: String(++sequence), name, signal, onOutput, output: buffer(limit), done: false }
    const queue = queueOf(signal, concurrency)

    return new Promise(resolve => {
        const interrupted = one => ({ output: { type: 'error-text', value: `${one.output.text()}\n工具执行已中断` }, interrupted: true })

        const stop = () => {
            for (const [child, running] of [...pool.busy]) {
                if (running.signal !== signal) continue
                retire(child)
                child.kill()
                running.finish(interrupted(running))
            }
            call.finish(interrupted(call))
        }

        call.finish = result => {
            if (call.done) return
            call.done = true
            clearTimeout(call.timer)
            signal?.removeEventListener('abort', stop)
            call.done2?.()
            resolve(result)
        }

        const start = child => {
            if (call.done) return release(child)
            pool.busy.set(child, call)

            if (handler.timeout) call.timer = setTimeout(() => {
                retire(child)
                child.kill()
                call.finish({ output: { type: 'error-text', value: `${call.output.text()}\n工具执行超时（${handler.timeout}ms）` }, error: 'timeout' })
            }, handler.timeout)

            try { child.send({ callId: call.id, url: handler.url, name, input }) }
            catch (error) {
                retire(child)
                call.finish({ output: { type: 'error-text', value: `工具执行失败：无法派发到工具进程（${error.message}）` }, error: error.message })
            }
        }

        signal?.addEventListener('abort', stop, { once: true })
        if (signal?.aborted) return stop()

        queue.add(async () => {
            let child
            try { child = await borrow() }
            catch (error) { return call.finish({ output: { type: 'error-text', value: `工具执行失败：工具进程启动失败（${error.message}）` }, error: error.message }) }
            if (call.done) return release(child)
            await new Promise(done => { call.done2 = done; start(child) })
        })
    })
}


// --- 合并工具集合 ---
const merge = (...sets) => ({
    schema: Object.assign(Object.create(null), ...sets.map(set => set.schema ?? {})),
    handlers: Object.assign(Object.create(null), ...sets.map(set => set.handlers ?? {})),
})

export default { from, scan, adopt, execute, merge }
