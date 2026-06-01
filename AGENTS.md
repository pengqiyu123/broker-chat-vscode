# Broker Chat VS Code

## Project Purpose

Broker Chat is a local VS Code extension that monitors official Codex and Claude Code conversations and can bridge selected model replies between those official VS Code extensions.

It is a monitor and bridge, not a model runtime. Do not add fake transcripts, sample sessions, or fallback content that could be mistaken for real official conversation data.

## Session Isolation

Each extension instance must only monitor official sessions whose `cwd` matches the current VS Code workspace folder. This keeps separate VS Code windows bound to their own project conversations.

- Codex sessions are read from `~/.codex/sessions/**/*.jsonl` and matched through `session_meta.cwd`.
- Claude sessions are read from `~/.claude/sessions/*.json` and matched through `cwd`.
- Path comparisons must use the shared normalization helper before comparing values.
- If no matching session exists for the current workspace, show an empty state instead of falling back to another project's latest session.

## Product Guardrails

- Do not use sample, fallback, or synthetic transcript data as if it were a real official conversation.
- Do not surface implementation internals in normal UI copy.
- Keep user-facing labels short and operational.
- Long-running actions should show immediate status before the work finishes.

## Documentation Responsibilities

- `README.md` is for users installing and operating the extension. Keep it short, product-facing, and free of implementation detail unless needed to complete setup.
- `AGENTS.md` is for coding agents and maintainers. Put architecture notes, internal APIs, validation commands, transcript format assumptions, and maintenance guardrails here.
- Do not move low-level HTTP, token, parser, or packaging details into README unless a normal user must perform that step.

## MCP Bridge Architecture

Broker Chat exposes an optional local MCP bridge for Claude Code:

```text
Claude Code -> stdio MCP server -> localhost HTTP API -> VS Code extension host -> OfficialUiBridge -> official panel
```

Key files:

- `src/server/BrokerHttpServer.ts` — authenticated localhost HTTP API in the VS Code extension host.
- `src/mcp/broker-mcp-server.ts` — stdio MCP server used by Claude Code.
- `scripts/build-mcp.js` — bundles the MCP server into a standalone `dist/mcp/broker-mcp-server.js` for VSIX installs.

HTTP API requirements:

- Bind only to `127.0.0.1`.
- Default port is `14711`, configurable as `broker.mcpPort`.
- Require `Authorization: Bearer <token>` for every endpoint.
- Token lives at `~/.broker-chat/mcp-token`; generate once with 32 random bytes and never log it.
- Return structured envelopes: `{ ok: boolean, data?: T, error?: string }`.
- `/api/status` returns the current Broker snapshot plus server status.
- `/api/send` accepts `{ target, text, workspaceCwd }` and must reject workspace mismatches.
- `/api/forward-latest` accepts `{ sourceAgent, mode, workspaceCwd, extraText?, afterMessageId?, waitMs? }`, finds the latest real monitored model reply, and forwards it through the same prompt builder used by the UI transfer buttons.

MCP tool requirements:

- `broker_get_status` is read-only and should be called before sending.
- `broker_send_to_agent` sends text to `codex` or `claude` and requires `workspace_cwd`.
- `broker_forward_latest_reply` is the software-level auto-forward path. Use it after the source model has already produced a normal official reply; it must not accept or invent message text.
- Keep tool errors actionable. For example, tell the caller to open Broker Chat in VS Code when the HTTP API is unreachable.
- The MCP server must not write logs to stdout; stdout is reserved for MCP protocol messages. Use stderr for logs.

Forwarding behavior:

- Keep direct text sending and software-level auto-forwarding as separate paths.
- Direct sending is for explicit raw commands or user-provided text.
- Auto-forwarding must read from the official transcript monitor, select a real latest model reply, then reuse `buildMonitoredBridgePrompt`.
- The `forward-answer` format must match the UI button: `Codex说：...` or `ClaudeCode说：...`.
- The `merge-forward` format must match the UI button: adjacent user question plus source answer, with optional UI/MCP note appended as `Additional user note:`.
- When an agent wants to forward its own just-produced response, first let the normal official response appear, then call `broker_forward_latest_reply`; use `after_message_id` from `broker_get_status` when avoiding accidental re-forward of the previous reply matters.

## Development Notes

- Keep bridge and adapter changes separate from monitor/session-selection changes.
- Run `npm run build:all` after TypeScript edits.
- Run `npm run package:vsix` before sharing a new build.
- This project is Windows-first for bridge-send automation.
- Keep generated packages and build output out of git; package from source when needed.

## Verification

Use these checks for MCP or bridge changes:

```powershell
npm run build:all
npm audit --omit=dev
```

MCP stdio smoke test:

```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"broker-smoke-test","version":"0.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
'@ | node dist\mcp\broker-mcp-server.js
```

HTTP status check against a running VS Code extension host:

```powershell
$token = (Get-Content -Raw "$HOME\.broker-chat\mcp-token").Trim()
Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:14711/api/status" `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" `
  -Body "{}"
```

Before sharing a build, confirm the VSIX includes `dist/mcp/broker-mcp-server.js` and does not require external `node_modules`.
