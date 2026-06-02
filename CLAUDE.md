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

### Tests

Tests are standalone Node scripts (no test framework):

```bash
npm run test:bridge       # bridge prompt construction logic
npm run test:auto-forward # keyword matching & auto-forward engine
npm run test:powershell   # PowerShell script generation helpers
```

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
  │     ├── AutoForwardEngine   — keyword detection, reply stability tracking, forward decisions
  │     ├── OfficialUiBridge    — Windows-only: focus + clipboard + SendKeys bridge
  │     │     └── windowFocusGuard — VS Code window identification & foreground validation
  │     └── BrokerLogger        — VS Code output channel logger
  ├── BrokerSidebarViewProvider — activity bar sidebar webview
  ├── BrokerPanel               — editor panel webview (alternative to sidebar)
  └── BrokerWebviewConnection   — shared webview message handling for both UI surfaces
```

### Key Patterns

- **Two UI surfaces** (sidebar + panel) share `BrokerWebviewConnection`, which handles all webview messaging. Both surfaces render the same HTML from `media/`.
- **Adapter pattern**: `AgentAdapter` interface in `types.ts`. Claude uses CLI streaming (`--output-format stream-json`); Codex uses JSON-RPC over stdin/stdout (`app-server` subcommand). Codex falls back to `codex exec` if RPC fails.
- **Transcript monitor**: `OfficialTranscriptMonitor` walks the local filesystem to find and parse the most recently modified official session whose `cwd` matches the current workspace. It filters out harness/system messages (e.g., AGENTS.md instructions, permissions prompts).
- **Auto-forward engine**: `AutoForwardEngine` detects keyword-prefixed user messages in monitored transcripts, waits for the model's reply to reach a stable/complete state, then triggers bridge sending. Stability is determined per-agent: Claude checks `stopReason === "end_turn"`, Codex checks `codexComplete` meta or legacy `codexLegacyStable` after a 2-minute cooldown.
- **Bridge automation**: `OfficialUiBridge` uses PowerShell `WScript.Shell.SendKeys` to paste text into the target official plugin's input. Before sending, it validates the foreground window is the correct VS Code workspace window via `windowFocusGuard`. Clipboard is saved and restored around each send.
- **Auto-debate**: Controller supports multi-round auto-debate where responses bounce between Codex and Claude with review/revise prompts.
- **Answer source labels**: answer-only forwarding prefixes content with `Codex说：` or `ClaudeCode说：`; merge-forward keeps the English `User question` / `Codex answer` / `ClaudeCode answer` shape.
- **Windows CLI resolution**: `spawnCli` / `resolveCliCommand` in `utils.ts` resolve bare command names (e.g., `claude`) to `.cmd` shims in `%APPDATA%\npm\` on Windows. Process trees are killed via `taskkill /T /F`.

### Type System

All shared types live in `src/types.ts` — `AgentKind`, `ChatMessage`, `BrokerSnapshot`, `AdapterCallbacks`, `WebviewInboundMessage`, `WebviewOutboundMessage`, `BrokerConfig`, `AutoForwardState`, etc. The `BrokerConfig` type mirrors the VS Code `broker.*` settings and is read fresh each time via `getConfig()` to avoid stale configuration.

### Webview

Frontend assets are plain JS/CSS in `media/` (no bundler). `BrokerWebviewConnection.getHtml()` generates the HTML with CSP nonce. Communication is via `postMessage` using the typed `WebviewInboundMessage`/`WebviewOutboundMessage` protocols.

### Bridge Prompts

`src/controller/bridgePrompt.ts` constructs the text payload for bridge sends. Two modes: `forward-answer` (just the reply, labeled with source) and `merge-forward` (user question + model reply). Both support appending an extra user note.

## Runtime Requirements

- **Windows** required for `OfficialUiBridge` (SendKeys automation)
- Users must have the official **Codex** and/or **Claude Code** VS Code extensions installed and logged in for full bridge behavior
- `codex` and `claude` CLIs must be available on PATH (configurable via `broker.codexPath` / `broker.claudePath` settings)
- Users must start official Codex/Claude conversations from the same VS Code workspace they want Broker Chat to monitor.

## VS Code Settings

All settings are under the `broker.` prefix: `codexPath`, `claudePath`, `defaultReturnMode`, `defaultAutoDebateRounds`, `claudePermissionMode`, `claudeAllowedTools`, `autoForwardEnabled`, `autoForwardKeywords`.

## Language Note

UI strings are in Chinese (zh-CN). The HTML lang is `zh-CN`.
