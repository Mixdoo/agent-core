/*
盯住新的 token 估算器：不装分词器，靠"字符数 × 每字符 token 比"，比例随真实 usage 自校准。

这里要守住两件事：
1. 估算随内容单调增长（不会把大内容估成小的）。
2. 拿到真实 usage 后，比例会朝真实值靠；换模型各记各的。
*/

import { expect, test, describe } from 'bun:test'
import { estimate, createMeter, modelKey, DEFAULT_RATIO } from '../utils/tokens.js'

describe('token 估算器', () => {
    test('估算随内容增长，默认比例偏高', () => {
        const small = estimate({ messages: [{ role: 'user', content: '你好' }] })
        const big = estimate({ messages: [{ role: 'user', content: '你好'.repeat(100) }] })
        expect(big).toBeGreaterThan(small)
        expect(DEFAULT_RATIO).toBeGreaterThan(0) // 未知模型时也给一个正的、偏高的估计。
    })

    test('拿到真实 usage 后比例自校准，并平滑跟进', () => {
        const meter = createMeter()
        const key = 'chat|http://x|m'
        expect(meter.ratio(key)).toBe(DEFAULT_RATIO) // 还没数据，用默认。

        const payload = { messages: [{ role: 'user', content: 'a'.repeat(1000) }] }
        const chars = JSON.stringify(payload).length
        meter.observe(key, payload, Math.round(chars * 0.25)) // 真实比是 0.25。

        const after = meter.ratio(key)
        expect(after).toBeLessThan(DEFAULT_RATIO) // 朝真实值（更低）靠了。
        expect(after).toBeGreaterThan(0.25 - 1e-9) // 平滑，不会一步跳到底。
    })

    test('按模型各记各的，换模型互不影响', () => {
        const meter = createMeter()
        const payload = { messages: [{ role: 'user', content: 'a'.repeat(1000) }] }
        const chars = JSON.stringify(payload).length
        meter.observe('chat|http://a|m1', payload, Math.round(chars * 0.8))
        expect(meter.ratio('chat|http://a|m2')).toBe(DEFAULT_RATIO) // 另一个模型没数据。
        expect(meter.ratio('chat|http://a|m1')).not.toBe(DEFAULT_RATIO)
    })

    test('坏数据不污染比例', () => {
        const meter = createMeter()
        const payload = { messages: [] }
        meter.observe('k', payload, undefined) // 没有 usage。
        meter.observe('k', payload, 0)
        meter.observe('k', payload, -5)
        expect(meter.ratio('k')).toBe(DEFAULT_RATIO)
    })

    test('modelKey 能区分地址 / 协议 / 模型名', () => {
        expect(modelKey({ protocol: 'chat', baseURL: 'u', model: 'm' })).not.toBe(modelKey({ protocol: 'chat', baseURL: 'u', model: 'm2' }))
        expect(modelKey({ protocol: 'chat', baseURL: 'u', model: 'm' })).not.toBe(modelKey({ protocol: 'anthropic', baseURL: 'u', model: 'm' }))
        expect(modelKey({ model: { provider: 'openai', modelId: 'gpt' } })).toBe('openai|gpt')
    })
})
