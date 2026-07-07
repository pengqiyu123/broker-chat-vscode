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
- `docs/` holds planning and investigation notes that are required reading before bridge/adapter/ZCode work (see Phase 1 below). Treat its findings as load-bearing — they were verified by real protocol probes, not speculation.

## Adapter Architecture (extension point for a new agent kind)

The supported agent set is closed by the `AgentKind` union in `src/types.ts` (currently `"codex" | "claude"`). Adding a third endpoint is a typed, four-step change — do not invent a parallel dispatch path:

1. Extend `AgentKind` in `src/types.ts` (`FocusIdentifiedAgent`, `ChatRole`, and all `sourceAgent`/`target`/`startTarget` fields flow from it).
2. Add an `AgentAdapter` implementation under `src/adapters/` (interface: `startSession`, `sendMessage(request, callbacks)`, `stop`, `dispose`, optional `resolveApproval`).
3. Register it in `src/controller/brokerController.ts` on the `adapters: Record<AgentKind, AgentAdapter>` map (currently wired at the controller constructor around the `ClaudeAdapter`/`CodexAdapter` imports). The stop/dispose sweeps and `adapters[target].sendMessage` calls are keyed by `AgentKind`, so they pick up the new entry automatically once the union and map agree.
4. Add the monitor/reader path for that agent's transcripts (Codex/Claude go through `src/monitor/OfficialTranscriptMonitor.ts`).

`AgentAdapter` is a re-export barrel (`src/adapters/AgentAdapter.ts`) — import adapter types from `../types`, not from individual adapter files. Keep bridge/prompt formatting shared via `src/controller/bridgePrompt.ts` so manual and automatic forwarding stay consistent.

## Red/blue pair model (manual bridging)

Manual bridging no longer assumes Claude↔Codex. The user picks two agents (red/blue slots; the user is "white") from {claude, codex, zcode}. Key implementation facts:

- Pair state is **in-memory only** (`BrokerController.pair: BridgePairState`); it resets to `{red:"claude", blue:"codex"}` on VS Code restart. It is intentionally not persisted — do not write it to workspace config.
- `bridgeMonitoredMessage` resolves the target via `getBridgeTarget(sourceAgent)`: red's partner is blue, blue's partner is red. The legacy binary `otherAgent()` flip in `src/utils.ts` is **only** used by the codex/claude-only auto-debate path; do not extend it to zcode.
- After a pair change, `checkPair()` auto-detects both ends: codex/claude check `vscode.commands.getCommands()` for the official focus command; zcode discovers the running `ZCode.exe` process + verifies CDP port 9224 (auto-restarts ZCode with `--remote-debugging-port=9224` if not reachable) + app-server `session/list`. A failing end is cleared to `null`.
- ZCode exe path is **auto-discovered** from the running process command line (`Get-CimInstance Win32_Process`), never persisted. ZCode data dir comes from `broker.zcodeDataDir` setting.
- `ZCodeAdapter` is instantiated lazily — only when zcode is in the pair AND passes the check. The monitor's zcode reader reuses the same adapter instance via `readZCodeMonitoredSession` injection; it returns `undefined` (not an error) when zcode is not in the pair or unconfigured.
- `AutoForwardEngine` is **unchanged** and codex/claude-only. ZCode is not part of automatic keyword forwarding. The engine reads `snapshot.monitor.zcode` harmlessly (ignores it).
- The ZCode adapter's reply poll establishes a baseline `session/resume` message count right before CDP inject, so only post-send assistant deltas stream via `onTextDelta`; `info.finish === "stop"` on the last assistant message triggers `onComplete`.
- Directional role prefixes were migrated from `claudeToCodex`/`codexToClaude` to **red/blue slots** (`DirectionalRolePrefixes = {red, blue}`). The original two paragraphs of identity-locking text are preserved verbatim (red = "你是ClaudeCode…", blue = "你是Codex…"). When forwarding into red, the red prefix is prepended; into blue, the blue prefix. `normalizeDirectionalRolePrefixes` still migrates old-format saved values.

## Phase 1: ZCode third endpoint (implemented)

`docs/phase1-plan.md` and `docs/send-method-test-log.md` defined adding **ZCode** (an external Electron app) as a third bridgeable endpoint. Claude↔Codex is unchanged; ZCode is a new `ZCodeAdapter` plus a red/blue pair-selection model. ⚠️ **The send-method test log's "session/send triggers AI" conclusion (ZC-SEND-003 / ZC-DUP-007) is WRONG** — see "Send channel" below. Read both docs critically; only the facts below are re-verified by clean experiments.

### Send channel — CDP, NOT app-server (verified 2026-07-03)

- **`session/send` does NOT trigger AI reply.** It only appends the text to session history and creates an empty assistant placeholder; the AI never starts. Confirmed by a clean test: after send, polling 15s showed message count frozen and the assistant message stayed empty. The old test-log success was a misread.
- **Synthesized keyboard events are blocked by ZCode.** SendInput Ctrl+V, `keybd_event`-equivalent `WScript.Shell.SendKeys`, and `ValuePattern.SetValue` all fail (physical keyboard Ctrl+V works; synthesized ones don't). External UIAutomation injection into the input box does not work.
- **The only working channel is CDP (Chrome DevTools Protocol).** ZCode must launch with `--remote-debugging-port=9224`. Broker connects to `ws://127.0.0.1:9224/devtools/page/<id>` (find the page whose `url` contains `renderer/index.html`), then via `Runtime.evaluate`:
  1. Write text: `document.querySelector('[data-testid="chat-input"]').textContent = ...` + dispatch an `InputEvent('input', {inputType:'insertText', ...})`. React accepts this.
  2. Submit: click the form's last button (aria-label "加入队列" when input is non-empty) — this triggers the agent loop and the AI actually replies. Submit success = input box auto-clears.
- `ZCodeCdpClient` (`src/adapters/ZCodeCdpClient.ts`) implements this. `cdpSendToZCodeInput(text)` does inject+submit; `isCdpReachable()` checks port 9224.
- **Broker auto-restarts ZCode with the debug port** (`BrokerController.restartZcodeWithDebugPort`): `taskkill /IM ZCode.exe /F` → `spawn(<exe>, ['--remote-debugging-port=9224'])` → poll `isCdpReachable()` up to 15s. Triggered from `checkZcodeAvailable` when CDP is not reachable.

### Read channel — app-server (still valid)

The app-server stdio protocol is still used for **reading** (it works fine for that; only `session/send` is broken). Keep `ZCodeRpcClient` for monitor reads:
- Launch: `ELECTRON_RUN_AS_NODE=1 <ZCode.exe> <resources/glm/zcode.cjs> app-server --stdio`. Rejects `jsonrpc` field; request shape `{id, method, params}`.
- `session/list` → `{sessions: [...]}` (NOT a bare array). Filter client-side by `workspace.workspacePath`. Sessions are global, not per-project.
- `session/resume` reads any session history (NOT `session/read`, which only works on active sessions and errors "Session is not active" otherwise). Messages have `parts[].text` (not `content`); `info.role` is user/assistant; `info.time.created` is the timestamp; `info.finish === "stop"` is final.
- **Harness noise filter**: ZCode injects framework messages (e.g. "The TodoWrite tool hasn't been used...") as user/assistant messages. `isZCodeHarnessNoise(text)` drops any message whose text **starts with** a known harness prefix. Use startswith, not contains, to avoid killing real messages that quote the template.

### Turn aggregation

ZCode emits N assistant messages per turn (many `tool-calls` steps + one `stop` summary). `ZCodeAdapter.mapToMonitoredSession` aggregates: per turn (delimited by user messages), consecutive `tool-calls` collapse into one "process card" (`meta.zcodeProcess: true`), the `stop` message is its own card. The webview renders process cards as collapsible `<details>` (default folded); expansion state survives 1.5s re-renders via `data-process-id` tracking.

### API-key discipline (hard rule)

Provider config (`<zcode data dir>\.zcode\v2\config.json`) contains `apiKey`. Since send no longer goes through app-server, the key is only needed if `runtimeModel` is ever reconstructed — but CDP send doesn't need it. Keep keys in memory only; never persist/log/diagnostic-pack/UI-display. Logs record field *presence* only.

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
