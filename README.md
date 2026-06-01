# Broker Chat VS Code 扩展

Broker Chat 是一个本地 VS Code 扩展，用来查看当前项目里的官方 Codex 与 Claude Code 对话，并把选中的回复转发到另一边官方面板。

它不运行模型，也不保存自己的聊天历史；它只读取你本机官方插件生成的 transcript 文件。

## 功能

- 监控当前 VS Code 工作区对应的 Codex / Claude Code 官方会话。
- 按工作区 `cwd` 隔离会话，避免多个项目窗口串记录。
- 在 Windows 上通过官方面板完成桥接发送。
- 可选配 Claude Code MCP，让 Claude Code 用工具把文本发送到 Codex 或 Claude Code 面板。

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

## Claude Code MCP

如果要让 Claude Code 通过工具触发转发，把 MCP server 加到 `~/.claude/settings.json`。

把下面路径换成你的实际源码或安装目录：

```json
{
  "mcpServers": {
    "broker-chat": {
      "command": "node",
      "args": ["C:/path/to/broker-chat-vscode/dist/mcp/broker-mcp-server.js"],
      "env": {
        "BROKER_PORT": "14711"
      }
    }
  }
}
```

如果从 VSIX 安装，把 `args` 换成已安装扩展目录里的 `dist/mcp/broker-mcp-server.js`。

配置后重启 Claude Code。使用时可以说：

```text
请阅读当前项目，并通过 Broker 发给 Codex。

请总结本轮改动，并通过 Broker 转发这条最新回复给 Claude Code。
```

首次启动 Broker Chat 时会自动生成 `~/.broker-chat/mcp-token`；MCP server 会自动读取它。

MCP 有两种用法：

- 直接发送指定文本到 Codex 或 Claude Code。
- 先让当前模型正常回答，再把 Broker 时间线里的最新官方回复按页面转发按钮的同款格式发送。

## 命令

- `Open Broker Chat`
- `New Broker Session`
- `Stop Active Response`

## 已知限制

- 桥接发送依赖 Windows、剪贴板、焦点和官方面板状态。
- 如果同一个项目、同一个模型侧有多个会话，默认跟随最近更新的一条。
- 官方 transcript 文件格式变化时，可能需要更新解析逻辑。
