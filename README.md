# Broker Chat VS Code 扩展

Broker Chat 是一个本地 VS Code 扩展，用来监控当前项目里的官方 Codex 与 Claude Code VS Code 对话，并在两边官方插件之间桥接转发模型回复。

它不直接运行模型，也不保存自己的聊天历史。它读取本机官方 transcript 文件，展示当前工作区匹配到的最新会话，并可以把选中的模型回复转发到另一个官方扩展。

## 功能

- 读取官方 Codex transcript：`~/.codex/sessions`。
- 读取官方 Claude Code transcript：`~/.claude/sessions` 和 `~/.claude/projects`。
- 按当前 VS Code 工作区 `cwd` 隔离会话，多个项目窗口不会互相串记录。
- 顶部显示 3 个状态卡片：`监控状态`、`当前项目`、`桥接状态`。
- 在 Windows 上通过剪贴板和键盘自动化桥接转发选中的回复。
- “仅转发这条回答”会自动加来源前缀：`Codex说：` 或 `ClaudeCode说：`。

## 运行要求

- VS Code `1.98.0` 或更新版本。
- 桥接发送功能需要 Windows。
- 已安装并登录官方 Codex VS Code 扩展。
- 已安装并登录官方 Claude Code VS Code 扩展。
- 需要先在同一个 VS Code 工作区里开启至少一个官方 Codex 或 Claude Code 对话。

监控功能依赖本机官方 transcript 文件。桥接发送功能还要求目标官方扩展面板能被 VS Code 聚焦。

## 从 VSIX 安装

1. 获取分享者提供的 `.vsix` 文件。
2. 打开 VS Code。
3. 打开 Extensions 扩展面板。
4. 点击扩展面板右上角 `...` 菜单。
5. 选择 `Install from VSIX...`。
6. 选择 `.vsix` 文件。
7. 完全关闭并重新打开 VS Code。
8. 从活动栏打开 `Broker Chat`，或在命令面板运行 `Open Broker Chat`。

## 从源码开发

```powershell
npm install
npm run compile
```

启动开发调试：

1. 用 VS Code 打开本目录。
2. 按 `F5` 启动 Extension Development Host。
3. 在新窗口里运行 `Open Broker Chat`。

安装到当前普通 VS Code：

```powershell
npm run install:local
```

打包可分享的 VSIX：

```powershell
npm run package:vsix
```

打包结果会生成到 `artifacts/` 目录。

## 命令

- `Open Broker Chat`
- `New Broker Session`
- `Stop Active Response`

## 会话匹配规则

Broker Chat 只展示 `cwd` 与当前 VS Code 工作区目录匹配的官方会话。

- Codex：从 `~/.codex/sessions/**/*.jsonl` 读取 `session_meta.cwd`。
- Claude Code：从 `~/.claude/sessions/*.json` 读取 `cwd`，再到 `~/.claude/projects` 里定位对应 transcript。
- 如果当前项目没有匹配会话，Broker Chat 会显示空状态，不会回退到其他项目的最新会话。

这个规则是刻意设计的：它能避免多个 VS Code 项目窗口之间混用聊天记录。

## 快速验证

1. 在 VS Code 中打开一个项目目录。
2. 在这个工作区里启动一条真实 Codex 对话。
3. 在这个工作区里启动一条真实 Claude Code 对话。
4. 打开 Broker Chat。
5. 确认顶部“当前项目”显示的是当前项目名。
6. 确认 Codex 和 Claude 两栏展示的是当前项目的对话。
7. 点击某条模型回复下方的 `仅转发这条回答`。
8. 确认目标官方扩展收到的文本带有 `Codex说：` 或 `ClaudeCode说：` 前缀。

## 已知限制

- 桥接发送目前只支持 Windows。
- 如果同一个项目、同一个模型侧有多个官方会话，Broker Chat 会跟随最近更新的一条。
- 本扩展依赖官方 Codex 与 Claude Code 扩展的本地 transcript 文件格式；如果官方格式变化，可能需要同步更新解析逻辑。
- Broker Chat 不替代官方 Codex 或 Claude Code UI，它只是监控和桥接工具。
