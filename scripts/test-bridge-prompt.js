const assert = require("node:assert/strict");
const Module = require("node:module");
const {
  buildBridgeAnswerPrompt,
  buildMonitoredBridgePrompt,
  getDirectionalRolePrefix,
} = require("../dist/controller/bridgePrompt");
const { DEFAULT_DIRECTIONAL_ROLE_PREFIXES } = require("../dist/types");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { normalizeDirectionalRolePrefixes } = require("../dist/controller/brokerController");
Module._load = originalLoad;

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

const prefixedClaudeToCodex = buildBridgeAnswerPrompt(
  "claude",
  "codex",
  "请继续检查。",
  "",
  "身份锁定：你是 Codex。"
);
assert.equal(prefixedClaudeToCodex.ok, true);
assert.equal(prefixedClaudeToCodex.prompt, "身份锁定：你是 Codex。\n\nClaudeCode说：\n请继续检查。");

const whitespacePrefix = buildBridgeAnswerPrompt("claude", "codex", "请继续检查。", "", "   ");
assert.equal(whitespacePrefix.ok, true);
assert.equal(whitespacePrefix.prompt, "ClaudeCode说：\n请继续检查。");

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

const prefixedMerged = buildMonitoredBridgePrompt(
  "codex",
  messages,
  1,
  "merge-forward",
  "请审阅。",
  "身份：你是 ClaudeCode。"
);
assert.equal(prefixedMerged.ok, true);
assert.equal(
  prefixedMerged.prompt,
  "身份：你是 ClaudeCode。\n\nUser question:\n请总结本轮改动。\n\nCodex answer:\n已完成 MCP v1 和文档调整。\n\nAdditional user note:\n请审阅。"
);

assert.equal(
  getDirectionalRolePrefix("claude", "codex", {
    claudeToCodex: "to codex",
    codexToClaude: "to claude"
  }),
  "to codex"
);
assert.equal(
  getDirectionalRolePrefix("codex", "claude", {
    claudeToCodex: "to codex",
    codexToClaude: "to claude"
  }),
  "to claude"
);

assert.deepEqual(normalizeDirectionalRolePrefixes(undefined), {
  claudeToCodex: "",
  codexToClaude: ""
});
assert.deepEqual(normalizeDirectionalRolePrefixes({ claudeToCodex: "A", codexToClaude: 12 }), {
  claudeToCodex: "A",
  codexToClaude: ""
});
assert.match(DEFAULT_DIRECTIONAL_ROLE_PREFIXES.claudeToCodex, /你是Codex/);
assert.match(DEFAULT_DIRECTIONAL_ROLE_PREFIXES.codexToClaude, /你是ClaudeCode/);

console.log("bridge prompt tests passed");
