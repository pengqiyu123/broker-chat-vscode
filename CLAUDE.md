# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A VS Code extension that monitors and bridges conversations between the official Codex and Claude Code VS Code extensions. It reads local transcript files from `~/.codex/sessions` and `~/.claude/sessions` + `~/.claude/projects`, filters them to the current VS Code workspace `cwd`, displays the matching conversations, and can forward messages between the two official plugins via clipboard + keyboard automation (Windows-only for bridge).

The extension does NOT maintain its own chat history or run models directly — it's a read-only monitor + bridge for the official plugins.

## Build & Run

```bash
npm install
npm run compile          # tsc -p ./ (output to dist/)
npm run watch            # tsc -w -p ./ (dev mode)
```

Press **F5** in VS Code to launch Extension Development Host with the launch config in `.vscode/launch.json`.

### Tests

Tests are standalone Node scripts with a minimal inline assertion helper (no test framework). Each script runs the relevant source modules directly:

```bash
npm run test:bridge       # bridge prompt construction logic
npm run test:auto-forward # keyword matching & auto-forward engine (largest test suite)
npm run test:powershell   # PowerShell script generation & focus probe identification
```

To run a single test: `node scripts/test-bridge-prompt.js`. Tests use `process.exit(1)` on failure — a zero exit code means all passed.

### Packaging

```bash
npm run package:vsix     # builds .vsix to artifacts/ (PowerShell script)
npm run install:local    # compiles + copies to ~/.vscode/extensions/
npm run uninstall:local  # removes from ~/.vscode/extensions/
```

## Architecture

```
extension.ts
  └── BrokerController (725 lines) — central state & orchestrator, 1.5s poll cycle
        ├── ClaudeAdapter — spawns `claude` CLI in stream-json mode
        ├── CodexAdapter — connects to Codex via JSON-RPC (`codex app-server`)
        │     └── CodexRpcClient — stdin/stdout JSON-RPC 2.0 transport
        ├── OfficialTranscriptMonitor (540 lines) — polls ~/.codex/sessions & ~/.claude/sessions
        ├── AutoForwardEngine (468 lines) — keyword detection, reply stability tracking
        ├── OfficialUiBridge — Windows-only: focus + clipboard + SendKeys bridge
        │     ├── FocusDetector — UIAutomation focus probe, classifies claude/codex/detector/unknown
        │     └── windowFocusGuard — VS Code window identification & foreground validation
        └── BrokerLogger — VS Code output channel logger
  ├── BrokerSidebarViewProvider — activity bar sidebar webview
  ├── BrokerPanel — editor panel webview (alternative to sidebar)
  └── BrokerWebviewConnection — shared webview HTML generation + message handling
```

### Data Flow

1. `OfficialTranscriptMonitor` polls official session files every **1.5 seconds**
2. `BrokerController.refreshMonitor()` consolidates the snapshot → evaluates auto-forward → pushes to webview via `onDidChange`
3. Webview renders session cards, previews (last 4 messages per agent), and a merged timeline (last 12 messages)
4. User clicks merge-forward / forward-answer buttons, or `AutoForwardEngine` detects keywords in new user messages
5. `bridgePrompt.ts` constructs the text payload
6. `OfficialUiBridge` executes the physical send: foreground window safety check → clipboard swap → focus target agent input → PowerShell SendKeys → clipboard restore

### Key Patterns

- **Two UI surfaces** (sidebar + panel) share `BrokerWebviewConnection` (`src/ui/BrokerWebview.ts`). Both render the same HTML from `media/`. Communication uses `postMessage` with typed `WebviewInboundMessage`/`WebviewOutboundMessage` protocols.
- **Adapter pattern**: `AgentAdapter` interface in `types.ts`. Claude uses CLI streaming (`--output-format stream-json`); Codex uses JSON-RPC over stdin/stdout (`app-server` subcommand). Codex falls back to `codex exec` (writes output to temp file) if RPC connection fails.
- **Transcript monitor**: Walks the local filesystem to find the most recently modified official session whose `cwd` matches the current workspace. Filters out harness/system messages (AGENTS.md instructions, permissions prompts, environment context). Prefers the "pending auto-forward" session if still valid. Codex sessions are JSONL at `~/.codex/sessions/`; Claude sessions use an index at `~/.claude/sessions/*.json` pointing to transcript JSONL under `~/.claude/projects/`.
- **Auto-forward engine**: Keyword matching checks only the **first and last 40 characters** of user messages (edge matching). Keywords appearing in the message body are ignored. Case-insensitive, trailing punctuation stripped. State machine: `idle → waiting → sending → sent/failed`. Tracks `seenUserMessageIds` and `handledUserMessageIds` to avoid replaying historical messages.
- **Completion detection** (per-agent): Claude checks `stopReason === "end_turn"`. Codex checks `meta.codexComplete` (from `task_complete` events) or falls back to legacy stability heuristic (2+ unchanged snapshots, no turn events, >2 min since last update).
- **Bridge automation**: `OfficialUiBridge` uses PowerShell `WScript.Shell.SendKeys` to paste text into the target official plugin's input. Validates the foreground window is the correct VS Code workspace via `windowFocusGuard`. Clipboard is saved and restored around each send (250ms delay). Respects per-agent enter key settings (`useCtrlEnterToSend` for Claude, `composerEnterBehavior` for Codex).
- **FocusDetector**: Runs a PowerShell UIAutomation script to classify the focused element as `claude` (Message input with `messageInput_` class), `codex` (ProseMirror-focused with Codex RootWebArea parent), `detector` (Broker's own status detector), or `unknown`. Used for both bridge sending diagnostics and the `probeFocus` command.
- **Auto-debate**: Controller supports multi-round auto-debate where responses bounce between Codex and Claude with review/revise prompts. Configurable rounds (1–3) and return mode (compact/full).
- **Answer source labels**: answer-only forwarding prefixes content with `Codex说：` or `ClaudeCode说：`; merge-forward keeps the English `User question` / `Codex answer` / `ClaudeCode answer` shape.
- **Windows CLI resolution**: `spawnCli` / `resolveCliCommand` in `utils.ts` resolve bare command names to `.cmd` shims in `%APPDATA%\npm\`. Process trees are killed via `taskkill /T /F`.
- **Config refresh**: `BrokerConfig` is read fresh each time via `getConfig()` — never cached — to avoid stale configuration.

### Type System

All shared types in `src/types.ts`: `AgentKind`, `ChatMessage` (with `usage`, `meta`, `approval`, `actions`, `sourceAgent`), `BrokerSnapshot`, `AdapterCallbacks`, `WebviewInboundMessage`, `WebviewOutboundMessage`, `BrokerConfig`, `AutoForwardState`, `BridgeStatus`, `ApprovalState`, etc.

### Webview Frontend

Plain JS/CSS in `media/` (no bundler). `main.js` (~19KB) renders status bar, session cards, agent previews, merged timeline, bridge action buttons, and settings panel. `styles.css` uses dark theme with glassmorphism. `BrokerWebview.getHtml()` generates the HTML with CSP nonce.

### Bridge Prompts

`src/controller/bridgePrompt.ts` — two modes: `forward-answer` (just the reply, labeled with source) and `merge-forward` (user question + model reply). Both support appending an extra user note. Directional role prefixes are prepended before either prompt shape, using `broker.directionalRolePrefixes`; saved empty strings must remain a no-op.

## Runtime Requirements

- **Windows** required for `OfficialUiBridge` (SendKeys automation). Monitoring and transcript parsing work on any platform.
- Official **Codex** and/or **Claude Code** VS Code extensions must be installed and logged in.
- `codex` and `claude` CLIs on PATH (configurable via `broker.codexPath` / `broker.claudePath`).
- Official conversations must be started from the same VS Code workspace.

## VS Code Settings

All settings under `broker.` prefix: `codexPath`, `claudePath`, `defaultReturnMode` (compact/full), `defaultAutoDebateRounds` (1–3), `claudePermissionMode` (default/plan/acceptEdits/auto/bypassPermissions/dontAsk), `claudeAllowedTools` (string array), `autoForwardEnabled` (boolean), `autoForwardKeywords` (object with `codex` and `claude` string arrays), `directionalRolePrefixes` (object with `claudeToCodex` and `codexToClaude` strings).

## Commands

- `broker.openChat` — refresh monitor, reveal sidebar, post snapshot
- `broker.newSession` — dispose adapters, clear messages, reset state
- `broker.stopActiveResponse` — stop both adapters
- `broker.showLogs` — toggle output channel
- `broker.probeFocus` — 3-second delay then read-only UIAutomation focus probe (no clipboard or send)

## Language Note

UI strings and README are in Chinese (zh-CN). HTML lang is `zh-CN`. Auto-forward keywords default to Chinese phrases.
