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
- `src/automation/FocusDetector.ts` — read-only UIAutomation focus diagnostics for Codex / Claude Code input routing.
- `src/automation/windowFocusGuard.ts` — pure foreground-window matching helpers used before Windows SendKeys.
- `src/controller/bridgePrompt.ts` — shared prompt formatting for manual and automatic forwarding.
- `src/controller/brokerController.ts` — coordinates monitor refresh, auto-forward decisions, bridge sends, and webview config updates.
- `media/main.js` / `media/styles.css` — status bar and settings panel.

Forwarding behavior:

- Manual `forward-answer` format is `Codex说：...` or `ClaudeCode说：...`.
- Manual `merge-forward` includes adjacent user question, source answer, and optional note.
- Automatic forwarding only uses the answer format.
- Optional directional role prefixes are prepended before the existing bridge prompt. They ship with user-approved role-locking defaults, and empty saved prefixes must preserve the v0.0.8 prompt output exactly.
- Automatic target is determined by matched keyword group, not by blindly choosing the opposite side.
- Automatic keywords are matched only against official `user` messages. Broker checks the first and last 40 characters only: the head must start with a keyword, or the tail must end with a keyword after trimming common trailing punctuation. Keep ASCII case-insensitivity and do not remove internal spaces for matching.
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

- Windows bridge sending is fail-safe around the proven manual-forwarding path.
- First verify the foreground window is the unique VS Code window for the current workspace. If verification fails, surface the real error and do not write or send keys.
- Preserve the v0.0.3 success mechanism: save clipboard, write forwarding text, call the target official extension focus command, wait briefly, then paste and submit in one SendKeys process.
- Keep the target-specific official focus commands that reliably focus Claude Code or Codex input boxes. Do not replace them with generic VS Code window focus.
- Do not auto-activate VS Code from the background, move the mouse pointer, or add broad fallback branches that can open the wrong conversation.
- Always restore the clipboard after send/failure.

Bridge focus debugging rules learned from real UIAutomation samples:

- Do not infer target focus from VS Code window titles, conversation titles, active tab labels, or `vscode.window.state.focused`; these were observed to be misleading.
- Before changing bridge recognition/routing logic, first collect raw UIAutomation current element and parent-chain samples, then have the user label them.
- Labeled samples from this project showed:
  - Detector focus: current element or parent chain contains the detector webview name.
  - Codex input focus: current element class includes `ProseMirror-focused`, and the parent chain contains `name=Codex` with `automationId=RootWebArea` or `automationId=active-frame`.
  - ClaudeCode input focus: current element has `name=Message input`, class starting with `messageInput_`, and `controlType=ControlType.Edit`.
- Current production behavior uses these signatures for diagnostics only: `OfficialUiBridge` logs focus state before and after official focus commands, and `broker.probeFocus` samples focus after a short delay.
- Do not add a blocking UIAutomation guard without first preserving the proven manual forwarding path in tests and manual validation. If a guard is added later, prefer enabling it for auto-forward first.
- Focus diagnostic logs must stay short and must not dump full conversation text or forwarded body content.

Configuration:

- `broker.autoForwardEnabled`: boolean, default `true`.
- `broker.autoForwardKeywords`: object `{ codex: string[], claude: string[] }`.
- `broker.directionalRolePrefixes`: object `{ claudeToCodex: string, codexToClaude: string }`, default role-locking text that the user may clear.
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
npm run test:powershell
npm audit --omit=dev
```

Before sharing a build, confirm the VSIX includes compiled `dist` output and does not depend on removed MCP assets.
