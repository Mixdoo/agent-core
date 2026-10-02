/*
一条命令发布新版：先把 package.json 的 version 改好，再运行 `bun run release`。

它做四件事：
  1. 检查工作区干净（有没提交的改动就先停下来，避免发布的内容和仓库对不上）
  2. 跑测试
  3. 打两个安装包（打包时自动构建并自检，自检不过不会产出）：
       agent-core.tgz                    固定名字，README 里的 latest 链接永远指向最新版，发新版不用改文档
       kernel4632-agent-core-X.Y.Z.tgz   带版本号，需要锁死某个版本时用
  4. 在 GitHub 建一个 vX.Y.Z 的 Release，把两个包都传上去

安装（永远拿最新版）：
    bun add https://github.com/kernel4632/agent-core/releases/latest/download/agent-core.tgz

发布需要本机装好并登录 gh（GitHub 命令行）。npm 那边有账号后，也能改用 `bun run publish:npm`。
*/

import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { version } from '../package.json'

const root = fileURLToPath(new URL('../', import.meta.url))
const slug = new URL(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).repository.url.replace(/^git\+/, '')).pathname.replace(/^\/|\.git$/g, '') // 从仓库地址里取出 kernel4632/agent-core。
const pinned = `kernel4632-agent-core-${version}.tgz`

const run = (command, args) => {
    const result = Bun.spawnSync([command, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    const out = result.stdout.toString().trim()
    if (result.exitCode !== 0) throw new Error(`${command} ${args.join(' ')} 失败：\n${result.stderr.toString().trim() || out}`)
    return out
}

// --- 1. 工作区必须干净：发布的内容要和仓库里的某一个提交对得上 ---
const dirty = run('git', ['status', '--porcelain'])
if (dirty) throw new Error(`工作区还有没提交的改动，先提交或撤销：\n${dirty}`)

// --- 2. 先跑测试：发出去的必须是测过的版本 ---
console.log(`测试 v${version}…`)
run('bun', ['test'])

// --- 3. 打两个包。bun pm pack 会先触发 prepack（构建 + 产物自检），自检不过不会产出 ---
console.log('构建并打包…')
run('bun', ['pm', 'pack', '--filename', 'agent-core.tgz', '--quiet'])
run('bun', ['pm', 'pack', '--quiet'])

// --- 4. 建 Release 并上传。同名 Release 已存在时改为补传，不报错 ---
const notes = `轻量的 AI Agent 核心：给它模型地址和工具文件，自动循环「问模型 → 执行工具 → 再问模型」。支持 OpenAI Chat / Responses、Anthropic、Gemini 四种协议，工具、MCP、技能、上下文压缩、提示词缓存；纯对话模型也能用工具。`
const tag = `v${version}`
const exists = Bun.spawnSync(['gh', 'release', 'view', tag, '--repo', slug], { cwd: root, stdout: 'ignore', stderr: 'ignore' }).exitCode === 0 // 查不到时 gh 以非零退出，这里只关心有没有，不当错误。
try {
    if (exists) run('gh', ['release', 'upload', tag, 'agent-core.tgz', pinned, '--clobber', '--repo', slug])
    else run('gh', ['release', 'create', tag, 'agent-core.tgz', pinned, '--title', tag, '--notes', notes, '--repo', slug])
} finally {
    await Promise.all([rm(`${root}agent-core.tgz`, { force: true }), rm(`${root}${pinned}`, { force: true })]) // 打出来的包只用于上传，不留在工作区。
}

console.log(`\n已发布 ${tag}`)
console.log(`装最新版：bun add https://github.com/${slug}/releases/latest/download/agent-core.tgz`)
