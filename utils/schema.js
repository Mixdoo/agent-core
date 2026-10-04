/*
归一化一个工具的 inputSchema 字段：接受三种写法，统一输出 AI SDK 认识的 Schema 对象。

    1. 已经是 AI SDK Schema（带 jsonSchema 字段）→ 原样返回。
    2. 实现了 ~standard 接口的 zod / valibot schema → 原样返回（AI SDK 认识它）。
    3. 裸 JSON Schema 对象 / undefined / null → 用 jsonSchema() 包一层，补上 type:'object' 和空 properties。

scan 和 adopt 都要做这件事，提出来共用，规则只写一处。
*/

import { jsonSchema } from 'ai'

const normalizeInputSchema = schema => {
    if (schema?.['~standard']) return schema          // zod / valibot 等标准 schema，AI SDK 直接认。
    if (schema?.jsonSchema) return schema              // 已经是 AI SDK jsonSchema() 的产物，原样返回。
    return jsonSchema({ type: 'object', properties: {}, ...schema }) // 裸 JSON Schema 或空 schema，补齐必要字段。
}

export default normalizeInputSchema
