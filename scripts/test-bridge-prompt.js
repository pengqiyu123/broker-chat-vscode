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

// buildMonitoredBridgePrompt 现在接收显式 target（红蓝路由由 controller 决定）。
const answerOnly = buildMonitoredBridgePrompt("codex", "claude", messages, 1, "forward-answer", "");
assert.equal(answerOnly.ok, true);
assert.equal(answerOnly.target, "claude");
assert.equal(answerOnly.prompt, "Codex说：\n已完成 MCP v1 和文档调整。");

const explicitTarget = buildBridgeAnswerPrompt("claude", "codex", "请继续检查。", "");
assert.equal(explicitTarget.ok, true);
assert.equal(explicitTarget.target, "codex");
assert.equal(explicitTarget.prompt, "ClaudeCode说：\n请继续检查。");

// directionalPrefix 由调用方（controller 按红蓝槽）传入，函数透传。
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

const merged = buildMonitoredBridgePrompt("codex", "claude", messages, 1, "merge-forward", "请审阅。");
assert.equal(merged.ok, true);
assert.equal(merged.target, "claude");
assert.equal(
  merged.prompt,
  "User question:\n请总结本轮改动。\n\nCodex answer:\n已完成 MCP v1 和文档调整。\n\nAdditional user note:\n请审阅。"
);

const prefixedMerged = buildMonitoredBridgePrompt(
  "codex",
  "claude",
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

// getDirectionalRolePrefix 现在透传空（前缀选择由 controller 按红蓝槽完成）。
assert.equal(
  getDirectionalRolePrefix("claude", "codex", {
    red: "to red",
    blue: "to blue"
  }),
  ""
);

// normalizeDirectionalRolePrefixes：新格式 red/blue 优先，旧格式 claudeToCodex/codexToClaude 迁移。
assert.deepEqual(normalizeDirectionalRolePrefixes(undefined), {
  red: "",
  blue: ""
});
assert.deepEqual(normalizeDirectionalRolePrefixes({ red: "A", blue: 12 }), {
  red: "A",
  blue: ""
});
// 旧格式迁移：claudeToCodex（给 Codex 的身份锁 → blue），codexToClaude（给 Claude 的身份锁 → red）
assert.deepEqual(normalizeDirectionalRolePrefixes({ claudeToCodex: "A", codexToClaude: "B" }), {
  red: "B",
  blue: "A"
});
// 默认前缀：red 是给 Claude 的身份锁，blue 是给 Codex 的身份锁
assert.match(DEFAULT_DIRECTIONAL_ROLE_PREFIXES.red, /你是ClaudeCode/);
assert.match(DEFAULT_DIRECTIONAL_ROLE_PREFIXES.blue, /你是Codex/);

console.log("bridge prompt tests passed");
