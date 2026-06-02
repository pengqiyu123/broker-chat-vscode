const assert = require("node:assert/strict");
const { joinPowerShellLines } = require("../dist/automation/powerShellScripts");

const script = joinPowerShellLines([
  "$signature = @'",
  "using System;",
  "'@",
  "Add-Type -TypeDefinition $signature"
]);

assert.equal(script, "$signature = @'\nusing System;\n'@\nAdd-Type -TypeDefinition $signature");
assert.doesNotMatch(script, /@';/);
assert.doesNotMatch(script, /;'@/);

console.log("powershell script tests passed");
