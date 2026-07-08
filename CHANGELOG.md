# Changelog

## 0.3.0

本次更新新增 Agent 调用式转发的 MCP 入口，让 ZCode / ClaudeCode / Codex 可以通过标准 MCP 工具向 Broker 发起一次明确转发请求。

### 新增

- **Broker MCP sidecar**：新增 `dist/mcp/brokerMcpServer.js`，提供 stdio MCP 工具 `broker_forward`。
- **本地控制端点**：扩展启动后在 `127.0.0.1` 随机端口开启受控接口，并写入 `.broker-chat/runtime.json`，sidecar 通过 token 和 workspace 指纹连接当前 VS Code 工作区。
- **Agent 调用式转发入口**：新增 `agent-command` 触发源，MCP 调用进入 Broker 后复用现有三端 `dispatchBridge` 发送通道。
- **MCP 配置样例命令**：新增 `Show Broker MCP Config` 命令，生成当前工作区可用的 ZCode MCP 配置样例。

### 安全与稳定

- MCP sidecar 的来源 Agent 由启动参数 `--source` 决定，模型参数不能冒充来源。
- 每次转发需要 `requestId`，Broker 按来源会话去重，避免重复执行同一调用。
- 控制端点校验 token、workspace 指纹、当前红蓝配对、目标 Agent、正文长度和 requestId 格式。
- Codex / ClaudeCode 目标仍沿用现有前台 VS Code 工作区安全检查；失败会返回真实错误，不伪装成功。
- ZCode 目标发送改为绑定桌面当前打开会话：发送前读取 CDP 当前 `sessionId`，用 app-server 验证它属于当前 VS Code 工作区，建立同一会话的回复基线后才注入文本。
- ZCode 当前对话识别改为读取左侧项目树的 `data-task-item-key="<workspacePath>:<sessionId>"`，可区分同一 IDE 内不同文件夹项目下的历史对话。
- ZCode 桥接发送阶段的真实错误会向外抛出，不再因为回调被忽略而显示假成功。

## 0.2.0

本次更新新增 ZCode 作为第三个桥接端点，并重构桥接模型为「红蓝白双方」配对。

### 新增

- **ZCode 第三端点**：在原有 Claude Code ↔ Codex 的基础上，新增 ZCode（独立桌面 Electron 应用）作为可桥接的第三个 agent。支持 Claude↔Codex、Codex↔ZCode、Claude↔ZCode 三种组合。
- **红蓝白双方配对**：用户从 {Claude, Codex, ZCode} 中任选两个组成桥接对（红方/蓝方），自己作为白方在中间转发。配对状态持久化到工作区配置，重启 VS Code 后保留。
- **ZCode CDP 发送通道**：通过 Chrome DevTools Protocol（端口 9224）向 ZCode 输入框注入文本并触发提交，绕过合成键盘事件被拦截的问题。Broker 会在需要时自动用 `--remote-debugging-port=9224` 重启 ZCode。
- **ZCode 会话监控**：通过 ZCode app-server 协议（session/list + session/resume）读取会话历史，按工作区路径过滤锁定最近会话。
- **红蓝身份锁前缀**：方向前缀从 claudeToCodex/codexToClaude 迁移为红蓝槽位（red/blue），保留原有身份锁定文本，转发给某一方时自动拼接该方的前缀。
- **三色状态指示灯**：顶部状态栏新增 ZCode 状态灯（🔴 未检测 / 🟡 待重启或重启中 / 🟢 桥接成功），点击红灯/黄灯可手动触发重新检测。
- **ZCode 配置项**：新增 `broker.zcodeDataDir`（数据目录）、`broker.zcodeExePath`（exe 路径，自动发现并持久化）、`broker.bridgePair`（配对选择持久化）。

### 改进

- **轮次聚合显示**：ZCode 一轮对话中的多个 tool-calls 中间步骤折叠为一张可展开的过程卡，最后的 stop 总结单独显示，避免刷屏。
- **Harness 噪声过滤**：自动过滤 ZCode 注入的框架消息（如 "The TodoWrite tool hasn't been used..."），不显示在时间线。
- **消息卡片红蓝白配色**：消息左边框和标签按桥接角色上色（红方红、蓝方蓝、用户白），不再绑死具体 agent。
- **时间线按配对过滤**：只显示当前桥接对内两端的会话，第三端不混入时间线。
- **设置面板可折叠分区**：桥接对象、身份前缀、自动转发三个分区可折叠；红蓝下拉框改为同行紧凑布局；自动转发默认关闭。

### 修复

- 修复 ZCode app-server 协议的字段结构（session/list 返回 {sessions}、session/resume 读取消息、parts[].text 正文）。
- 修复 spawn ZCode 时环境变量污染（VS Code 扩展宿主的 ELECTRON_RUN_AS_NODE 导致 ZCode 以 node 模式启动并立即退出）。
- 修复插件启动时自动 taskkill 杀掉用户正在使用的 ZCode（改为只读检测，仅用户主动操作时才允许重启）。

## 0.1.0

- Added editable directional role prefixes for ClaudeCode -> Codex and Codex -> ClaudeCode forwarding.
- Preloaded the directional role prefix fields with the approved ClaudeCode/Codex identity-locking text.
- Prepends configured role text to manual and automatic bridge prompts while preserving old output when a prefix is cleared.
- Fixed local PowerShell packaging/install scripts to read UTF-8 package metadata correctly.

## 0.0.9

- Added editable directional role prefixes for ClaudeCode -> Codex and Codex -> ClaudeCode forwarding.
- Prepends configured role text to manual and automatic bridge prompts while preserving old output when prefixes are empty.

## 0.0.8

- Shortened focus diagnostic summaries so logs show routing evidence without dumping long conversation text.

## 0.0.7

- Changed focus probe command to sample after a 3-second delay so the command palette does not steal the measured focus.

## 0.0.6

- Added read-only focus diagnostics for Codex and Claude Code input routing.
- Added bridge logs that record focus state before and after official panel focus commands.
- Added `Probe Broker Focus` command for collecting focus evidence without sending text.

## 0.0.5

- Automatic forwarding keywords now trigger from the beginning or end of a user message, without scanning the middle of long pasted text.
- Added regression coverage for long-message head, tail, and middle keyword matching.

## 0.0.4

- Added keyword-based automatic forwarding between official Codex and Claude Code conversations.
- Restored reliable manual bridge focus behavior while adding a foreground VS Code workspace safety check.
- Added Codex completion detection using official task completion events to avoid forwarding unfinished long tasks.
- Added sticky top status details and Broker Chat logs for bridge/auto-forward diagnostics.
- Removed MCP/HTTP forwarding surfaces; Broker now focuses on manual plugin forwarding and automatic keyword forwarding.

## 0.0.1

- Added current-workspace transcript monitoring for official Codex and Claude Code conversations.
- Added VS Code-window-safe session isolation by matching transcript `cwd`.
- Added bridge forwarding between official Codex and Claude Code panels on Windows.
- Added source-prefixed answer-only forwarding with `Codex说：` and `ClaudeCode说：`.
- Added a compact 3-card summary with monitor status, current project, and bridge status.
- Added VSIX packaging scripts for local sharing.
