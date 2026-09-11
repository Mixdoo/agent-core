// 每个 Worker 首次加载时生成自己的身份，用来数池子到底起了几个 Worker。
globalThis.__WID__ ??= Math.random().toString(36).slice(2, 8)

export default [
    { name: 'big', description: '返回一大坨文本（模拟 cat 大日志）',
      inputSchema: { type: 'object', properties: { kb: { type: 'number' } }, required: ['kb'] },
      async execute(input) { return 'x'.repeat(input.kb * 1024) } },

    { name: 'wid', description: '报告自己跑在哪个 Worker 里',
      inputSchema: { type: 'object', properties: {} },
      async execute() { await Bun.sleep(80); return globalThis.__WID__ } },

    { name: 'impatient', description: '跑很久，但自己声明了超时', timeout: 250,
      inputSchema: { type: 'object', properties: {} },
      async execute() { await Bun.sleep(30000); return 'never' } },

    { name: 'blocking', description: '阻塞型工具，没声明超时——这是被支持的正常用法',
      inputSchema: { type: 'object', properties: {} },
      async execute() { await Bun.sleep(500); return 'blocked-then-done' } },
]
