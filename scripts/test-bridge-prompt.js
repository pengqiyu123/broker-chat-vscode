const assert = require("node:assert/strict");
const {
  buildBridgeAnswerPrompt,
  buildMonitoredBridgePrompt,
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

const explicitTarget = buildBridgeAnswerPrompt("claude", "codex", "请继续检查。", "");
assert.equal(explicitTarget.ok, true);
assert.equal(explicitTarget.target, "codex");
assert.equal(explicitTarget.prompt, "ClaudeCode说：\n请继续检查。");

const emptyAnswer = buildBridgeAnswerPrompt("claude", "codex", "   ", "");
assert.equal(emptyAnswer.ok, false);
assert.equal(emptyAnswer.target, "codex");
assert.equal(emptyAnswer.error, "回答正文不能为空。");

const merged = buildMonitoredBridgePrompt("codex", messages, 1, "merge-forward", "请审阅。");
assert.equal(merged.ok, true);
assert.equal(merged.target, "claude");
assert.equal(
  merged.prompt,
  "User question:\n请总结本轮改动。\n\nCodex answer:\n已完成 MCP v1 和文档调整。\n\nAdditional user note:\n请审阅。"
);

console.log("bridge prompt tests passed");
