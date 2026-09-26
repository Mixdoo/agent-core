/*
盯住"图片这类媒体内容能不能进得去、出得来、不被切坏"。

多模态是两条路：用户把图发进来（agent.send 直接收内容块数组），
工具把图交回去（工具返回成形的 content 块）。两条路都不能把 history 毒死——
history 只增不删，一条形状非法的消息写进去就是永久的，之后每次 send 都撞同一个错。
*/

import { expect, test, describe } from 'bun:test'
import Agent from '../index.js'
import History from '../utils/history.js'
import Context from '../features/context.js'
import Tool from '../features/tool.js'
import { MEDIA } from './helpers.js'

describe('多模态', () => {
    const shot = [{ type: 'text', text: '这是什么' }, { type: 'image', image: 'data:image/png;base64,iVBORw0KGgo=' }]

    test('用户消息可以带图片', () => {
        // AI SDK 的 UserContent 本来就是 string | Array<TextPart | ImagePart | FilePart>，
        // 以前是 History.user 自己只收字符串，把门关上了——电脑任务 agent 连截图都递不进去。
        expect(History.user({ content: shot }).content).toEqual(shot)
        expect(History.user({ content: '还是纯文本' }).content).toBe('还是纯文本') // 字符串照旧，不强行包成数组。
    })

    test('空的内容块数组仍然被拒绝', () => {
        expect(() => History.user({ content: [] })).toThrow('empty array') // 空消息会被供应商拒收。
    })

    test('agent.send 可以直接发图片', async () => {
        const agent = Agent.create() // 没配 baseURL，这次 send 必然失败——我们只关心它没在入口那道检查就被拒掉。
        const error = await agent.send({ input: shot }).catch(caught => caught)

        expect(String(error?.message ?? '')).not.toContain('input must be')
        expect(agent.history[0].content).toEqual(shot) // 图片原样进了历史。
    })

    test('图片能原样走到发给模型的消息里', () => {
        const { messages } = Context.build({ history: [History.user({ content: shot })] })
        expect(messages[0].content).toEqual(shot) // 裁剪只摘思考和没人应答的调用，不碰图片。
    })

    test('工具返回已成形的输出块时不再被二次包装', async () => {
        // README 里 finish 工具就是 return { output: { type:'text', value } } 这么写的。
        // 以前会被当成普通返回值再套一层，模型看到 {"type":"json","value":{"type":"text",...}}。
        const tools = await Tool.scan(MEDIA)
        const result = await Tool.execute({ name: 'screenshot', input: {}, handlers: tools.handlers, limit: 32000 })

        expect(result.output.type).toBe('content')
        expect(result.output.value.map(part => part.type)).toEqual(['text', 'file'])
    })

    test('截断只动文字，图片一个字节都不碰', async () => {
        const tools = await Tool.scan(MEDIA)
        const result = await Tool.execute({ name: 'bigshot', input: {}, handlers: tools.handlers, limit: 32000 })
        const [words, media] = result.output.value

        expect(words.text.length).toBeLessThan(33000)            // 20 万字的说明该截还是截。
        expect(words.text).toContain('输出过长')
        expect(media.data.data.length).toBeGreaterThan(100000)   // 图截一刀就彻底废了，必须原样放行。
        expect(media.mediaType).toBe('image/png')
    })

    test('作废的 media 形状被当场挡住，而不是穿过去毒死 history', async () => {
        // { type:'media' } 是 AI SDK v5 的名字，v7 的联合类型里没有。让它穿过去的话，
        // AI SDK 会在 standardizePrompt 本地抛 AI_InvalidPromptError——请求发不出去、Retry 认不出来、
        // 而 history 只增不删，于是之后每次 send 都撞同一个错，重启装回历史也一样。
        const tools = await Tool.scan(MEDIA)
        const result = await Tool.execute({ name: 'legacyshot', input: {}, handlers: tools.handlers, limit: 32000 })

        expect(result.error).toBeTruthy()
        expect(result.output.type).toBe('error-text')
        expect(result.output.value).toContain('media')           // 错误信息要说清楚哪个部件不合法。
        expect(result.output.value).toContain('file')            // 以及该用什么。
    })
})
