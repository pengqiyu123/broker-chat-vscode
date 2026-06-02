const assert = require("node:assert/strict");
const {
  AutoForwardEngine,
  DEFAULT_AUTO_FORWARD_KEYWORDS
} = require("../dist/automation/AutoForwardEngine");

const config = {
  enabled: true,
  keywords: DEFAULT_AUTO_FORWARD_KEYWORDS
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

function session(agent, messages) {
  return {
    agent,
    sessionId: `${agent}-session`,
    title: `${agent} session`,
    cwd: "D:\\python\\broker-chat-vscode",
    sourcePath: `${agent}.jsonl`,
    updatedAt: messages.at(-1)?.createdAt || 1,
    messageCount: messages.length,
    messages
  };
}

function snapshot(codexMessages, claudeMessages) {
  return {
    enabled: true,
    lastUpdated: Date.now(),
    codex: codexMessages ? session("codex", codexMessages) : undefined,
    claude: claudeMessages ? session("claude", claudeMessages) : undefined
  };
}

{
  const engine = new AutoForwardEngine({ stablePollsRequired: 3 });
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
  const engine = new AutoForwardEngine({ stablePollsRequired: 3 });
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
  const engine = new AutoForwardEngine({ stablePollsRequired: 3 });
  engine.evaluate(snapshot([message("old", "user", "普通消息", 1000)], undefined), config);

  const withUser = snapshot(
    [
      message("old", "user", "普通消息", 1000),
      message("u3", "user", "回复ClaudeCode：请审阅", 2000)
    ],
    undefined
  );
  assert.equal(engine.evaluate(withUser, config), undefined);

  const withReply = snapshot(
    [
      message("old", "user", "普通消息", 1000),
      message("u3", "user", "回复ClaudeCode：请审阅", 2000),
      message("a3", "codex", "Codex 稳定后的正文", 3000)
    ],
    undefined
  );
  assert.equal(engine.evaluate(withReply, config), undefined);
  assert.equal(engine.evaluate(withReply, config), undefined);
  const decision = engine.evaluate(withReply, config);
  assert.equal(decision && decision.sourceAgent, "codex");
  assert.equal(decision && decision.targetAgent, "claude");
  assert.equal(decision && decision.messageId, "a3");
}

{
  const engine = new AutoForwardEngine({ stablePollsRequired: 1 });
  engine.evaluate(snapshot([message("old", "user", "普通消息", 1000)], undefined), config);
  const disabledDecision = engine.evaluate(
    snapshot(
      [
        message("old", "user", "普通消息", 1000),
        message("u4", "user", "给Codex命令：禁用时不应触发", 2000),
        message("a4", "codex", "禁用回复", 3000)
      ],
      undefined
    ),
    {
      ...config,
      enabled: false
    }
  );
  assert.equal(disabledDecision, undefined);
  assert.equal(engine.getState().status, "disabled");
}

{
  const engine = new AutoForwardEngine({ stablePollsRequired: 1 });
  engine.evaluate(snapshot([message("old", "user", "普通消息", 1000)], undefined), config);
  const sameSide = snapshot(
    [
      message("old", "user", "普通消息", 1000),
      message("u5", "user", "给Codex命令：目标按关键词，而不是另一边", 2000),
      message("a5", "codex", "同侧目标正文", 3000)
    ],
    undefined
  );
  const decision = engine.evaluate(sameSide, config);
  assert.equal(decision && decision.sourceAgent, "codex");
  assert.equal(decision && decision.targetAgent, "codex");
}

console.log("auto-forward tests passed");
