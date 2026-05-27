# Broker Chat VS Code Extension

Broker Chat is a local VS Code extension for monitoring and bridging the official Codex and Claude Code VS Code conversations in the current project.

It does not run models directly and does not keep its own chat history. It reads local official transcript files, shows the latest matching project sessions, and can forward selected model replies into the other official extension.

## Features

- Monitors official Codex transcripts from `~/.codex/sessions`.
- Monitors official Claude Code transcripts from `~/.claude/sessions` and `~/.claude/projects`.
- Isolates sessions by the current VS Code workspace `cwd`, so different project windows do not show each other's conversations.
- Shows a compact top summary: `监控状态`, `当前项目`, and `桥接状态`.
- Bridges selected replies with clipboard and keyboard automation on Windows.
- Adds source labels for answer-only forwarding: `Codex说：` or `ClaudeCode说：`.

## Requirements

- VS Code `1.98.0` or newer.
- Windows is required for bridge-send automation.
- Official Codex VS Code extension installed and logged in.
- Official Claude Code VS Code extension installed and logged in.
- Start at least one official Codex or Claude Code conversation inside the same VS Code workspace you want Broker Chat to monitor.

Monitoring works from local transcript files. Bridge sending needs the official extension UI to be available and focusable.

## Install From VSIX

1. Get the generated `.vsix` file from the person sharing this extension.
2. Open VS Code.
3. Open Extensions.
4. Click the `...` menu.
5. Choose `Install from VSIX...`.
6. Select the `.vsix` file.
7. Fully close and reopen VS Code.
8. Open `Broker Chat` from the activity bar or run `Open Broker Chat` from the Command Palette.

## Develop From Source

```powershell
npm install
npm run compile
```

To run in a development host:

1. Open this folder in VS Code.
2. Press `F5`.
3. In the Extension Development Host, run `Open Broker Chat`.

To install locally into normal VS Code:

```powershell
npm run install:local
```

To package a shareable VSIX:

```powershell
npm run package:vsix
```

The package is written to `artifacts/`.

## Commands

- `Open Broker Chat`
- `New Broker Session`
- `Stop Active Response`

## How Session Matching Works

Broker Chat only displays official sessions whose `cwd` matches the current VS Code workspace folder.

- Codex: reads `session_meta.cwd` from `~/.codex/sessions/**/*.jsonl`.
- Claude Code: reads `cwd` from `~/.claude/sessions/*.json`, then locates the matching transcript in `~/.claude/projects`.
- If no matching session exists, Broker Chat shows an empty state instead of falling back to another project's latest conversation.

This is intentional. It prevents multiple VS Code windows from mixing conversations across projects.

## Quick Test

1. Open a project folder in VS Code.
2. Start a real Codex conversation in that workspace.
3. Start a real Claude Code conversation in that workspace.
4. Open Broker Chat.
5. Confirm the top summary shows the current project name.
6. Confirm the Codex and Claude sections show conversations for this project.
7. Click `仅转发这条回答` under a model reply.
8. Confirm the target official extension receives text prefixed with `Codex说：` or `ClaudeCode说：`.

## Limitations

- Bridge sending is Windows-only.
- If there are multiple official conversations for the same project and same agent, Broker Chat follows the most recently updated one.
- The extension depends on the local transcript formats used by the official Codex and Claude Code extensions.
- It does not replace the official Codex or Claude Code UI.
