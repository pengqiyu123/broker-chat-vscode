# Changelog

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
