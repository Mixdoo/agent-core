/*
把项目和依赖打成一个可导入的 Bun 文件，并在脱离本项目 node_modules 的临时目录自检。
调用：bun run build。只有自检成功，产物才会写到 dist/agent-core.js。
*/

import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { version } from '../package.json'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = join(root, 'dist', 'agent-core.js')
const revision = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: root }).stdout.toString().trim() || 'unknown'

const result = await Bun.build({
    entrypoints: [join(root, 'index.js')],
    target: 'bun',
    format: 'esm',
    packages: 'bundle',
    minify: true,
    sourcemap: 'none',
})
if (!result.success || result.outputs.length !== 1) throw new Error(`打包失败：${result.logs.join('\n')}`)

const temp = await mkdtemp(join(tmpdir(), 'agent-core-'))
try {
    const filename = join(temp, 'agent-core.js')
    await Bun.write(filename, `// @kernel4632/agent-core ${version} (${revision})\n${await result.outputs[0].text()}`)

    // 在没有 node_modules 的临时目录导入，跑一遍模型请求和工具子进程。
    const server = Bun.serve({
        port: 0,
        fetch: () => Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} }),
    })
    try {
        const script = `
            import Agent from ${JSON.stringify(pathToFileURL(filename).href)}
            if (Agent.version !== ${JSON.stringify(version)}) throw new Error('版本不匹配')
            const tools = await Agent.tool.scan(${JSON.stringify(join(root, 'tests', 'fixtures', 'tools'))})
            const output = await Agent.tool.execute({ name: 'echo', input: { value: 'build' }, handlers: tools.handlers })
            if (output.output.value !== 'done:build') throw new Error('工具子进程失败')
            const result = await Agent.llm.chat({ baseURL: ${JSON.stringify(`http://127.0.0.1:${server.port}/v1`)}, model: 'test', messages: [{ role: 'user', content: 'hi' }], stream: false })
            if (result.text !== 'ok') throw new Error('模型请求失败')
        `
        const child = Bun.spawn([process.execPath, '-e', script], { cwd: temp, stdout: 'pipe', stderr: 'pipe' })
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
        if (code !== 0) throw new Error(`独立产物自检失败：${stderr}`)
    } finally { server.stop(true) }

    await mkdir(join(root, 'dist'), { recursive: true })
    await copyFile(filename, dist) // 自检通过才替换发布产物；失败时保留上一次可用的文件。
    console.log(`已构建 dist/agent-core.js (${(await Bun.file(dist).size / 1048576).toFixed(2)} MB, ${revision})`)
} finally { await rm(temp, { recursive: true, force: true }) }
