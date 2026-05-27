# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A VS Code extension that monitors and bridges conversations between the official Codex and Claude Code VS Code extensions. It reads local transcript files from `~/.codex/sessions` and `~/.claude/sessions` + `~/.claude/projects`, filters them to the current VS Code workspace `cwd`, displays the matching conversations, and can forward messages between the two official plugins via clipboard + keyboard automation (Windows-only for bridge).

The extension does NOT maintain its own chat history or run models directly — it's a read-only monitor + bridge for the official plugins.

## Build & Run

```bash
npm install
npm run compile          # tsc -p ./
npm run watch            # tsc -w -p ./ (dev mode)
```

Press **F5** in VS Code to launch Extension Development Host with the launch config in `.vscode/launch.json`.

### Packaging

```bash
npm run package:vsix     # builds .vsix to artifacts/
npm run install:local    # installs into current VS Code
npm run uninstall:local  # removes from VS Code
```

## Architecture

```
extension.ts
  ├── BrokerController          — central state & orchestrator
  │     ├── ClaudeAdapter       — spawns `claude` CLI in stream-json mode
  │     ├── CodexAdapter        — connects to Codex via JSON-RPC (`codex app-server`)
  │     │     └── CodexRpcClient — stdin/stdout JSON-RPC 2.0 transport
  │     ├── OfficialTranscriptMonitor — polls ~/.codex/sessions & ~/.claude/sessions every 1.5s
  │     └── OfficialUiBridge    — Windows-only: focus + clipboard + SendKeys bridge
  ├── BrokerSidebarViewProvider — activity bar sidebar webview
  ├── BrokerPanel               — editor panel webview (alternative to sidebar)
  └── BrokerWebviewConnection   — shared webview message handling for both UI surfaces
```

### Key Patterns

- **Two UI surfaces** (sidebar + panel) share `BrokerWebviewConnection`, which handles all webview messaging. Both surfaces render the same HTML from `media/`.
- **Adapter pattern**: `AgentAdapter` interface in `types.ts`. Claude uses CLI streaming (`--output-format stream-json`); Codex uses JSON-RPC over stdin/stdout (`app-server` subcommand). Codex falls back to `codex exec` if RPC fails.
- **Transcript monitor**: `OfficialTranscriptMonitor` walks the local filesystem to find and parse the most recently modified official session whose `cwd` matches the current workspace. It filters out harness/system messages (e.g., AGENTS.md instructions, permissions prompts).
- **Bridge automation**: `OfficialUiBridge` uses PowerShell `WScript.Shell.SendKeys` to paste text into the target official plugin's input. Windows-only.
- **Auto-debate**: Controller supports multi-round auto-debate where responses bounce between Codex and Claude with review/revise prompts.
- **Answer source labels**: answer-only forwarding prefixes content with `Codex说：` or `ClaudeCode说：`; merge-forward keeps the English `User question` / `Codex answer` / `ClaudeCode answer` shape.

### Type System

All shared types live in `src/types.ts` — `AgentKind`, `ChatMessage`, `BrokerSnapshot`, `AdapterCallbacks`, `WebviewInboundMessage`, `WebviewOutboundMessage`, etc.

### Webview

Frontend assets are plain JS/CSS in `media/` (no bundler). `BrokerWebviewConnection.getHtml()` generates the HTML with CSP nonce. Communication is via `postMessage` using the typed `WebviewInboundMessage`/`WebviewOutboundMessage` protocols.

## Runtime Requirements

- **Windows** required for `OfficialUiBridge` (SendKeys automation)
- Users must have the official **Codex** and/or **Claude Code** VS Code extensions installed and logged in for full bridge behavior
- `codex` and `claude` CLIs must be available on PATH (configurable via `broker.codexPath` / `broker.claudePath` settings)
- Users must start official Codex/Claude conversations from the same VS Code workspace they want Broker Chat to monitor.

## VS Code Settings

All settings are under the `broker.` prefix: `codexPath`, `claudePath`, `defaultReturnMode`, `defaultAutoDebateRounds`, `claudePermissionMode`, `claudeAllowedTools`.

## Language Note

UI strings are in Chinese (zh-CN). The HTML lang is `zh-CN`.
