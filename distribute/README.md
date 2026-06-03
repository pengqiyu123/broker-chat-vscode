# Broker Chat v0.0.5

Broker Chat 是一个本地 VS Code 扩展，用于监控当前项目里的官方 Codex 与 Claude Code 对话，并把选中的模型回复桥接发送到另一方官方输入框。

它不运行模型，不保存自己的聊天历史，只读取本机官方扩展生成的 transcript 文件。

## 本包内容

- `broker-chat-vscode-0.0.5.vsix`：VS Code 扩展安装包
- `README.md`：安装与使用说明
- `UI-GUIDE.md`：界面说明

## v0.0.5 更新

- 自动转发关键词支持出现在用户消息开头或结尾，长内容中间提到关键词不会触发。
- 适合先粘贴大段内容，再在末尾写 `回复ClaudeCode` / `给Codex命令`。

## v0.0.4 更新

- 新增关键词自动转发：在官方对话里输入 `给Codex命令...` 或 `回复ClaudeCode...`，Broker 会等待模型最终回复后自动转发给目标。
- 修复 Codex 长任务误发：只有检测到官方完成记录后才自动转发。
- 恢复手动转发可靠聚焦：点击 `仅转发这条回答` / `合并转发到...` 会复用官方扩展面板聚焦逻辑，把内容发送到目标输入框。
- 增加前台安全检查：发送前确认当前前台是本项目 VS Code 窗口，避免粘贴到其他应用。
- 顶部状态栏固定显示项目、监控、桥接、自动转发状态，并直接展示失败原因。
- 增加 `Broker Chat` 日志入口，方便排查桥接失败。
- 移除 MCP/HTTP 使用模式，保留插件手动转发和关键词自动转发两种模式。

## 安装

1. 打开 VS Code。
2. 进入扩展面板。
3. 点击右上角 `...`。
4. 选择 `Install from VSIX...`。
5. 选择 `broker-chat-vscode-0.0.5.vsix`。
6. 完全关闭并重新打开 VS Code。
7. 打开活动栏里的 `Broker Chat`。

## 使用

先在同一个 VS Code 工作区里正常打开并使用官方 Codex / Claude Code 对话。Broker Chat 会自动读取当前项目对应的官方会话。

手动转发：

- `仅转发这条回答`：发送格式为 `Codex说：...` 或 `ClaudeCode说：...`。
- `合并转发到...`：携带相邻用户问题、模型回答和可选补充说明一起发送。

自动转发：

- 发给 Codex 示例：`给Codex命令：请检查这段实现。`
- 发给 Claude 示例：`回复ClaudeCode：请审查这次修改。`

关键词必须出现在用户消息开头或结尾。打开插件前已有的历史消息不会被自动转发。

## 要求

- VS Code 1.98.0 或更新版本。
- 已安装并登录官方 Codex 与 Claude Code VS Code 扩展。
- 桥接发送目前仅支持 Windows。
- 目标官方面板需要可用，且当前 VS Code 窗口必须是前台窗口。

## 项目地址

https://github.com/pengqiyu123/broker-chat-vscode
