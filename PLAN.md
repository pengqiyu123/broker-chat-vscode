# Project Plan

## Current Release

Version `0.0.1` is a local VS Code extension that monitors current-workspace Codex and Claude Code official conversations and bridges selected replies between them.

## Implemented

- Current VS Code workspace `cwd` is passed into the transcript monitor.
- Codex and Claude Code transcript selection is isolated by matching `cwd`.
- The UI shows a 3-card summary: monitor status, current project, and bridge status.
- Answer-only forwarding prefixes content with `Codex说：` or `ClaudeCode说：`.
- Merge-forward keeps the structured `User question` plus model answer format.
- VSIX packaging excludes source, temporary planning notes, sourcemaps, and generated artifacts.

## Future Improvements

- Add a session picker for multiple conversations in the same project.
- Add a pinned-session mode so users can lock a specific Codex or Claude conversation.
- Add clearer UI guidance when official transcript formats change.
- Add automated tests for transcript parsing and prompt construction.
