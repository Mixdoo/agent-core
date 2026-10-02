/*
盯住技能这条路：目录里每个技能一份 SKILL.md，扫到的才注入系统提示词、才挂内置的 skill 工具。

两条硬要求：
1. 默认零注入——没传 skills、或目录里没有技能时，system 一个字节都不多，工具表也不动。
2. 技能的正文只在模型主动调用 skill 工具时才读出来，不提前塞进上下文。
*/

import { expect, test, describe } from 'bun:test'
import Agent from '../index.js'
import Skill from '../features/skill.js'
import Tool from '../features/tool.js'

const SKILLS = new URL('./fixtures/skills', import.meta.url)
const EMPTY = new URL('./fixtures/empty-skills', import.meta.url)

// 一个记下每次请求体的假模型：先让模型调用 skill 工具，拿到正文后再收尾。
const server = () => {
    const requests = []
    let round = 0
    const bun = Bun.serve({
        port: 0,
        async fetch(request) {
            const body = await request.json()
            requests.push(body)
            round += 1
            if (round === 1) {
                return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'skill', arguments: JSON.stringify({ skill: 'greet' }) } }] }, finish_reason: 'tool_calls' }], usage: {} })
            }
            return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '你好呀！' }, finish_reason: 'stop' }], usage: {} })
        },
    })
    return { server: bun, requests }
}
const config = port => ({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'm', stream: false })


describe('扫描技能目录', () => {
    test('读出每个技能的名字、说明和路径；支持 YAML 的 | 多行说明', async () => {
        const skills = await Skill.scan(SKILLS)
        expect(skills.list.map(one => one.name)).toEqual(['greet', 'summarize'])
        expect(skills.list.find(one => one.name === 'greet').description).toBe('需要一个友好问候语时使用。')
        expect(skills.list.find(one => one.name === 'summarize').description).toContain('压缩成要点')
    })

    test('注入的提示词只含名字和说明，不含正文', async () => {
        const { prompt } = await Skill.scan(SKILLS)
        expect(prompt).toContain('可用技能')
        expect(prompt).toContain('greet')
        expect(prompt).not.toContain('热情的问候') // 正文要等加载时才出现。
    })

    test('空目录：不注入、不挂工具', async () => {
        const skills = await Skill.scan(EMPTY)
        expect(skills).toEqual({ list: [], prompt: '', schema: {}, handlers: {} })
    })

    test('目录还没建：当作没有技能，不报错', async () => {
        // 技能是可选的。项目刚起步还没建 skills/ 文件夹时，scan 应该安静地返回"没有技能"。
        const skills = await Skill.scan(new URL('./fixtures/no-such-skills-dir', import.meta.url))
        expect(skills).toEqual({ list: [], prompt: '', schema: {}, handlers: {} })
    })

    test('name 和目录名对不上时当场报错，不做无声的猜测', async () => {
        expect(Skill.scan(new URL('./fixtures/bad-skills', import.meta.url))).rejects.toThrow('对不上')
    })

    test('多个目录时后面的覆盖前面的同名技能', async () => {
        const merged = await Skill.scan(SKILLS, EMPTY)
        expect(merged.list.map(one => one.name)).toEqual(['greet', 'summarize'])
    })
})


describe('Agent 挂上技能', () => {
    test('默认不传 skills：system 原样，工具表里没有 skill 工具', async () => {
        const { server: bun, requests } = server()
        try {
            const agent = Agent.create({ config: { ...config(bun.port), system: '你是助手。' } })
            await agent.send('随便聊聊')
            expect(requests[0].messages[0].content).toBe('你是助手。')
            expect(requests[0]).not.toHaveProperty('tools')
        } finally { bun.stop(true) }
    })

    test('传了但目录里没有技能：同样零注入', async () => {
        const { server: bun, requests } = server()
        try {
            const agent = Agent.create({ config: { ...config(bun.port), system: '你是助手。' }, skills: await Skill.scan(EMPTY) })
            await agent.send('随便聊聊')
            expect(requests[0].messages[0].content).toBe('你是助手。')
            expect(requests[0]).not.toHaveProperty('tools')
        } finally { bun.stop(true) }
    })

    test('扫到技能：注入技能列表、挂上 skill 工具、模型调用时读出正文', async () => {
        const { server: bun, requests } = server()
        try {
            const tools = await Agent.tool.scan(new URL('./fixtures/tools', import.meta.url))
            const skills = await Skill.scan(SKILLS)
            const results = []
            const agent = Agent.create({ config: { ...config(bun.port), system: '你是助手。' }, tools, skills, callbacks: { onToolResult: one => results.push(one) } })
            const answer = await agent.send('跟用户打个招呼')

            expect(requests[0].messages[0].content).toContain('你是助手。')
            expect(requests[0].messages[0].content).toContain('可用技能')
            expect(Object.keys(requests[0].tools).length).toBeGreaterThan(0)
            expect(JSON.stringify(requests[0].tools)).toContain('"skill"') // 内置技能工具挂上了。

            expect(answer.text).toBe('你好呀！')
            expect(results[0].toolName).toBe('skill')
            expect(results[0].output.value).toContain('热情的问候')       // 正文被读出来了。
            expect(results[0].output.value).not.toContain('description') // frontmatter 已经剥掉。
        } finally { bun.stop(true) }
    })

    test('加载不存在的技能：报错作为工具结果交回模型，不崩', async () => {
        const skills = await Skill.scan(SKILLS)
        const result = await Tool.execute({ name: 'skill', input: { skill: 'nope' }, handlers: skills.handlers })
        expect(result.output.value).toContain('找不到技能')
    })
})
