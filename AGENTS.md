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

## Development Notes

- Keep bridge and adapter changes separate from monitor/session-selection changes.
- Run `npm run compile` after TypeScript edits.
- Run `npm run package:vsix` before sharing a new build.
- This project is Windows-first for bridge-send automation.
- Keep generated packages and build output out of git; package from source when needed.
