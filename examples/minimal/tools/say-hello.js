/* 这个文件管一个文件工具：say-hello。

   它演示"文件工具"长什么样：默认导出一个对象，四个字段——
   name / description / inputSchema / execute。
   Agent.tool.from 扫描 ./tools 目录时会动态 import 它，
   所以工具体跑在独立的 bun 子进程里，碰不到主进程的状态，卡死也能被杀掉。
*/

export default {
    name: 'say_hello',
    description: '向指定的人打个招呼',
    // inputSchema 用裸 JSON Schema 描述参数，模型据此生成调用参数。
    inputSchema: {
        type: 'object',
        properties: { who: { type: 'string', description: '要打招呼的对象' } },
        required: ['who'],
    },
    async execute(input) {
        return `你好，${input.who}！`
    },
}
