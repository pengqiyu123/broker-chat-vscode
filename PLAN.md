# Broker 自动转发 + UI 重设计

## Summary
1. 删除 MCP server 和 HTTP API。
2. Broker 插件通过 transcript monitor 检测用户消息中的关键词，自动等待模型最终回复，套用按钮同款格式转发到对面 agent。
3. 重设计顶部 UI 为双行分层布局，新增设置面板（含自动转发开关）。

## Key Changes

### 删除
- `src/mcp/` — MCP server 全部删除
- `src/server/BrokerHttpServer.ts` — HTTP API 删除
- `scripts/build-mcp.js` — MCP 构建脚本删除
- `extension.ts` 中 HTTP server / token / mcpPort 相关代码
- `package.json` 中 `@modelcontextprotocol/sdk`、`zod`、`esbuild` 依赖
- `package.json` 中 `build:mcp`、`build:all` 脚本（恢复原 `compile` 即可）
- `package.json` 中 `broker.mcpPort` 配置项

---

### 新增 1：自动转发引擎

#### 关键词检测（在 transcript monitor 层）
- Monitor 每 1.5s 轮询 `~/.claude/sessions` 和 `~/.codex/sessions`
- 新增逻辑：扫描最新用户消息，匹配关键词
- 关键词通过 `broker.autoForwardKeywords` 配置，默认：
  - `给Codex命令` / `给codex命令` → 目标 Codex
  - `回复ClaudeCode` / `回复claudecode` → 目标 Claude
- 支持变体/模糊匹配（如"发送给codex"、"转给codex"、"问codex"等）
- 匹配到关键词后，标记当前会话为"等待自动转发"状态

#### 等待模型最终回复
- 模型在一轮中多次调用工具，产生多条消息，只有最后一条是总结性质的回复
- 检测方式：需测试 transcript 中是否有 `pending` / `stop_reason` 等字段可用
- 备选方案：连续 N 次轮询（3 × 1.5s = 4.5s）消息数不变即认为完成
- 取最后一条 `role === "claude"` 或 `role === "codex"` 的消息

#### 自动转发执行
- 套用格式：`ClaudeCode说：\n{文本}` 或 `Codex说：\n{文本}`
- 调用 `OfficialUiBridge.sendToAgent(target, formattedText)`
- 和手动"仅转发这条回答"按钮完全相同的路径
- 格式化逻辑复用 `bridgePrompt.ts` 中已有函数

#### UI 展示（复用现有）
- 现有 webview 已展示 Codex/Claude transcript 中的用户消息气泡（`role-user` 蓝色边框）
- "检测到 user codex" = Codex session 的用户消息包含关键词 → 自动转发其回复到 Claude
- "检测到 user claude" = Claude session 的用户消息包含关键词 → 自动转发其回复到 Codex
- 自动转发状态通过现有 bridge 状态显示

---

### 新增 2：顶部 UI 重设计

#### 当前问题
- Topbar 标题占用空间但信息量低
- Summary 三卡片等宽横排，没有优先级区分
- 缺少设置入口

#### 新布局：双行分层

```
┌──────────────────────────────────────────────┐
│ Broker Chat                       [⚙] [↻]   │  ← 第一行：标题 + 操作按钮
│ ● broker-chat-vscode  监控:运行中  桥接:待命  │  ← 第二行：状态指示
│ 自动转发: [ON/OFF]                           │  ← 第三行：自动转发开关（可选独立行或合入第二行）
└──────────────────────────────────────────────┘
```

#### 第一行
- 左侧：标题 "Broker Chat"
- 右侧：设置齿轮图标（展开设置面板）+ Refresh 按钮

#### 第二行
- 左侧：项目名（小字 cwd 路径，hover 显示完整路径）
- 中间：监控状态指示灯 + 文字（运行中 / 已关闭）
- 右侧：桥接状态指示灯 + 文字（待命 / 发送中 / 失败 / 已完成）

#### 设置面板（齿轮图标展开）
- 自动转发开关（Toggle）
- 关键词列表（可编辑文本框，每行一个模式）
- 恢复为 webview 内折叠面板或弹出面板

---

### 保留不变
- 插件内手动转发按钮（"合并转发"、"仅转发这条回答"）
- 手动按钮的 `bridgeMonitoredMessage` 和 `bridgePrompt.ts` 格式化逻辑
- `broker.codexPath`、`broker.claudePath` 等现有配置
- 消息气泡样式（user 蓝色 / codex 青色 / claude 橙色）
- 连接验证折叠面板
- 合并时间线

---

## Implementation

### 新增文件
- `src/automation/AutoForwardEngine.ts` — 自动转发引擎
  - 关键词匹配逻辑
  - 等待最终回复逻辑
  - 调用 `OfficialUiBridge.sendToAgent` 转发
  - 状态管理（等待中、转发中、完成、失败）

### 修改文件

#### 后端
- `src/controller/BrokerController.ts`
  - 集成 `AutoForwardEngine`
  - 在 `refreshMonitor()` 中调用引擎检查
  - 删除 `sendToAgentViaBridge`、`forwardLatestMonitoredReply`、`waitForLatestMonitoredReply`
  - 新增自动转发状态字段到 snapshot
- `src/extension.ts`
  - 删除 HTTP server / token / mcpPort 相关代码
  - 恢复为纯扩展激活
- `src/types.ts`
  - 新增 `AutoForwardState` 类型（enabled, status, keyword, target）
  - 在 `BrokerSnapshot` 中加入 autoForward 状态
  - 删除 `mcpPort` 从 `BrokerConfig`
  - 新增 `WebviewInboundMessage` type: `"toggle-auto-forward"`
- `package.json`
  - 删除 MCP 相关依赖和脚本
  - 新增 `broker.autoForwardEnabled` (boolean, default true) 配置项
  - 新增 `broker.autoForwardKeywords` (string, 默认关键词列表) 配置项
  - 恢复 `package:vsix` 和 `install:local` 为只用 `compile`

#### 前端
- `media/styles.css`
  - 重写 `.topbar` 为双行分层布局
  - 新增状态指示灯样式（`●` 圆点 + 颜色）
  - 新增设置面板样式（折叠/弹出）
  - 新增 Toggle 开关样式
  - 删除 `.summary` 和 `.summary-card` 三卡片样式
- `media/main.js`
  - 重写 `render()` 中顶部区域渲染逻辑
  - 新增设置面板展开/折叠交互
  - 新增自动转发 Toggle 交互（发送 `toggle-auto-forward` 消息）
  - 删除 `summary` 元素渲染
- `src/ui/BrokerWebview.ts`
  - HTML 模板：删除 `<section id="summary">`，重构 `<header class="topbar">` 为双行
  - HTML 模板：新增设置面板 DOM
  - `handleMessage` 新增 `toggle-auto-forward` 处理

### 删除文件
- `src/mcp/broker-mcp-server.ts`
- `src/mcp/tsconfig.mcp.json`
- `src/server/BrokerHttpServer.ts`
- `scripts/build-mcp.js`

---

## Tests
- `npm run compile` 通过
- 关键词匹配：各种变体都能正确识别并推导目标
- 等待完成：模型多轮输出后只转发最后一条
- 格式化：输出和手动按钮一致
- 边界：空回复、已在转发中、用户取消
- 设置面板：开关切换、关键词编辑持久化
- 手动验证：F5 → 在官方窗口输入"给Codex命令：xxx" → 确认自动转发
- 手动验证：F5 → 设置面板关闭自动转发 → 确认不自动转发

## Assumptions
- 本次只做本地代码和验证，不自动推 GitHub
- 自动转发只支持"仅转发这条回答"格式，不支持合并用户问题
- 关键词检测依赖 transcript monitor 的轮询周期（1.5s），有一定延迟
- 需要先测试 transcript 格式确定"回复完成"的检测方式
- 设置面板在 webview 内实现，不走 VS Code settings UI（更直观）
