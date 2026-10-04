/*
本地 token 估算：不装分词器，改用"字符数 × 每字符多少 token"来估。

比例是**会自校准**的：每轮模型都会回 usage.inputTokens（这一次请求真实的总输入 token 数），
拿它除以这次发出去内容的字符数，就得到这个模型真实的"每字符 token 比"，记下来给下一轮用。
换模型就换一条记录，越用越准——不需要内置任何分词表。

为什么不内置分词器：一张分词表只对应一个模型，而这个包会在一轮任务里换模型
（config.compact 的压缩模型、send 时覆盖 model、换 provider），换一次分词器就错一次。
用真实 usage 反推则天然跟着模型走。

默认比例取得偏大（宁可高估、早一点压缩，也不要低估、把上下文撑爆）。
*/

export const DEFAULT_RATIO = 0.6 // 每字符大约多少 token。偏高：未知模型时宁可早压缩。
const MIN_RATIO = 0.1
const MAX_RATIO = 2
const SMOOTH = 0.3 // 新样本占的权重；越小越稳，越大越快跟上。

const clamp = ratio => Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))

// 给一个模型起个稳定的名字：换地址、换协议、换模型名都会算作不同模型。
export const modelKey = llm => {
    if (typeof llm?.model === 'string') return `${llm.protocol ?? ''}|${llm.baseURL ?? ''}|${llm.model}`
    const model = llm?.model
    return `${model?.provider ?? ''}|${model?.modelId ?? ''}`
}

// 估一段内容的 token：和真正发出去的形状一样先序列化，再乘比例。
export const estimate = (payload, ratio = DEFAULT_RATIO) => Math.ceil(JSON.stringify(payload).length * clamp(ratio))

// --- 一个按模型记账、会自校准的估算器 ---
export const createMeter = () => {
    const ratios = new Map() // 模型名 → 每字符 token 比

    return {
        ratio: key => ratios.get(key) ?? DEFAULT_RATIO,
        // 观测一次真实结果：payload 是这次发出去的内容，real 是模型回的真实输入 token 数。
        observe: (key, payload, real) => {
            if (!key || !Number.isFinite(real) || real <= 0) return
            const chars = JSON.stringify(payload).length
            if (!chars) return
            const sample = clamp(real / chars)
            const old = ratios.get(key)
            ratios.set(key, old === undefined ? sample : old * (1 - SMOOTH) + sample * SMOOTH)
        },
    }
}
