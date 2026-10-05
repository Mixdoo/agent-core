/* 这个文件管一个文件工具：now。
   它返回服务器当前时间，用来演示"文件工具"长什么样：默认导出 { name, description, inputSchema, execute }。
   Agent.tool.from 扫描 ./tools 目录时会动态 import 它，工具体跑在独立的 bun 子进程里。
   它没有参数，inputSchema 写一个空的 object。 */

export default {
    name: 'now',
    description: '返回服务器当前的日期和时间',
    inputSchema: {
        type: 'object',
        properties: {},
    },
    async execute() {
        return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    },
}
