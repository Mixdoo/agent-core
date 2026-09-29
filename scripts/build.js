/*
把项目和依赖打成一个可导入的 Bun 文件，并在脱离本项目 node_modules 的临时目录自检。
调用：bun run build。只有自检成功，产物才会写到 dist/agent-core.js。
*/

import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { version } from '../package.json'

const root = fileURLToPath(new URL('../', import.meta.url))   // 项目根目录，按本文件位置算，换目录启动也不跑偏。
const dist = join(root, 'dist', 'agent-core.js')              // 唯一发布产物。
const revision = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: root }).stdout.toString().trim() || 'unknown' // 产物里记下构建时的提交号，排查问题时能对上。

const result = await Bun.build({
    entrypoints: [join(root, 'index.js')], // 从包入口打包，导出什么就打出什么。
    target: 'bun',                         // 只在 Bun 上跑。
    format: 'esm',                         // 保持 ESM。
    packages: 'bundle',                    // 依赖一起打进去，产物可脱离 node_modules 使用。
    minify: true,                          // 压缩体积；压缩不是加密。
    sourcemap: 'none',                     // 不生成 sourcemap。
})
if (!result.success || result.outputs.length !== 1) throw new Error(`打包失败：${result.logs.join('\n')}`) // 打包失败就直接报错，不产出半成品。

const temp = await mkdtemp(join(tmpdir(), 'agent-core-')) // 在一个没有 node_modules 的临时目录里自检，确认产物真的能独立跑。
try {
    const filename = join(temp, 'agent-core.js')
    await Bun.write(filename, `// @kernel4632/agent-core ${version} (${revision})\n${await result.outputs[0].text()}`) // 首行写上版本和提交号，一眼能看出产物对应哪次构建。

    // 在没有 node_modules 的临时目录导入，跑一遍模型请求和工具子进程。
    const server = Bun.serve({
        port: 0,
        async fetch(request) {
            const body = await request.json()
            const content = body.response_format ? '{"total":42}' : 'ok' // 同时自检普通回答和结构化回答。
            return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: {} })
        },
    })
    try {
        const script = `
            import Agent from ${JSON.stringify(pathToFileURL(filename).href)}
            if (Agent.version !== ${JSON.stringify(version)}) throw new Error('版本不匹配')
            const tools = await Agent.tool.scan(${JSON.stringify(join(root, 'tests', 'fixtures', 'tools'))})
            const output = await Agent.tool.execute({ name: 'echo', input: { value: 'build' }, handlers: tools.handlers })
            if (output.output.value !== 'done:build') throw new Error('工具子进程失败')
            const remote = await Agent.tool.mcp({ transport: { type: 'stdio', command: process.execPath, args: [${JSON.stringify(join(root, 'tests', 'fixtures', 'mcp-server.js'))}] } })
            const reply = await Agent.tool.execute({ name: 'echo', input: { value: 'mcp-build' }, handlers: remote.handlers })
            if (reply.output.value[0].text !== 'mcp-build') throw new Error('打包后的 MCP 子进程失败')
            const result = await Agent.llm.chat({ baseURL: ${JSON.stringify(`http://127.0.0.1:${server.port}/v1`)}, model: 'test', messages: [{ role: 'user', content: 'hi' }], stream: false })
            if (result.text !== 'ok') throw new Error('模型请求失败')
            const agent = Agent.create({ config: { baseURL: ${JSON.stringify(`http://127.0.0.1:${server.port}/v1`)}, model: 'test', stream: false,
                output: Agent.output.object({ schema: Agent.schema.object({ total: Agent.schema.number() }) }) } })
            const run = agent.stream('total')
            const response = run.response()
            const events = await response.text()
            if ((await run.result).output.total !== 42 || !events.includes('finish')) throw new Error('结构化结果和网页流式出口失败')
        `
        const child = Bun.spawn([process.execPath, '-e', script], { cwd: temp, stdout: 'pipe', stderr: 'pipe' })
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
        if (code !== 0) throw new Error(`独立产物自检失败：${stderr}`)
    } finally { server.stop(true) }

    await mkdir(join(root, 'dist'), { recursive: true })
    await copyFile(filename, dist) // 自检通过才替换发布产物；失败时保留上一次可用的文件。
    await rm(join(root, 'dist', 'agent-core.standalone.js'), { force: true }) // 旧构建留下的第二份产物容易被误当成最新版本。
    console.log(`已构建 dist/agent-core.js (${(await Bun.file(dist).size / 1048576).toFixed(2)} MB, ${revision})`)
} finally { await rm(temp, { recursive: true, force: true }) }
