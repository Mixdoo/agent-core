/* 包入口：import Agent from '@kernel4632/agent-core'。所有常用能力都挂在 Agent 上。 */
import Agent from './agent.js' // 同一套模型、工具、格式和流式能力。

export default Agent
export { MCP } from './features/mcp.js' // 工具子进程从单文件产物导入的内部协议入口。
