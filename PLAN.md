# 自动转发可靠性修复计划 v3

## Summary
把策略改成 fail-safe：宁可漏转，也不能提前误转或发到微信。Codex 不再靠“静默 N 秒”判定完成；现代日志必须等 `task_complete`，旧日志 fallback 只在没有 turn 事件的 legacy 文件中启用。

## Key Changes
- 前台安全发送：
  - 发送前用 VS Code 命令聚焦目标面板，再用 Win32 检查前台窗口。
  - 只有当前前台窗口是唯一匹配的 VS Code 工作区窗口时才执行 `SendKeys`。
  - 多窗口歧义、前台是微信、标题不匹配、激活失败时直接报错并恢复剪贴板。
  - 粘贴前和提交前各校验一次，降低 TOCTOU 风险。

- Codex 完成判断：
  - `OfficialTranscriptMonitor` 增加 Codex turn 状态机，解析 `event_msg.task_started`、`response_item.message`、`event_msg.task_complete`。
  - `task_complete.last_agent_message` 有文本时，标记匹配的最终 Codex 回复 `meta.codexComplete=true`。
  - `last_agent_message` 为 `null` 时，只标记同 turn 内最新 `phase="final_answer"` 回复。
  - 有 `task_started` 但没有 `task_complete` 的 turn 一律保持等待，不用静默时间兜底，避免 30-40 秒间隔误发。
  - legacy fallback 仅用于完全没有 `task_started/task_complete` 的旧格式日志：要求 2 分钟无文件更新且内容稳定，仍作为低优先级兼容路径。

- 长任务 pending：
  - `PendingAutoForward` 保存 `sourcePath`。
  - `AutoForwardEngine` 暴露 pending session 引用。
  - `OfficialTranscriptMonitor.readSnapshot(preferredSession)` 优先读取 pending 的 `sourcePath/sessionId`，避免长任务被其它 session 顶掉。
  - pending 无短超时；如果一直没有完成事件，状态保持等待并显示原因。

- 关键词匹配：
  - 保留现有 `role === "user"` 过滤，并补测试证明 assistant/system 不触发。
  - 使用 `trimStart()` 后的严格前缀匹配；正文中间出现关键词不触发。
  - 保留 ASCII 大小写不敏感；不再移除内部空格。
  - 关键词目标等于当前会话 agent 时忽略，避免自发自收。

## Tests
- 更新 `scripts/test-auto-forward.js`：
  - Codex 有回复但无 `codexComplete` 不触发。
  - Codex `task_complete.last_agent_message` 后触发。
  - Codex `last_agent_message=null` 但同 turn 有 `phase=final_answer` 时触发。
  - Codex 两段输出间隔 40 秒但无 `task_complete` 不触发。
  - orphan turn 永远不自动误发，只显示等待。
  - preferred session 防止 pending 被其它 session 顶掉。
  - assistant/system 含关键词不触发。
  - user 中间含关键词、内部空格变体不触发；大小写变体仍触发。
  - Claude 仍只在 `stopReason=end_turn` 后触发。
- 增加 monitor fixture 测试，构造最小 Codex JSONL 来覆盖 turn 状态机。
- 增加前台窗口 guard 的纯函数测试：唯一匹配、多窗口歧义、非 VS Code 前台、标题不匹配。
- 验证命令：
  - `npm run compile`
  - `npm run test:bridge`
  - `npm run test:auto-forward`
  - `npm audit --omit=dev`

## Assumptions
- 自动转发仍复用“仅发送这条回答”格式。
- false positive 比 false negative 更严重；没有可靠完成信号时不自动发。
- 本轮只修复插件本地行为和测试，不做 Release、MCP、HTTP 或新 UI。
