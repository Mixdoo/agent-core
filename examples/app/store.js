/* 这个文件管会话历史的落盘。
   包本身只持有内存里的 history（agent.history），它不落盘、也不删。
   历史能不能在重启后还在，是应用层自己的事：这个文件就是应用层替你接的那一环。

   实现故意选最简单的：一个会话一个 JSON 文件，放在 .data/ 目录下。
   生产环境请换成数据库或对象存储；这里的重点是"往哪存、什么时候存"这两个决定由应用层做。

   用法：
     await store.save(id, history)   // 每轮 onStep 之后存一次
     const history = await store.load(id)  // 启动时或第一次访问某个会话时读回来 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = process.env.DATA_DIR || fileURLToPath(new URL('./.data', import.meta.url)) // 默认放在示例目录下，可用 DATA_DIR 覆盖。

// 文件里的 id 可能来自 URL/客户端，清洗一下，别让它拼出 ../ 跑到目录外面。
const fileOf = id => join(dir, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.json`)

// 把内部历史转成纯 JSON：URL 对象和二进制在这里处理掉。
// 本示例的任务只用文字，普通 JSON.stringify 就够；这里多包一层是为了以后加媒体工具时不会悄悄写坏。
const encode = value => JSON.stringify(value, (key, one) =>
    one instanceof Uint8Array ? { $bytes: Buffer.from(one).toString('base64') }
    : one instanceof URL ? one.href
    : one)

export const save = async (id, history) => {
    await mkdir(dir, { recursive: true })
    await Bun.write(fileOf(id), encode(history))
}

// 读不到（没这个会话 / 文件坏了）返回 null，调用方据此决定是新建还是报 404。
export const load = async id => {
    try {
        const text = await Bun.file(fileOf(id)).text()
        return JSON.parse(text)
    } catch {
        return null
    }
}
