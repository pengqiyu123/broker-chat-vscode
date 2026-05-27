# Compatibility

## Supported Setup

- VS Code `1.98.0` or newer.
- Windows for bridge-send automation.
- Official Codex VS Code extension installed and logged in.
- Official Claude Code VS Code extension installed and logged in.
- Official conversations started from the same VS Code workspace folder Broker Chat is monitoring.

## What Works Cross-Machine

Broker Chat uses each user's local transcript directories:

- Codex: `~/.codex/sessions`
- Claude Code: `~/.claude/sessions` and `~/.claude/projects`

No transcript data is packaged or shared. Each recipient sees only their own local official conversations.

## Known Limits

- Bridge sending uses Windows focus, clipboard, and key injection, so it is not expected to work on macOS or Linux yet.
- If the official Codex or Claude Code extensions change their local transcript formats, the monitor may need an update.
- If multiple conversations exist for the same project and same agent, the newest updated conversation is shown.

## Sharing A Build

Run:

```powershell
npm run package:vsix
```

Share the generated file under `artifacts/`. Recipients do not need the source tree or `node_modules`.
