const assert = require("node:assert/strict");
const {
  buildMonitoredBridgePrompt,
  findLatestModelMessage
} = require("../dist/controller/bridgePrompt");

const messages = [
  {
    id: "user-1",
    role: "user",
    text: "请总结本轮改动。",
    createdAt: 1000
  },
  {
    id: "codex-1",
    role: "codex",
    text: "已完成 MCP v1 和文档调整。",
    createdAt: 2000
  }
];

const answerOnly = buildMonitoredBridgePrompt("codex", messages, 1, "forward-answer", "");
assert.equal(answerOnly.ok, true);
assert.equal(answerOnly.target, "claude");
assert.equal(answerOnly.prompt, "Codex说：\n已完成 MCP v1 和文档调整。");

const merged = buildMonitoredBridgePrompt("codex", messages, 1, "merge-forward", "请审阅。");
assert.equal(merged.ok, true);
assert.equal(merged.target, "claude");
assert.equal(
  merged.prompt,
  "User question:\n请总结本轮改动。\n\nCodex answer:\n已完成 MCP v1 和文档调整。\n\nAdditional user note:\n请审阅。"
);

const latest = findLatestModelMessage(messages, "codex");
assert.equal(latest && latest.message.id, "codex-1");
assert.equal(latest && latest.messageIndex, 1);

console.log("bridge prompt tests passed");
