// 工具名故意用 __proto__：验证工具表不会被写穿对象原型链。
export default { name: '__proto__', description: '名字有陷阱的工具', execute: async () => ({ value: 'ok' }) }
