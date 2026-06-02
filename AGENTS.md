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
- Automatic forwarding must never replay historical messages that existed before the feature was enabled or initialized.

## Documentation Responsibilities

- `README.md` is for users installing and operating the extension. Keep it short, product-facing, and free of implementation detail unless needed to complete setup.
- `AGENTS.md` is for coding agents and maintainers. Put architecture notes, internal APIs, validation commands, transcript format assumptions, and maintenance guardrails here.
- Do not move low-level parser, state-machine, or packaging details into README unless a normal user must perform that step.

## Automatic Forwarding Architecture

Broker Chat now has two product modes:

- Manual plugin forwarding from the monitored timeline.
- Automatic keyword forwarding from official transcript user messages.

There is no MCP server or localhost HTTP API in this version.

Key files:

- `src/automation/AutoForwardEngine.ts` — detects keyword-triggered user messages, tracks pending replies, and returns forwarding decisions.
- `src/automation/windowFocusGuard.ts` — pure foreground-window matching helpers used before Windows SendKeys.
- `src/controller/bridgePrompt.ts` — shared prompt formatting for manual and automatic forwarding.
- `src/controller/brokerController.ts` — coordinates monitor refresh, auto-forward decisions, bridge sends, and webview config updates.
- `media/main.js` / `media/styles.css` — status bar and settings panel.

Forwarding behavior:

- Manual `forward-answer` format is `Codex说：...` or `ClaudeCode说：...`.
- Manual `merge-forward` includes adjacent user question, source answer, and optional note.
- Automatic forwarding only uses the answer format.
- Automatic target is determined by matched keyword group, not by blindly choosing the opposite side.
- Automatic keywords are matched only against official `user` messages, using strict prefix matching after `trimStart()` with ASCII case-insensitivity. Do not remove internal spaces for matching.
- If the keyword target equals the source session agent, ignore that user message; do not send back into the same official panel.
- On first initialization, re-enable, or keyword save, the engine seeds current transcript user messages as seen so old messages do not fire.
- A failed auto-forward should be marked failed with the real bridge error and should not loop endlessly.

Completion behavior:

- Claude assistant messages preserve `message.stop_reason` as `meta.stopReason`; `end_turn` is considered complete.
- Claude non-`end_turn` stop reasons are not considered final.
- Codex modern JSONL uses a turn state machine: `event_msg.task_started`, assistant `response_item.message`, then `event_msg.task_complete`.
- `task_complete.last_agent_message` marks the matching Codex reply as `meta.codexComplete=true`; if it is null, mark the latest same-turn `phase="final_answer"` reply.
- If a Codex turn has `task_started` but no `task_complete`, keep waiting. Do not use short quiet-window polling because Codex can pause for 30-40 seconds between output chunks.
- Legacy Codex logs with no turn events may mark the last assistant reply as `meta.codexLegacyStable=true` only after the transcript file is at least 120 seconds old; the engine still requires two identical polls.
- Auto-forward pending state carries `sourcePath`; monitor refresh should prefer that session so long tasks are not displaced by another newer session.

Bridge send behavior:

- Windows bridge sending is fail-safe. Before paste and before submit, verify the foreground window is the unique VS Code window for the current workspace.
- If foreground verification fails, restore the clipboard and surface the real error. Never send keys to an unverified foreground window.
- Do not call official Claude/Codex focus/open commands before SendKeys. Broker only brings the current workspace VS Code window to the foreground; the user must keep the target official input focused inside that window. Calling extension focus commands can open or switch conversations.

Configuration:

- `broker.autoForwardEnabled`: boolean, default `true`.
- `broker.autoForwardKeywords`: object `{ codex: string[], claude: string[] }`.
- Webview settings write to workspace configuration.

## Development Notes

- Keep bridge and adapter changes separate from monitor/session-selection changes.
- Run `npm run compile` after TypeScript edits.
- Run `npm run package:vsix` before sharing a new build.
- This project is Windows-first for bridge-send automation.
- Keep generated packages and build output out of git; package from source when needed.

## Verification

Use these checks for auto-forward or bridge changes:

```powershell
npm run compile
npm run test:bridge
npm run test:auto-forward
npm audit --omit=dev
```

Before sharing a build, confirm the VSIX includes compiled `dist` output and does not depend on removed MCP assets.
