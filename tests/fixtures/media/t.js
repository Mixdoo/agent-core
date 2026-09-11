// 1x1 红点 PNG，用来当"截图"。
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// AI SDK v7 的图片形状。旧的 { type: 'media' } 是 v5 的名字，v7 的联合类型里根本没有，
// 用错会在 standardizePrompt 本地抛 AI_InvalidPromptError，请求都发不出去，而且写进 history 就永久了。
const image = data => ({ type: 'file', mediaType: 'image/png', data: { type: 'data', data } })

export default [
    // 截图工具：返回一个已成形的多模态输出块，图片 + 一句说明
    { name: 'screenshot', description: '截图', inputSchema: { type: 'object', properties: {} },
      async execute() {
          return { output: { type: 'content', value: [{ type: 'text', text: '当前屏幕：' }, image(PIXEL)] } }
      } },

    // 图很大、说明文字也很长：截断只能动文字，不能动图
    { name: 'bigshot', description: '大图加长说明', inputSchema: { type: 'object', properties: {} },
      async execute() {
          return { output: { type: 'content', value: [{ type: 'text', text: 'x'.repeat(200000) }, image(PIXEL.repeat(2000))] } }
      } },

    // 用已经作废的 v5 形状：必须被沙箱当场挡住，变成一条普通的工具失败
    { name: 'legacyshot', description: '用作废的 media 形状返回图片', inputSchema: { type: 'object', properties: {} },
      async execute() {
          return { output: { type: 'content', value: [{ type: 'media', data: PIXEL, mediaType: 'image/png' }] } }
      } },
]
