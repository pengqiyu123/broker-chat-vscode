const assert = require("node:assert/strict");
const { joinPowerShellLines } = require("../dist/automation/powerShellScripts");
const { identifyFocusProbe } = require("../dist/automation/FocusDetector");

const script = joinPowerShellLines([
  "$signature = @'",
  "using System;",
  "'@",
  "Add-Type -TypeDefinition $signature"
]);

assert.equal(script, "$signature = @'\nusing System;\n'@\nAdd-Type -TypeDefinition $signature");
assert.doesNotMatch(script, /@';/);
assert.doesNotMatch(script, /;'@/);

function element(overrides) {
  return {
    name: "",
    className: "",
    automationId: "",
    controlType: "ControlType.Group",
    frameworkId: "Chrome",
    processId: 76128,
    ...overrides
  };
}

function identify(currentElement, parentChain = [currentElement]) {
  return identifyFocusProbe({
    currentElement,
    parentChain,
    timestamp: 0
  }).identifiedAgent;
}

assert.equal(
  identify(
    element({ className: "ProseMirror ProseMirror-focused" }),
    [
      element({ className: "ProseMirror ProseMirror-focused" }),
      element({ name: "Codex", automationId: "RootWebArea", controlType: "ControlType.Document" })
    ]
  ),
  "codex"
);

assert.equal(
  identify(
    element({
      name: "Message input",
      className: "messageInput_cKsPxg",
      controlType: "ControlType.Edit"
    })
  ),
  "claude"
);

assert.equal(
  identify(
    element({ className: "ProseMirror ProseMirror-focused" }),
    [
      element({ className: "ProseMirror ProseMirror-focused" }),
      element({ name: "ClaudeCode 状态检测器", automationId: "mainThreadWebview-claudeStatusDetector" })
    ]
  ),
  "detector"
);

assert.equal(
  identify(
    element({
      name: "Message input",
      className: "messageInput_cKsPxg",
      controlType: "ControlType.Edit"
    }),
    [
      element({
        name: "Message input",
        className: "messageInput_cKsPxg",
        controlType: "ControlType.Edit"
      }),
      element({ name: "发送给 Codex: 测试对话标题", automationId: "active-frame" })
    ]
  ),
  "claude"
);

assert.equal(
  identify(
    element({ name: "Editor", className: "monaco-editor", controlType: "ControlType.Document" })
  ),
  "unknown"
);

console.log("powershell and focus detector tests passed");
