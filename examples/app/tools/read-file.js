/* 这个文件管一个文件工具：read_file。
   它读取"工作目录"里的一个文本文件，演示两件事：
     1. 文件工具怎么写、怎么把结果返回给模型；
     2. 限制路径，别让模型用 ../../ 读到工作目录外面的文件。

   工作目录默认是本示例目录（tools 的上一级）。想换目录就设环境变量 TOOL_ROOT。
   注意：工具进程和 Agent 同权限（见仓库的 tool-process.js 说明），
   所以"只能读哪里"必须由工具自己把关，包不会替它挡。 */

import { fileURLToPath } from 'node:url'
import { isAbsolute, relative, resolve } from 'node:path'

const root = resolve(process.env.TOOL_ROOT || fileURLToPath(new URL('..', import.meta.url)))
const MAX = 4000 // 回给模型的文字上限，太长的文件截断，避免一把撑爆上下文。

export default {
    name: 'read_file',
    description: '读取工作目录下的一个文本文件，参数 path 是相对工作目录的路径',
    inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对工作目录的文件路径，例如 README.md' } },
        required: ['path'],
    },
    async execute({ path }) {
        const target = resolve(root, path)
        const rel = relative(root, target)
        // 解析后如果跳出了工作目录，relative 会以 .. 开头，或变成另一个盘符的绝对路径。
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`只能读取工作目录内的文件：${path}`)

        const file = Bun.file(target)
        if (!(await file.exists())) throw new Error(`文件不存在：${path}`)
        const text = await file.text()
        return text.length > MAX ? `${text.slice(0, MAX)}\n……（文件过长，已截断）` : text
    },
}
