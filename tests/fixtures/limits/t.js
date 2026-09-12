// 每个工具进程首次加载时生成自己的身份，用来数池子到底起了几个工具进程。
globalThis.__WID__ ??= Math.random().toString(36).slice(2, 8)

export default [
    { name: 'big', description: '返回一大坨文本（模拟 cat 大日志）',
      inputSchema: { type: 'object', properties: { kb: { type: 'number' } }, required: ['kb'] },
      async execute(input) { return 'x'.repeat(input.kb * 1024) } },

    { name: 'wid', description: '报告自己跑在哪个工具进程里',
      inputSchema: { type: 'object', properties: {} },
      async execute() { await Bun.sleep(80); return globalThis.__WID__ } },

    { name: 'impatient', description: '跑很久，但自己声明了超时', timeout: 250,
      inputSchema: { type: 'object', properties: {} },
      async execute() { await Bun.sleep(30000); return 'never' } },

    { name: 'blocking', description: '阻塞型工具，没声明超时——这是被支持的正常用法',
      inputSchema: { type: 'object', properties: {} },
      async execute() { await Bun.sleep(500); return 'blocked-then-done' } },

    // 边跑边不停输出的阻塞型工具：盯日志、盯设备就是这个形态。
    // 取消它的时候，主线程攒下来的那份实时输出必须是有界的。
    { name: 'chatty', description: '不停输出，永不返回',
      inputSchema: { type: 'object', properties: {} },
      async execute() { while (true) { console.log('x'.repeat(2000)); await Bun.sleep(1) } } },
]
