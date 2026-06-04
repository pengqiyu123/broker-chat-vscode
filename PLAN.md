# Broker Chat v0.0.8 完结记录

## 状态

本项目当前版本为 `0.0.8`，核心产品目标已完成：在本地 VS Code 中桥接官方 Codex 与 Claude Code 对话，支持手动转发和关键词自动转发。

## 已完成能力

- 当前工作区 transcript 监控，按 `cwd` 隔离 Codex / Claude Code 会话。
- 插件内手动转发：
  - 合并转发到另一模型。
  - 仅发送这条回答。
- 关键词自动转发：
  - 只读取官方 transcript 中的新 `user` 消息。
  - 关键词只匹配用户消息开头或结尾的小范围。
  - 等待 Claude / Codex 回复完成后，复用手动 `forward-answer` 格式发送。
- Windows 桥接发送：
  - 发送前确认当前前台窗口是本项目唯一匹配的 VS Code 窗口。
  - 保留已验证成功的手动发送顺序：保存剪贴板、写入内容、调用官方 focus 命令、短等待、一次 SendKeys 粘贴并提交、恢复剪贴板。
- Codex 长任务完成判断：
  - 优先使用 `task_started` / `task_complete` turn 状态机。
  - orphan turn 保持等待，不用短静默窗口误判完成。
- 焦点诊断：
  - 自动/手动桥接都会记录 focus 前后只读 UIAutomation 摘要。
  - `Probe Broker Focus` 命令可延迟 3 秒采样当前输入焦点。
  - 日志摘要已截短，避免输出长对话正文。

## 不包含的能力

- 不包含 MCP server。
- 不包含 localhost HTTP API。
- 不包含模型自动多轮互聊。
- 不包含跨 VS Code 窗口自动路由。
- 不自动打开后台 VS Code 或移动鼠标。

## 最终验证

发布前应运行：

```powershell
npm run compile
npm run test:bridge
npm run test:auto-forward
npm run test:powershell
npm audit --omit=dev
npm run package:vsix
```

## 发布资产

- VSIX：`artifacts/broker-chat-vscode-0.0.8.vsix`
- 分发压缩包：`Broker-Chat-v0.0.8-分发包.zip`
