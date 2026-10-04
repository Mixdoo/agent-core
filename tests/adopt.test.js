/*
盯住内存工具这条路：Tool.adopt 把常规工具对象（数组 / record / AI SDK / MCP toolset 形状）
归一化成和 scan 一样的 { schema, handlers }，执行结果和文件工具守同一套成形规则。
*/

import { expect, test, describe } from 'bun:test'
import { jsonSchema } from 'ai'
import { z } from 'zod'
import Agent from '../index.js'
import Tool from '../features/tool.js'
import { TOOLS } from './helpers.js'

const echo = { description: '回声', inputSchema: { type: 'object', properties: { value: { type: 'string' } } }, execute: async input => `echo:${input.value}` }

describe('Tool.adopt 归一化', () => {
    test('record 形状：名字从键来', () => {
        const tools = Tool.adopt({ echo })
        expect(tools.schema.echo.description).toBe('回声')
        expect(tools.schema.echo.inputSchema.jsonSchema.properties.value.type).toBe('string')
        expect(typeof tools.handlers.echo.execute).toBe('function')
        expect(tools.schema.echo.execute).toBeUndefined() // 执行函数不给模型看。
    })

    test('数组形状：名字从 name 字段来', () => {
        const tools = Tool.adopt([{ name: 'echo', ...echo }])
        expect(Object.keys(tools.schema)).toEqual(['echo'])
    })

    test('三种 inputSchema 写法都认，缺字段补齐', () => {
        const tools = Tool.adopt({
            raw: { execute: async () => 1, inputSchema: { properties: { a: { type: 'string' } } } },
            sdk: { execute: async () => 1, inputSchema: jsonSchema({ type: 'object', properties: { b: { type: 'number' } } }) },
            zod: { execute: async () => 1, inputSchema: z.object({ c: z.string() }) },
            none: { execute: async () => 1 },
        })
        expect(tools.schema.raw.inputSchema.jsonSchema).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
        expect(tools.schema.sdk.inputSchema.jsonSchema.properties.b.type).toBe('number')
        expect(tools.schema.zod.inputSchema['~standard']).toBeDefined()
        expect(tools.schema.none.inputSchema.jsonSchema).toEqual({ type: 'object', properties: {} })
    })

    test('已归一化的集合原样通过，null 变空集合，无 execute 的工具当场报错', async () => {
        const scanned = await Tool.scan(TOOLS)
        expect(Tool.adopt(scanned)).toBe(scanned)
        expect(Object.keys(Tool.adopt(null).schema)).toEqual([])
        expect(() => Tool.adopt({ junk: { description: '没有 execute' } })).toThrow(/execute/) // 看起来是工具却没 execute：报错，不静默丢弃。
        expect(() => Tool.adopt({ schema: {}, handlers: undefined })).toThrow(/handlers/)      // 半份集合也报错。
    })

    test('单个工具对象直接传，不用包成数组', () => {
        const tools = Tool.adopt({ name: 'echo', ...echo })
        expect(Object.keys(tools.schema)).toEqual(['echo'])
    })

    test('__proto__ 当工具名不会污染原型链', () => {
        const tools = Tool.adopt([{ name: '__proto__', execute: async () => 1 }])
        expect(Object.getPrototypeOf(tools.schema)).toBeNull()
        expect({}.execute).toBeUndefined()
    })
})

describe('内存工具执行', () => {
    const run = (tools, name, input = {}, extra = {}) => Tool.execute({ name, input, handlers: Tool.adopt(tools).handlers, ...extra })

    test('字符串、对象、空返回分别成形', async () => {
        expect((await run({ echo }, 'echo', { value: 'x' })).output).toEqual({ type: 'text', value: 'echo:x' })
        expect((await run({ obj: { execute: async () => ({ a: 1 }) } }, 'obj')).output).toEqual({ type: 'json', value: { a: 1 } })
        expect((await run({ nil: { execute: async () => null } }, 'nil')).output.value).toContain('没有输出')
    })

    test('toModelOutput 用 AI SDK 签名接管成形（MCP CallToolResult 走这条路）', async () => {
        const mcpLike = { execute: async () => ({ content: [{ type: 'text', text: 'hi' }] }), toModelOutput: ({ output }) => ({ type: 'content', value: output.content }) }
        expect((await run({ mcpLike }, 'mcpLike')).output).toEqual({ type: 'content', value: [{ type: 'text', text: 'hi' }] })
    })

    test('抛错变成工具失败，非法块也挡住', async () => {
        const boom = await run({ boom: { execute: async () => { throw new Error('炸了') } } }, 'boom')
        expect(boom.error).toBe('炸了')
        expect(boom.output.type).toBe('error-text')
        const bad = await run({ bad: { execute: async () => 1, toModelOutput: () => ({ type: 'nope' }) } }, 'bad')
        expect(bad.output.type).toBe('error-text')
    })

    test('stop:true 透出，截断和文件工具同一条规则', async () => {
        expect((await run({ done: { execute: async () => ({ output: '完成', stop: true }) } }, 'done')).stop).toBe(true)
        const long = await run({ long: { execute: async () => 'x'.repeat(5000) } }, 'long', {}, { limit: 1000 })
        expect(long.output.value).toContain('输出过长')
    })

    test('signal 用 signal 和 abortSignal 两个键透传（AI SDK 工具读 abortSignal），并跟随外部取消', async () => {
        let got
        const controller = new AbortController()
        await run({ sig: { execute: async (input, { signal, abortSignal }) => { got = { signal, abortSignal }; return 'ok' } } }, 'sig', {}, { signal: controller.signal })
        expect(got.signal).toBe(got.abortSignal)          // 两个键指向同一个信号，工具读哪个都行。
        expect(got.signal).toBeInstanceOf(AbortSignal)
        controller.abort()
        expect(got.signal.aborted).toBe(true)             // 外部取消能传到工具。
    })

    test('内存工具声明 timeout 时按超时结算，并把取消信号给到工具', async () => {
        let sawAbort = false
        const tool = {
            execute: (input, { abortSignal }) => new Promise(resolve => {
                abortSignal.addEventListener('abort', () => { sawAbort = true; resolve('晚了') })
            }),
            timeout: 40,
        }
        const result = await run({ slow: tool }, 'slow')
        expect(result.error).toContain('超时')     // 到点按超时结算，不无限等。
        expect(result.output.type).toBe('error-text')
        expect(sawAbort).toBe(true)                 // 同时把取消信号发给工具，让它有机会收手。
    })
    test('同步返回的内存工具不是失败', async () => {
        const result = await run({ sync: { execute: () => '同步结果' } }, 'sync')
        expect(result.output).toEqual({ type: 'text', value: '同步结果' })
    })

    test('取消信号一到就按中断结算，不等不响应取消的工具', async () => {
        const controller = new AbortController()
        const hanging = { execute: () => new Promise(() => {}) } // 永远不结算、也不理 signal。
        const pending = run({ hang: hanging }, 'hang', {}, { signal: controller.signal })
        controller.abort()
        const result = await pending
        expect(result.interrupted).toBe(true) // stop()/下一次 send() 因此不会被永久卡住。
    })

    test('内存生成器工具：每个 yield 实时发出，全部片段作为结果', async () => {
        const seen = []
        const result = await run({ gen: { execute: async function* () { yield 'a'; yield 'b' } } }, 'gen', {}, { onOutput: output => seen.push(output.data) })
        expect(result.output).toEqual({ type: 'json', value: ['a', 'b'] }) // 和文件工具一样，片段收齐当返回值。
        expect(seen).toEqual(['a', 'b'])                                   // 逐段实时送达上层。
    })
})

describe('Tool.from 一行拼装', () => {
    test('目录、record、数组、已装好的集合混着传，按顺序合并', async () => {
        const scanned = await Tool.scan(TOOLS)
        const tools = await Tool.from(TOOLS, scanned, { echo }, [{ name: 'extra', execute: async () => 1 }])
        expect(Object.keys(tools.schema).sort()).toEqual(['echo', 'extra', 'noschema', 'partialschema', 'stream'])
        expect(tools.handlers.echo.execute).toBeDefined() // 后传的 record 覆盖了目录里的 echo。
        expect(tools.handlers.echo.url).toBeUndefined()
    })

    test('接受 Promise，也接受 null', async () => {
        const tools = await Tool.from(Promise.resolve({ a: { execute: async () => 'a' } }), null)
        expect(Object.keys(tools.schema)).toEqual(['a'])
        expect(Object.keys((await Tool.from(null)).schema)).toEqual([])
    })

    test('收一组目录（字符串数组），也收工具数组', async () => {
        const dirs = await Tool.from([TOOLS, TOOLS]) // 全是路径 → 当成一组目录分别扫。
        expect(dirs.schema.echo).toBeDefined()
        const list = await Tool.from([{ name: 'x', execute: async () => 1 }]) // 工具数组 → 交给 adopt。
        expect(list.schema.x).toBeDefined()
    })
})

describe('Agent 自动归一化', () => {
    const model = () => {
        const server = Bun.serve({
            port: 0,
            async fetch(request) {
                const body = await request.json()
                const done = body.messages.filter(message => message.role === 'tool').length
                const names = ['echo', 'file']
                const message = done < names.length
                    ? { role: 'assistant', content: null, tool_calls: [{ id: `c${done}`, type: 'function', function: { name: names[done], arguments: '{"value":"v"}' } }] }
                    : { role: 'assistant', content: '好' }
                return Response.json({ choices: [{ index: 0, message, finish_reason: done < names.length ? 'tool_calls' : 'stop' }], usage: {} })
            },
        })
        return { server, config: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'm', stream: false } }
    }

    test('create 直接收 record，文件工具和内存工具合并后同一次 send 都调到', async () => {
        const { server, config } = model()
        const results = []
        try {
            const files = await Tool.scan(TOOLS)
            const file = { file: { execute: async () => 'file-ok' } }
            const agent = Agent.create({ config, tools: Tool.merge(files, Tool.adopt({ echo, ...file })), callbacks: { onToolResult: one => results.push(one) } })
            await agent.send('跑')
            expect(results.map(one => one.toolName)).toEqual(['echo', 'file'])
            expect(results[0].output.value).toBe('echo:v')
        } finally { server.stop(true) }
    })

    test('create 收数组、send 收 record 都自动归一化', () => {
        const agent = Agent.create({ tools: [{ name: 'echo', ...echo }] })
        expect(typeof agent.tools.handlers.echo.execute).toBe('function')
        expect(Object.keys(Agent.create().tools.schema)).toEqual([])
    })

    test('send 收目录字符串时现扫生效；create 收目录会明确报错而不是静默空表', async () => {
        const server = Bun.serve({
            port: 0,
            async fetch(request) {
                const body = await request.json()
                const answered = body.messages.some(message => message.role === 'tool')
                const message = answered
                    ? { role: 'assistant', content: '好' }
                    : { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"value":"v"}' } }] }
                return Response.json({ choices: [{ index: 0, message, finish_reason: answered ? 'stop' : 'tool_calls' }], usage: {} })
            },
        })
        try {
            const agent = Agent.create({ config: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'm', stream: false } })
            await agent.send({ input: '跑', tools: './tests/fixtures/tools' }) // 相对进程当前目录；目录在这一刻才扫描。
            expect(agent.tools.schema.echo).toBeDefined()
            expect(() => Agent.create({ tools: './tools' })).toThrow(/Tool.from/)
        } finally { server.stop(true) }
    })
})
