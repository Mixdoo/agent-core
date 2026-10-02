// TypeScript 写的工具：Bun 直接执行，scan 和执行都要认得它。
interface Input { a: number; b: number }

export default {
    name: 'multiply',
    description: '两数相乘',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
    async execute(input: Input): Promise<number> {
        return input.a * input.b
    },
}
