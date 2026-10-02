/*
技能（skill）这个主体的全部操作都在这里：从目录里找出技能、把技能交给内置工具按需加载。

一个技能就是一个文件夹，里面放一份 SKILL.md：

    skills/
    ├── create-mcp-server/
    │   └── SKILL.md
    └── review-pr/
        └── SKILL.md

SKILL.md 开头是 frontmatter，给系统提示词用；下面正文是操作步骤，加载时才读到：

    ---
    name: review-pr
    description: 审查一个 PR 时使用。包含检查清单和固定话术。
    ---

    # 审查 PR
    1. 先跑测试……

和 Tool.scan 一样，扫描目录得到一份独立结果：

    const skills = await Agent.skill.scan('./skills')
    // skills.list     → [{ name, description, path }]
    // skills.prompt   → 注入 system 的「可用技能」段落；一个技能都没有时是 ''
    // skills.schema   → 内置 skill 工具的描述；没有技能时是 {}
    // skills.handlers → 内置 skill 工具的执行地址；没有技能时是 {}

然后交给 Agent：

    const agent = Agent.create({ config, tools, skills })

**默认零注入。** 不传 skills，system 就是你写的那段，一个字都不多；
传了但目录里一个技能都没有，同样什么都不注入、也不加载内置 skill 工具。
只有真的扫到了技能，才会追加一段技能列表，并挂上那个按需加载的技能工具。
*/

import { fileURLToPath } from 'node:url'
import { jsonSchema } from 'ai'

// 内置技能工具的名字。用 skill 这个名字和 Roo Code / Cline 的习惯一致。
const TOOL = 'skill'

// 一个技能的正文有多大看作者，但描述太长会把系统提示词撑爆。Roo Code 的上限是 1024。
const MAX_DESCRIPTION = 1024


// --- 一份 frontmatter 的最小解析：key: value，每行一个 ---
// 不引入 YAML 库：技能作者写的基本就是几个单行字段，多出来的语法支持属于过度设计。
// 但支持 YAML 的 | 和 >（长描述最常见的写法），把后续缩进行拼起来。
const frontmatter = raw => {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
    if (!match) throw new Error('SKILL.md 缺少 frontmatter：文件开头要用 --- 包住 name 和 description')

    const meta = {}
    const lines = match[1].split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
        const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[index])
        if (!pair) continue
        const [, key, raw] = pair
        if (raw === '|' || raw === '>') { // 长文本：吃掉后面所有缩进行。
            const block = []
            while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) block.push(lines[++index].trim())
            meta[key] = block.join(raw === '>' ? ' ' : '\n')
            continue
        }
        meta[key] = raw.trim().replace(/^["']|["']$/g, '')
    }
    return { meta, body: match[2].trim() }
}


// --- 扫描技能目录，返回一份完全独立的技能集合 ---
// 和 Tool.scan 的规则一致：多个目录时后面的覆盖前面的同名技能，方便「内置技能在前、用户技能在后」。
//
//   Agent.skill.scan('./skills')                          一个目录
//   Agent.skill.scan(builtinDir, userDir)                  多个目录，后面的覆盖前面的同名技能
//   Agent.skill.scan(new URL('./skills', import.meta.url)) 直接给 URL，嵌进别人项目时用这个
const scan = async (...directories) => {
    const skills = new Map() // name → { name, description, path }，同名后扫到的覆盖先扫到的。

    for (const directory of directories.flat()) {
        const cwd = directory instanceof URL ? fileURLToPath(directory) : String(directory)

        let files
        try {
            files = []
            for await (const file of new Bun.Glob('**/SKILL.md').scan({ cwd, absolute: true, onlyFiles: true })) files.push(file)
        } catch (error) {
            if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue // 技能目录还没建是正常状态（就是"没有技能"），不当错误。工具目录走的是另一条规则：写错路径要立刻发现。
            throw error
        }

        for (const file of files) {
            const folder = file.replace(/[\\/]SKILL\.md$/i, '').split(/[\\/]/).pop()
            const { meta } = frontmatter(await Bun.file(file).text())

            if (!meta.name) throw new Error(`${file} 缺少 name：frontmatter 里要写 name: 技能名`)
            if (meta.name !== folder) throw new Error(`${file} 的 name "${meta.name}" 和目录名 "${folder}" 对不上：技能名必须等于它所在的目录名`)
            if (!meta.description) throw new Error(`${file} 缺少 description：要写清什么时候该用这个技能`)
            if (meta.description.length > MAX_DESCRIPTION) throw new Error(`${file} 的 description 太长（${meta.description.length} 字，上限 ${MAX_DESCRIPTION}）`)

            skills.set(meta.name, { name: meta.name, description: meta.description, path: file })
        }
    }

    const list = [...skills.values()].sort((one, two) => one.name.localeCompare(two.name))

    // 一个技能都没有：不注入任何东西，也不挂内置工具。这是默认状态，不是错误。
    if (!list.length) return { list: [], prompt: '', schema: {}, handlers: {} }

    const prompt = [
        '【可用技能】',
        '下面这些技能是现成的操作步骤。当请求和某个技能的说明对得上时，先用 skill 工具把它加载进来，再照着做。',
        '一次只加载一个，不要提前把所有技能都加载进来。',
        '',
        ...list.map(skill => `- ${skill.name}：${skill.description}`),
    ].join('\n')

    const schema = {
        [TOOL]: {
            description: '按名字加载一个技能的完整操作步骤。技能名从系统提示词的「可用技能」列表里选。',
            inputSchema: jsonSchema({
                type: 'object',
                properties: { skill: { type: 'string', description: '要加载的技能名' } },
                required: ['skill'],
            }),
        },
    }
    // builtin 是第三种工具地址：前两种是本地文件（url）和 MCP（mcp），这个是包内置的一小段逻辑，跑在工具子进程里。
    const handlers = { [TOOL]: { builtin: TOOL, skills: Object.fromEntries(list.map(skill => [skill.name, skill.path])) } }

    return { list, prompt, schema, handlers }
}

export default { scan }
