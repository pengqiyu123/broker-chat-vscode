# 第一阶段方案：在 broker-chat-vscode 增加 ZCode 支持

日期：2026-07-02

本文档是 broker-chat-vscode 扩展增加 ZCode 桥接端点的实现方案。Claude↔Codex 的能力旧项目已有，本阶段的核心增量是 ZCode。

## 已确认的产品形态

经过逐项澄清，本阶段的产品形态固定如下：

- **宿主**：VS Code 扩展（运行在 VS Code 进程内）。不是独立桌面软件。
  - 技术事实：从 VS Code 进程外部往 Electron 输入框注入文本不可靠（已实测证伪，见 `docs/send-method-test-log.md`）。Claude/Codex 端要可靠注入，必须在 VS Code 进程内。
  - VS Code 扩展用 Node 环境，可用 `child_process.spawn` 连接外部进程，所以也能桥接 VS Code 外面的 ZCode。
- **桥接端点**：VS Code 内 Claude Code、VS Code 内 Codex、独立桌面 ZCode。用户任选两个组成桥接对。
- **本阶段优先**：含 ZCode 的组合（这是旧项目做不了、价值最高的部分）。
- **驱动方式**：用户亲自跟多个 agent 聊。
- **转发触发**：手动。用户挑一条已完成回复，点转发。
- **转发动作**：自动提交发送（注入输入框 + 提交）。
- **转发模式**（沿用旧项目三种）：
  - 仅回复
  - 合并问题 + 回复
  - 带身份前缀（如 `Claude说：...`）
- **会话锁定**：
  - 单项目单窗口场景为主。
  - 本阶段不做项目锁定。
  - ZCode 按时间锁定最近会话（每次转发时实时找最近）。

## 三端技术方案

### Claude Code（VS Code 内）

- **读取**：读 `~/.claude/projects/**/*.jsonl`（带 cwd）+ `~/.claude/sessions/*.json`（索引）。按 cwd 匹配当前工作区。
- **完成判定**：`stop_reason === "end_turn"`。
- **发送**：进程内 `vscode.commands.executeCommand("claude-vscode.focus")` 聚焦输入框 → 剪贴板写入 → `Ctrl+V` 粘贴 → 按 `claudeCode.useCtrlEnterToSend` 配置提交（Enter 或 Ctrl+Enter）。

### Codex（VS Code 内）

- **读取**：读 `~/.codex/sessions/**/*.jsonl`。按 `session_meta.cwd` 匹配。
- **完成判定**：`task_complete` 事件（新格式）/ 文件稳定性启发式（旧格式）。
- **发送**：进程内 `chatgpt.openSidebar` / `chatgpt.newCodexPanel`（+ 工作台命令兜底）聚焦 → 剪贴板写入 → `Ctrl+V` 粘贴 → 按 `chatgpt.composerEnterBehavior` 配置提交。

### ZCode（独立桌面应用）

- **连接通道**：app-server 协议（已实测验证，见 `docs/send-method-test-log.md`）。
  - 启动：`ELECTRON_RUN_AS_NODE=1 <ZCode.exe> <resources/glm/zcode.cjs> app-server --stdio`
  - 注意：不加 `ELECTRON_RUN_AS_NODE` 时 stdin 写入失败。
- **读取会话**：`session/list`（`params:{}` 全量列出，客户端按 `workspace.workspacePath` 过滤）→ `session/read`。
- **发送**：`session/send`，参数 `{ sessionId, content, runtimeModel }`。
  - 字段名是 `content`，不是 `text`。
  - 协议外壳是 JSON-RPC 风格变体：请求 `{ id, method, params }`，**禁止** `jsonrpc` 字段。
  - 不带 runtimeModel 会返回 `ZCODE_RUNTIME_MODEL_UNAVAILABLE`。
- **runtimeModel 完整结构**：
  ```
  runtimeModel:
    revision:    string
    generatedAt: number
    model:       { providerId: string, modelId: string }
    provider:    { providerId: string, kind: string, models: [{ modelId: string }] }
  ```
  - `provider.models` 数组元素只含 `modelId`。
  - `provider.kind` 是枚举（配置中观察到 `anthropic`）。
  - 必须用当前已启用（`enabled=true`）的 provider 构造。
- **runtimeModel 来源**：ZCode 配置 `<zcode data dir>\v2\config.json` 的 `provider.<providerId>`。
- **会话锁定**：`session/list` 返回全局会话（不按项目分目录），按 `workspace.workspacePath` 过滤出当前项目，再取最近（updatedAt 最大）的会话。
- **完成判定**：`session/read` 返回的消息，`info.finish === "stop"` 表示回复完成；`tool-calls` 表示还在工具循环中。
- **活窗口可见性**：已实测确认，app-server 写入的消息落到桌面窗口实时写入的 `rollout/model-io-sess_<sessionId>.jsonl`，用户在 ZCode 窗口实时可见。

## 脱敏纪律

ZCode app-server 接触 provider 配置，含 `apiKey`。必须严格遵守：

- `apiKey` 只在内存构造 runtimeModel 后写入 app-server 子进程的 stdin。
- 绝不落盘、不进日志、不进诊断包、不回传、不显示在 UI。
- 日志只记录字段是否存在（如 `providerId/modelId/baseURL 是否存在`），不记录值。
- ZCode adapter 的健康检查只验证"能否连接 + 能否 list"，不触发 send。

## 与旧项目的关系

- Claude↔Codex 的进程内注入机制，旧项目已实现且已验证可靠。本方案不重写这部分，在其基础上扩展。
- 本阶段增量是 ZCode adapter + 三端统一的桥接对选择 UI。
- 新增 ZCode adapter 不改动 Claude/Codex 的既有读取和发送逻辑，作为并列的第三种 agent kind 接入。

## 第一阶段范围边界

**做：**
- ZCode adapter（读取 + app-server 发送）。
- 三端统一的桥接对选择（任选两个）。
- ZCode 按时间锁定最近会话。
- 转发到 ZCode 用 `session/send` 自动提交。
- 转发三种模式（仅回复 / 合并问题 / 带前缀）对 ZCode 生效。

**不做：**
- 项目锁定 / 工作区指纹。
- 自动转发 / 关键词转发。
- 独立桌面软件形态。
- Trae / Cursor / Windsurf 等其他 IDE。
- Claude/Codex 的无头 CLI 模式。

## 待后续确认的实现细节

- ZCode adapter 作为常驻 app-server 子进程（长连）还是每次操作 spawn（冷启动）。影响响应速度和状态管理。
- ZCode 端的 runtimeModel 是否需要在会话切换时重新构造。
- 旧项目的 adapter 架构如何容纳第三种 agent kind（需要先看旧项目结构）。
