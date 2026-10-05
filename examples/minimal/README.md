# minimal —— 离线可跑的最小 agent

运行：

```bash
bun examples/minimal/main.js
```

它演示了三件事：`main.js` 里用 `Bun.serve` 起了一个假的 OpenAI 兼容模型（不需要 API 密钥），
用 `new URL('./tools', import.meta.url)` 里的文件工具 `say_hello` 和 `main.js` 里现写的内存工具 `weather` 拼成一份工具表，
再通过 `callbacks.onToolResult` 观察工具结果，最后打印模型的回答和结束原因。
整条链路就是核心循环：问模型 → 执行工具 → 再问模型。
