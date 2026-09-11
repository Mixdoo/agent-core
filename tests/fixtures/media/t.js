// 1x1 红点 PNG，用来当"截图"。
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

export default [
    // 截图工具：返回一个已成形的多模态输出块，图片 + 一句说明
    { name: 'screenshot', description: '截图', inputSchema: { type: 'object', properties: {} },
      async execute() {
          return { output: { type: 'content', value: [
              { type: 'text', text: '当前屏幕：' },
              { type: 'media', data: PIXEL, mediaType: 'image/png' },
          ] } }
      } },

    // 图很大、说明文字也很长：截断只能动文字，不能动图
    { name: 'bigshot', description: '大图加长说明', inputSchema: { type: 'object', properties: {} },
      async execute() {
          return { output: { type: 'content', value: [
              { type: 'text', text: 'x'.repeat(200000) },
              { type: 'media', data: PIXEL.repeat(2000), mediaType: 'image/png' },
          ] } }
      } },
]
