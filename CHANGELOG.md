# Changelog

## 0.0.8

- Shortened focus diagnostic summaries so logs show routing evidence without dumping long conversation text.

## 0.0.7

- Changed focus probe command to sample after a 3-second delay so the command palette does not steal the measured focus.

## 0.0.6

- Added read-only focus diagnostics for Codex and Claude Code input routing.
- Added bridge logs that record focus state before and after official panel focus commands.
- Added `Probe Broker Focus` command for collecting focus evidence without sending text.

## 0.0.5

- Automatic forwarding keywords now trigger from the beginning or end of a user message, without scanning the middle of long pasted text.
- Added regression coverage for long-message head, tail, and middle keyword matching.

## 0.0.4

- Added keyword-based automatic forwarding between official Codex and Claude Code conversations.
- Restored reliable manual bridge focus behavior while adding a foreground VS Code workspace safety check.
- Added Codex completion detection using official task completion events to avoid forwarding unfinished long tasks.
- Added sticky top status details and Broker Chat logs for bridge/auto-forward diagnostics.
- Removed MCP/HTTP forwarding surfaces; Broker now focuses on manual plugin forwarding and automatic keyword forwarding.

## 0.0.1

- Added current-workspace transcript monitoring for official Codex and Claude Code conversations.
- Added VS Code-window-safe session isolation by matching transcript `cwd`.
- Added bridge forwarding between official Codex and Claude Code panels on Windows.
- Added source-prefixed answer-only forwarding with `Codex说：` and `ClaudeCode说：`.
- Added a compact 3-card summary with monitor status, current project, and bridge status.
- Added VSIX packaging scripts for local sharing.
