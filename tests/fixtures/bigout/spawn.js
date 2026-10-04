// 测试用：spawn 一个子进程写 9MB 输出，再把它整段读回来。
// 用来验证工具进程转发子进程输出时不会静默截断（超上限的是留给工具读的缓冲，不是转发本身）。
export default {
    name: 'bigout',
    description: '读回一个子进程写的 9MB 输出，返回它的长度',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
        const size = 9 * 1024 * 1024
        const child = Bun.spawn([process.execPath, '-e', `process.stdout.write('x'.repeat(${size}))`], { stdout: 'pipe' })
        const decoder = new TextDecoder()
        let text = ''
        for await (const chunk of child.stdout) text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
        await child.exited
        return { length: text.length }
    },
}
