# 发送方法测试记录

目标：系统性验证 ZCode / VS Code 的可行送达方法；同一方法只测一次，结果可追溯。

## 已知历史

| ID | 目标 | 方法 | 结果 | 备注 |
| --- | --- | --- | --- | --- |
| ZC-001 | ZCode | UIAutomation 定位输入框 | 成功 | 已定位到可编辑输入节点，支持 `ValuePattern` / `TextPattern`。 |
| ZC-002 | ZCode | `ValuePattern.SetValue` | 失败 | 未形成稳定可复现的送达。 |
| ZC-003 | ZCode | 纯 `SendKeys` | 失败 | 未形成稳定可复现的送达。 |
| ZC-004 | ZCode | `Ctrl+V` 粘贴 | 失败 | 未形成稳定可复现的送达；曾偶发把 `BROKER_TEST_PASTE_20260702` 放入输入框。 |
| ZC-005 | ZCode | `AppActivate('ZCode')` | 失败 | `AppActivateOk=true`，但前台实际停在 Weixin，未稳定切到 ZCode。 |
| VS-001 | VS Code / Codex | `ProseMirror` 聚焦 + 外部输入 | 失败 | 已定位 composer，但外部键入未稳定改变可见内容。 |

## 待测候选

| ID | 目标 | 方法 | 状态 |
| --- | --- | --- | --- |
| ZC-006 | ZCode | `SetValue` + `发送` 按钮 Invoke | 失败 | `SetValue` 未把新 token 写入输入框；执行后输入框值变为 `\n`，新 token 未出现在 UI 树里。 |
| ZC-007 | ZCode | 精确点击输入框 + `SendInput` 粘贴 + 发送 | 失败 | 点击命中输入框边界，但 `AfterPasteValue` 仍为 `\n`，`SendEnabled=false`，新 token 未进入 UI 树。 |
| VS-002 | VS Code / Codex | `AppActivate` 后再粘贴 | 待测 |
| VS-003 | VS Code / Codex | `SendInput` 物理键注入 | 待测 |

## 环境检查

| ID | 目标 | 检查项 | 结果 | 备注 |
| --- | --- | --- | --- | --- |
| ZC-INFRA-001 | ZCode | 进程命令行是否带远程调试参数 | 否 | `ZCode.exe` 仅显示 `--updated`，没有 `--remote-debugging-port`。 |
| ZC-INFRA-002 | ZCode | 本机 9222 / 9223 监听口是否属于 ZCode | 否 | 9223 属于 `msedge`，9222 不是 ZCode；不能当作 ZCode CDP 入口。 |
| ZC-INFRA-003 | ZCode | 是否存在内部 app-server 子进程 | 是 | 发现 `ZCode.exe D:\APP\ZCode\resources\glm\zcode.cjs app-server --stdio`，优先转向内部协议勘察。 |
| ZC-INFRA-004 | ZCode | app-server 协议外壳 | 成功 | 2026-07-02 复验：协议是 JSON-RPC 风格变体，请求外壳为 `{ id, method, params }`，但严格拒绝 `jsonrpc` 字段；带 `jsonrpc:"2.0"` 返回 `id=invalid-message`、`code=-32600`、`Unrecognized key: "jsonrpc"`。 |
| ZC-INFRA-005 | ZCode | `session/list` 与 workspace 过滤 | 成功 | 2026-07-02 复验：`params:{}` 返回 50 个会话，其中 `D:\python\broker-chatwork` 匹配 2 个；结果项含 `workspacePath/workspaceKey`，项目隔离应由调用方过滤。顶层传 `workspacePath` 返回 `code=-32602`、`Unrecognized key: "workspacePath"`。 |
| ZC-INFRA-006 | ZCode | 恢复并读取 ZCode 会话 | 成功 | `session/resume` 返回快照，包含 66 条消息，可读到 `BROKER_TEST_PASTE_20260702` 和 ZCode 回复。 |
| ZC-SEND-001 | ZCode | app-server `session/send`，不带 runtimeModel | 失败 | 协议可达，但返回 `ZCODE_RUNTIME_MODEL_UNAVAILABLE`，历史任务模型不可用。 |
| ZC-SEND-002 | ZCode | `session/setModel` 后 `session/send` | 失败 | 快照里的 `session.model` 被改为当前模型，但发送仍提示历史 runtime model 不可用。 |
| ZC-SEND-003 | ZCode | 用完整历史 provider 构造 `runtimeModel` 后 `session/send` | 成功 | `session/send` 返回 `accepted=true`，`session/read` 读到用户消息 `BROKER_TEST_APPSERVER_SEND_20260702_04` 和 ZCode 回复 `好的`。 |

## 独立复验（2026-07-02，不采信既有结论，从零重跑）

启动方式：`ELECTRON_RUN_AS_NODE=1 "D:\APP\ZCode\ZCode.exe" "D:\APP\ZCode\resources\glm\zcode.cjs" app-server --stdio`。

直接用 `ZCode.exe`（不加 ELECTRON_RUN_AS_NODE）启动时，stdin 写入返回 `[Errno 22] Invalid argument`，且 stdout 只打印 Electron 初始化日志；必须加 `ELECTRON_RUN_AS_NODE=1` 才能作为 stdio 协议进程使用。

| ID | 目标 | 方法 | 结果 | 备注 |
| --- | --- | --- | --- | --- |
| ZC-DUP-001 | ZCode | `session/list` `params:{}` | 成功 | 独立复现：返回真实会话，当前会话 `sess_a2ad4383-51db-4349-8a21-fc3c8eeaa9d1` 的 `workspace.workspacePath=D:\python\broker-chatwork`。 |
| ZC-DUP-002 | ZCode | 带 `jsonrpc:"2.0"` 字段 | 失败 | 独立复现：`code=-32600`、`Unrecognized key: "jsonrpc"`。确认是 JSON-RPC 风格变体，禁止 `jsonrpc` 字段。 |
| ZC-DUP-003 | ZCode | `session/list` 顶层传 `workspacePath` | 失败 | 独立复现：`code=-32602`、`Unrecognized key: "workspacePath"`。确认 `session/list` 用空 params 全量列出，由调用方按返回项的 `workspace.*` 过滤。 |
| ZC-DUP-004 | ZCode | `session/send` 用 `text` 字段 | 失败 | Zod 报 `path: ["content"]` `expected string`。正确字段名是 `content`，不是 `text`。 |
| ZC-DUP-005 | ZCode | `session/send` `{sessionId, content}` 不带 runtimeModel | 失败 | 独立复现 `ZCODE_RUNTIME_MODEL_UNAVAILABLE`：`code=-32031`，`message=历史任务使用的模型已不可用，请从当前模型列表中选择一个可用模型后继续。` |
| ZC-DUP-006 | ZCode | 摸清 `runtimeModel` 完整 schema | 成功 | 通过逐层 Zod 错误反推（脱敏：只看 path/expected，不读值）。完整结构见下。 |
| ZC-DUP-007 | ZCode | 构造完整 `runtimeModel` 后 `session/send` | 成功 | marker `BROKER_VERIFY_ZCODE_SEND_20260702_01`；`session/read` 在会话第 82 条起读到该用户消息（`info.role=user`），其后紧跟 `info.role=assistant`、`finish=tool-calls` 的回复及多轮工具调用。 |
| ZC-DUP-008 | ZCode | app-server 写入是否落到桌面活窗口数据源 | 成功 | 见下「数据落点验证」。写入的 marker 在桌面窗口实时写入的 rollout 文件命中，证明活窗口实时可见。 |

### `runtimeModel` 完整 schema（ZC-DUP-006，字段名/类型，值已脱敏）

```text
runtimeModel:
  revision:        string
  generatedAt:     number
  model:
    providerId:    string   // 例：builtin:bigmodel-coding-plan
    modelId:       string   // 例：GLM-5.2
  provider:
    providerId:    string
    kind:          string   // 枚举，配置中观察到 'anthropic'
    models:        array of { modelId: string }
```

构造要点：

- `runtimeModel.model` 与 `runtimeModel.provider` 是两个对象，不要混成一个。
- `provider.models` 是数组，数组元素只含 `modelId`，**不要**带 `providerId`（带 `providerId` 报 `unrecognized_keys`）。
- `provider.kind` 是枚举值，取自配置中 provider 的 `kind` 字段。
- 必须从当前已启用（`enabled=true`）的 provider 构造，否则仍触发 `ZCODE_RUNTIME_MODEL_UNAVAILABLE`。

### 数据落点验证（ZC-DUP-008，决定「活窗口实时可见」是否成立）

会话 `sess_a2ad4383-51db-4349-8a21-fc3c8eeaa9d1` 下，注入 marker 后比对各数据源命中情况：

| 数据源 | 文件 | 修改时间 | 我的 marker `..._01` 命中 | 结论 |
| --- | --- | --- | --- | --- |
| app-server `session/read` | — | — | 是（[82] 起） | app-server 自己写入自己可读 |
| 桌面 SQLite | `~/.zcode/cli/db/db.sqlite` | 21:02（滞后约 1h） | 否（0 条） | 不是活窗口热路径 |
| 桌面 rollout 流 | `~/.zcode/cli/rollout/model-io-sess_a2ad4383-...jsonl` | 22:15（与对话同步） | 是（行 97 起，25 处） | **活窗口实时数据源** |

结论：

- app-server `session/send` 写入的消息落到桌面窗口当前正在实时写入的 `rollout/model-io-sess_<sessionId>.jsonl`，文件名中的 sessionId 与 app-server 的 sessionId 完全一致，是同一会话实体。
- 桌面 SQLite（`db.sqlite`）在会话活跃期间不实时更新，是滞后/索引存储，不能作为活窗口数据源；但可用于历史检索和会话发现。
- 因此「活窗口实时可见」成立：用户在 ZCode 桌面窗口里能实时看到 app-server 注入的消息和 ZCode 的后续回复。

### ZCode 会话与项目绑定的隔离观察

- ZCode 会话存储是全局的（rollout 与 sqlite 均按 sessionId 分文件，不按项目分目录），项目绑定靠会话元数据中的 `workspace.workspacePath` / `directory` 字段。
- `session/list` 返回全局会话（本机 50 个，跨多个项目），必须由 Broker 按 `workspace.workspacePath` 过滤，不能假设返回值天然按项目隔离。
- 因此会话锁定不能只靠 workspace 匹配，必须用唯一短句二次确认（与 requirements.md 的锁定机制一致）。
