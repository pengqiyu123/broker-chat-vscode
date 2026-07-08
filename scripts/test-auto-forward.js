const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  AutoForwardEngine,
  DEFAULT_AUTO_FORWARD_KEYWORDS
} = require("../dist/automation/AutoForwardEngine");
const {
  isForegroundWorkspaceWindow,
  selectUniqueWorkspaceWindow
} = require("../dist/automation/windowFocusGuard");
const { OfficialTranscriptMonitor } = require("../dist/monitor/OfficialTranscriptMonitor");

const workspaceCwd = "D:\\python\\broker-chat-vscode";

const config = {
  enabled: true,
  keywords: DEFAULT_AUTO_FORWARD_KEYWORDS
};

const strictConfig = {
  enabled: true,
  keywords: {
    codex: ["给Codex命令"],
    claude: ["回复ClaudeCode"]
  }
};

function message(id, role, text, createdAt, meta = {}) {
  return {
    id,
    role,
    text,
    createdAt,
    meta
  };
}

function session(agent, messages, overrides = {}) {
  return {
    agent,
    sessionId: overrides.sessionId || `${agent}-session`,
    title: `${agent} session`,
    cwd: workspaceCwd,
    sourcePath: overrides.sourcePath || `${agent}.jsonl`,
    updatedAt: overrides.updatedAt || messages.at(-1)?.createdAt || 1,
    messageCount: messages.length,
    messages
  };
}

function snapshot(codexMessages, claudeMessages, overrides = {}) {
  return {
    enabled: true,
    lastUpdated: Date.now(),
    codex: codexMessages ? session("codex", codexMessages, overrides.codex) : undefined,
    claude: claudeMessages ? session("claude", claudeMessages, overrides.claude) : undefined
  };
}

function jsonlLine(type, payload, timestamp = "2026-06-02T12:00:00.000Z") {
  return JSON.stringify({ timestamp, type, payload });
}

async function parseCodexFixture(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-codex-fixture-"));
  const filePath = path.join(dir, "session.jsonl");
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  const monitor = new OfficialTranscriptMonitor(workspaceCwd);
  const stat = fs.statSync(filePath);
  return monitor.parseCodexSessionForTest(filePath, Number(stat.mtimeMs), workspaceCwd);
}

async function main() {
  {
    const engine = new AutoForwardEngine();
    const historical = snapshot(
      undefined,
      [
        message("u1", "user", "给Codex命令：总结一下", 1000),
        message("a1", "claude", "历史回复", 2000, { stopReason: "end_turn" })
      ]
    );

    assert.equal(engine.evaluate(historical, config), undefined);
    assert.equal(engine.getState().status, "idle");
  }

  {
    const engine = new AutoForwardEngine();
    engine.evaluate(snapshot(undefined, [message("old", "user", "普通消息", 1000)]), config);

    const waiting = snapshot(
      undefined,
      [
        message("old", "user", "普通消息", 1000),
        message("u2", "user", "给Codex命令：请检查这段代码", 2000)
      ]
    );
    assert.equal(engine.evaluate(waiting, config), undefined);
    assert.equal(engine.getState().status, "waiting");
    assert.equal(engine.getState().target, "codex");

    const completed = snapshot(
      undefined,
      [
        message("old", "user", "普通消息", 1000),
        message("u2", "user", "给Codex命令：请检查这段代码", 2000),
        message("a2", "claude", "可以发给 Codex 的正文", 3000, { stopReason: "end_turn" })
      ]
    );
    const decision = engine.evaluate(completed, config);
    assert.equal(decision && decision.sourceAgent, "claude");
    assert.equal(decision && decision.targetAgent, "codex");
    assert.equal(decision && decision.messageId, "a2");

    engine.markForwarded(decision);
    assert.equal(engine.evaluate(completed, config), undefined);
  }

  {
    const engine = new AutoForwardEngine();
    engine.evaluate(snapshot([message("old", "user", "普通消息", 1000)], undefined), config);

    const withUser = snapshot(
      [
        message("old", "user", "普通消息", 1000),
        message("u3", "user", "回复ClaudeCode：请审阅", 2000)
      ],
      undefined
    );
    assert.equal(engine.evaluate(withUser, config), undefined);

    const unfinishedReply = snapshot(
      [
        message("old", "user", "普通消息", 1000),
        message("u3", "user", "回复ClaudeCode：请审阅", 2000),
        message("a3", "codex", "Codex 第一段正文", 3000, { codexHasTurnEvents: true })
      ],
      undefined
    );
    assert.equal(engine.evaluate(unfinishedReply, config), undefined);
    assert.equal(engine.evaluate(unfinishedReply, config), undefined);
    assert.equal(engine.evaluate(unfinishedReply, config), undefined);
    assert.equal(engine.getState().status, "waiting");

    const completedReply = snapshot(
      [
        message("old", "user", "普通消息", 1000),
        message("u3", "user", "回复ClaudeCode：请审阅", 2000),
        message("a3", "codex", "Codex 最终正文", 3000, { codexHasTurnEvents: true, codexComplete: true })
      ],
      undefined
    );
    const decision = engine.evaluate(completedReply, config);
    assert.equal(decision && decision.sourceAgent, "codex");
    assert.equal(decision && decision.targetAgent, "claude");
    assert.equal(decision && decision.messageId, "a3");
  }

  {
    const engine = new AutoForwardEngine({ now: () => 10 * 60 * 1000 });
    engine.evaluate(snapshot([message("old", "user", "普通消息", 1000)], undefined), config);
    const orphanTurn = snapshot(
      [
        message("old", "user", "普通消息", 1000),
        message("u4", "user", "回复ClaudeCode：长任务", 2000),
        message("a4", "codex", "Codex 先输出一段，40 秒后还会继续", 42000, { codexHasTurnEvents: true })
      ],
      undefined,
      { codex: { updatedAt: 42000 } }
    );
    assert.equal(engine.evaluate(orphanTurn, config), undefined);
    assert.equal(engine.getState().status, "waiting");
  }

  {
    const engine = new AutoForwardEngine();
    engine.evaluate(snapshot([message("old", "user", "普通消息", 1000)], undefined), config);
    const sameSide = snapshot(
      [
        message("old", "user", "普通消息", 1000),
        message("u5", "user", "给Codex命令：不要发回同侧", 2000),
        message("a5", "codex", "同侧目标正文", 3000, { codexHasTurnEvents: true, codexComplete: true })
      ],
      undefined
    );
    assert.equal(engine.evaluate(sameSide, config), undefined);
    assert.equal(engine.getState().status, "idle");
  }

  {
    const engine = new AutoForwardEngine();
    engine.evaluate(snapshot(undefined, [message("old", "user", "普通消息", 1000)]), strictConfig);

    const assistantKeyword = snapshot(
      undefined,
      [
        message("old", "user", "普通消息", 1000),
        message("a6", "claude", "给Codex命令：assistant 里出现不触发", 2000, { stopReason: "end_turn" })
      ]
    );
    assert.equal(engine.evaluate(assistantKeyword, strictConfig), undefined);

    const middleKeyword = snapshot(
      undefined,
      [
        message("old", "user", "普通消息", 1000),
        message("u6", "user", "请解释“给Codex命令”这几个字", 3000)
      ]
    );
    assert.equal(engine.evaluate(middleKeyword, strictConfig), undefined);

    const spacedKeyword = snapshot(
      undefined,
      [
        message("old", "user", "普通消息", 1000),
        message("u7", "user", "给 Codex命令：内部空格不兼容", 4000)
      ]
    );
    assert.equal(engine.evaluate(spacedKeyword, strictConfig), undefined);

    const caseVariant = snapshot(
      undefined,
      [
        message("old", "user", "普通消息", 1000),
        message("u8", "user", "给CODEX命令：ASCII 大小写兼容", 5000)
      ]
    );
    assert.equal(engine.evaluate(caseVariant, strictConfig), undefined);
    assert.equal(engine.getState().status, "waiting");
    assert.deepEqual(engine.getPendingSession(), {
      agent: "claude",
      sessionId: "claude-session",
      sourcePath: "claude.jsonl"
    });
  }

  {
    const engine = new AutoForwardEngine();
    engine.evaluate(snapshot([message("old", "user", "普通消息", 1000)], undefined), strictConfig);
    const longBody = "这是一段很长的用户正文，用来模拟粘贴大段内容时不应该扫描中间关键词。".repeat(8);

    const longMiddleKeyword = snapshot(
      [
        message("old", "user", "普通消息", 1000),
        message("u8-middle", "user", `请先阅读下面内容：${longBody} 回复ClaudeCode：这个中间关键词不应触发 ${longBody}`, 2000)
      ],
      undefined
    );
    assert.equal(engine.evaluate(longMiddleKeyword, strictConfig), undefined);
    assert.equal(engine.getState().status, "idle");
  }

  {
    const engine = new AutoForwardEngine();
    engine.evaluate(snapshot([message("old", "user", "普通消息", 1000)], undefined), strictConfig);
    const longBody = "这是一段很长的用户正文，用来模拟粘贴大段内容时关键词在开头仍然有效。".repeat(8);

    const longHeadKeyword = snapshot(
      [
        message("old", "user", "普通消息", 1000),
        message("u8-head", "user", `回复ClaudeCode：${longBody}`, 2000)
      ],
      undefined
    );
    assert.equal(engine.evaluate(longHeadKeyword, strictConfig), undefined);
    assert.equal(engine.getState().status, "waiting");
  }

  {
    const engine = new AutoForwardEngine();
    engine.evaluate(snapshot([message("old", "user", "普通消息", 1000)], undefined), strictConfig);
    const longBody = "这是一段很长的用户正文，用来模拟粘贴大段内容时关键词放在结尾也应该有效。".repeat(8);

    const longTailKeyword = snapshot(
      [
        message("old", "user", "普通消息", 1000),
        message("u8-tail", "user", `${longBody}\n\n回复ClaudeCode：`, 2000)
      ],
      undefined
    );
    assert.equal(engine.evaluate(longTailKeyword, strictConfig), undefined);
    assert.equal(engine.getState().status, "waiting");
  }

  {
    const disabledEngine = new AutoForwardEngine();
    disabledEngine.evaluate(snapshot([message("old", "user", "普通消息", 1000)], undefined), config);
    const disabledDecision = disabledEngine.evaluate(
      snapshot(
        [
          message("old", "user", "普通消息", 1000),
          message("u9", "user", "回复ClaudeCode：禁用时不应触发", 2000),
          message("a9", "codex", "禁用回复", 3000, { codexHasTurnEvents: true, codexComplete: true })
        ],
        undefined
      ),
      {
        ...config,
        enabled: false
      }
    );
    assert.equal(disabledDecision, undefined);
    assert.equal(disabledEngine.getState().status, "disabled");
  }

  {
    const engine = new AutoForwardEngine();
    engine.evaluate(snapshot([message("old", "user", "普通消息", 1000)], undefined), config);
    const legacyReply = snapshot(
      [
        message("old", "user", "普通消息", 1000),
        message("u10", "user", "回复ClaudeCode：旧日志兼容", 2000),
        message("a10", "codex", "旧日志稳定正文", 3000, { codexLegacyStable: true })
      ],
      undefined
    );
    assert.equal(engine.evaluate(legacyReply, config), undefined);
    const decision = engine.evaluate(legacyReply, config);
    assert.equal(decision && decision.messageId, "a10");
  }

  {
    const engine = new AutoForwardEngine();
    engine.evaluate(snapshot(undefined, [message("old", "user", "普通消息", 1000)]), config);
    const completed = snapshot(
      undefined,
      [
        message("old", "user", "普通消息", 1000),
        message("u11", "user", "给Codex命令：失败后不要重复发", 2000),
        message("a11", "claude", "失败重试保护正文", 3000, { stopReason: "end_turn" })
      ]
    );
    const decision = engine.evaluate(completed, config);
    assert.equal(decision && decision.mode, "forward-answer");
    engine.markFailed(decision, "桥接失败：前台窗口不是当前工作区。");
    assert.equal(engine.getState().status, "failed");
    assert.equal(engine.getState().error, "桥接失败：前台窗口不是当前工作区。");
    assert.equal(engine.evaluate(completed, config), undefined);
  }

  {
    const session = await parseCodexFixture([
      jsonlLine("session_meta", { id: "codex-session", cwd: workspaceCwd, originator: "codex_vscode" }),
      jsonlLine("event_msg", { type: "task_started", turn_id: "turn-1" }),
      jsonlLine("response_item", { type: "message", role: "user", content: [{ text: "回复ClaudeCode：检查" }] }),
      jsonlLine("response_item", { type: "message", role: "assistant", phase: "commentary", content: [{ text: "先说明" }] }),
      jsonlLine("response_item", { type: "message", role: "assistant", phase: "final_answer", content: [{ text: "最终答案" }] }),
      jsonlLine("event_msg", { type: "task_complete", turn_id: "turn-1", last_agent_message: "最终答案" })
    ]);
    const completed = session.messages.find((entry) => entry.role === "codex" && entry.text === "最终答案");
    const commentary = session.messages.find((entry) => entry.role === "codex" && entry.text === "先说明");
    assert.equal(completed.meta.codexComplete, true);
    assert.equal(commentary.meta.codexComplete, undefined);
  }

  {
    const session = await parseCodexFixture([
      jsonlLine("session_meta", { id: "codex-session", cwd: workspaceCwd, originator: "codex_vscode" }),
      jsonlLine("event_msg", { type: "task_started", turn_id: "turn-2" }),
      jsonlLine("response_item", { type: "message", role: "user", content: [{ text: "回复ClaudeCode：检查" }] }),
      jsonlLine("response_item", { type: "message", role: "assistant", phase: "final_answer", content: [{ text: "空 last fallback" }] }),
      jsonlLine("event_msg", { type: "task_complete", turn_id: "turn-2", last_agent_message: null })
    ]);
    const completed = session.messages.find((entry) => entry.role === "codex");
    assert.equal(completed.meta.codexComplete, true);
  }

  {
    const session = await parseCodexFixture([
      jsonlLine("session_meta", { id: "codex-session", cwd: workspaceCwd, originator: "codex_vscode" }),
      jsonlLine("event_msg", { type: "task_started", turn_id: "turn-3" }),
      jsonlLine("response_item", { type: "message", role: "user", content: [{ text: "回复ClaudeCode：长任务" }] }),
      jsonlLine("response_item", { type: "message", role: "assistant", phase: "final_answer", content: [{ text: "还没有 complete" }] })
    ]);
    const orphan = session.messages.find((entry) => entry.role === "codex");
    assert.equal(orphan.meta.codexComplete, undefined);
    assert.equal(orphan.meta.codexHasTurnEvents, true);
  }

  {
    const windows = [
      { pid: 1, processName: "Code", title: "main.ts - broker-chat-vscode - Visual Studio Code" },
      { pid: 2, processName: "Code", title: "notes - other-workspace - Visual Studio Code" }
    ];
    const selected = selectUniqueWorkspaceWindow(windows, workspaceCwd);
    assert.equal(selected.ok, true);
    assert.equal(selected.window.pid, 1);
    assert.equal(isForegroundWorkspaceWindow(windows, 1, workspaceCwd).ok, true);
    assert.equal(isForegroundWorkspaceWindow(windows, 2, workspaceCwd).ok, false);
  }

  {
    const windows = [
      { pid: 1, processName: "Code", title: "main.ts - broker-chat-vscode - Visual Studio Code" },
      { pid: 2, processName: "Code", title: "notes - other-workspace - Visual Studio Code" }
    ];
    const foreground = {
      pid: 42,
      processName: "Code",
      title: "broker-chat-vscode - Visual Studio Code"
    };
    assert.equal(isForegroundWorkspaceWindow(windows, foreground, workspaceCwd).ok, true);
  }

  {
    const windows = [
      { pid: 1, processName: "Code", title: "main.ts - broker-chat-vscode - Visual Studio Code" }
    ];
    const foreground = {
      pid: 99,
      processName: "ZCode",
      title: "ZCode"
    };
    const result = isForegroundWorkspaceWindow(windows, foreground, workspaceCwd);
    assert.equal(result.ok, false);
    assert.match(result.error, /VS Code/);
  }

  {
    const windows = [
      { pid: 1, processName: "Code", title: "main.ts - broker-chat-vscode - Visual Studio Code" },
      { pid: 99, processName: "WeChat", title: "微信" }
    ];
    const result = isForegroundWorkspaceWindow(windows, 99, workspaceCwd);
    assert.equal(result.ok, false);
    assert.match(result.error, /VS Code/);
  }

  {
    const ambiguous = [
      { pid: 1, processName: "Code", title: "one - broker-chat-vscode - Visual Studio Code" },
      { pid: 2, processName: "Code", title: "two - broker-chat-vscode - Visual Studio Code" }
    ];
    assert.equal(selectUniqueWorkspaceWindow(ambiguous, workspaceCwd).ok, false);
  }

  console.log("auto-forward tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
