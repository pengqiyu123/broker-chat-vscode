# Broker Chat VS Code 扩展

Broker Chat 是一个本地 VS Code 扩展，用来查看当前项目里的官方 Codex 与 Claude Code 对话，并把回复桥接发送到官方面板。

它不运行模型，也不保存自己的聊天历史；它只读取你本机官方插件生成的 transcript 文件。

## 功能

- 监控当前 VS Code 工作区对应的 Codex / Claude Code 官方会话。
- 按工作区 `cwd` 隔离会话，避免多个项目窗口串记录。
- 在 Windows 上通过官方面板完成桥接发送。
- 支持插件内手动转发和关键词自动转发。
- 顶部状态栏常驻显示桥接/自动转发状态，并提供日志入口。

## 要求

- VS Code `1.98.0` 或更新版本。
- 已安装并登录官方 Codex 与 Claude Code VS Code 扩展。
- 桥接发送目前需要 Windows。
- 需要先在同一个 VS Code 工作区里开启真实官方对话。

## 安装

从 VSIX 安装：

1. 在 VS Code 扩展面板选择 `Install from VSIX...`。
2. 选择分享得到的 `.vsix` 文件。
3. 完全关闭并重新打开 VS Code。
4. 打开活动栏里的 `Broker Chat`，或运行命令 `Open Broker Chat`。

从源码安装到本机 VS Code：

```powershell
npm install
npm run install:local
```

打包新的 VSIX：

```powershell
npm run package:vsix
```

## 使用

打开 `Broker Chat` 后，确认顶部显示的是当前项目。页面会展示当前项目匹配到的 Codex 与 Claude Code 官方会话。

在合并时间线中，点击模型回复下方的操作：

- `合并转发到 ...`：带上相邻用户问题和这条回复一起发送。
- `仅转发这条回答`：只发送当前模型回复。

设置里已预置双向身份前缀。前缀会按 `ClaudeCode -> Codex` 或 `Codex -> ClaudeCode` 方向自动拼在转发内容最前面；可自行修改，清空文本即可关闭。

## 自动转发

顶部状态栏里的设置按钮可以开启/关闭自动转发，并编辑发给 Codex / Claude 的关键词。

示例：

```text
给Codex命令：请检查刚才的实现风险。
```

如果这条用户消息出现在 Claude Code 官方会话里，Broker 会等待 Claude Code 的最终回复，然后发送到 Codex 官方面板，格式为：

```text
ClaudeCode说：
...
```

自动转发只处理新出现的关键词消息；打开插件时已有的历史消息不会被回放转发。
关键词需要出现在用户消息开头或结尾，正文中间提到关键词不会触发。

为避免误发，Broker 会在发送前确认当前前台窗口是本项目的 VS Code 窗口。如果无法确认，会显示失败状态而不是继续粘贴发送。
Broker 会复用官方扩展的面板聚焦命令，把内容填入目标 Codex / Claude Code 输入框。

## 排查

如果桥接失败，可以点击顶部 `日志` 查看 `Broker Chat` 输出。

命令 `Probe Broker Focus` 会在 3 秒后只读检测当前输入焦点，用于排查 Codex / Claude Code 输入框识别问题；它不会写剪贴板、不会发送内容。

## 0.0.8 更新

- 增加焦点诊断日志，用于对比手动转发和自动转发的聚焦结果。
- 增加 `Probe Broker Focus` 命令，方便只读采集当前 Codex / Claude Code 输入焦点。
- 收紧日志摘要，避免把长对话正文写入日志。

## 0.0.5 更新

- 自动转发关键词现在支持放在用户消息开头或结尾，适合粘贴长内容后在末尾写 `回复ClaudeCode` / `给Codex命令`。
- 正文中间提到关键词仍不会触发，减少误发。

## 0.0.4 更新

- 修复自动转发可靠性，Codex 长任务会等待官方完成记录，避免中途误发。
- 恢复手动转发的目标面板聚焦时序，同时增加前台 VS Code 工作区安全检查。
- 顶部状态栏固定显示当前桥接/自动转发状态，失败原因直接可见。
- 增加 `Broker Chat` 日志入口，便于排查桥接失败原因。
- 删除 MCP/HTTP 模式，保留插件手动转发和关键词自动转发两种使用方式。

## 命令

- `Open Broker Chat`
- `New Broker Session`
- `Stop Active Response`
- `Show Broker Chat Logs`
- `Probe Broker Focus`

## 已知限制

- 桥接发送依赖 Windows、剪贴板、焦点和官方面板状态。
- 如果同一个项目、同一个模型侧有多个会话，默认跟随最近更新的一条。
- Codex 长任务必须等官方 transcript 出现完成记录后才会自动转发；没有完成记录时会保持等待。
- 官方 transcript 文件格式变化时，可能需要更新解析逻辑。
