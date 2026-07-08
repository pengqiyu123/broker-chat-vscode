const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const {
  fingerprintWorkspace,
  getBrokerRuntimeFilePath
} = require("../dist/mcp/brokerRuntime");
const {
  BrokerControlServer
} = require("../dist/mcp/BrokerControlServer");
const {
  createBrokerForwardTool,
  normalizeBrokerForwardArguments,
  parseSidecarArgs,
  callBrokerForward
} = require("../dist/mcp/brokerMcpServer");

function postJson(runtime, payload, token = runtime.token) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: runtime.port,
        path: "/agent-command",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body)
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
          });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "broker-mcp-test-"));
  const seen = [];
  const server = new BrokerControlServer(workspace, async (request) => {
    seen.push(request);
    return {
      ok: true,
      source: request.sourceAgent,
      target: request.target,
      requestId: request.requestId,
      message: "sent"
    };
  });

  const runtime = await server.start();
  assert.equal(runtime.workspaceFingerprint, fingerprintWorkspace(workspace));
  assert.equal(fs.existsSync(getBrokerRuntimeFilePath(workspace)), true);

  const unauthorized = await postJson(
    runtime,
    {
      workspaceFingerprint: runtime.workspaceFingerprint,
      sourceAgent: "zcode",
      target: "codex",
      content: "hello",
      requestId: "REQ-001"
    },
    "wrong"
  );
  assert.equal(unauthorized.statusCode, 401);

  const wrongWorkspace = await postJson(runtime, {
    workspaceFingerprint: "wrong",
    sourceAgent: "zcode",
    target: "codex",
    content: "hello",
    requestId: "REQ-002"
  });
  assert.equal(wrongWorkspace.statusCode, 400);

  const ok = await postJson(runtime, {
    workspaceFingerprint: runtime.workspaceFingerprint,
    sourceAgent: "zcode",
    target: "codex",
    content: "hello",
    requestId: "REQ-003"
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sourceAgent, "zcode");
  assert.equal(seen[0].target, "codex");

  assert.deepEqual(parseSidecarArgs(["--source", "zcode", "--workspace", workspace]), {
    source: "zcode",
    workspace
  });
  assert.throws(() => parseSidecarArgs(["--source", "bad", "--workspace", workspace]), /--source/);

  const tool = createBrokerForwardTool();
  assert.equal(tool.name, "broker_forward");
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.idempotentHint, true);

  const args = normalizeBrokerForwardArguments({
    target: "codex",
    content: "  hello codex  ",
    requestId: "REQ-004"
  });
  assert.deepEqual(args, {
    target: "codex",
    content: "hello codex",
    requestId: "REQ-004",
    mode: "message"
  });
  assert.throws(() => normalizeBrokerForwardArguments({ target: "zcode", content: "", requestId: "REQ-005" }), /content/);
  assert.throws(() => normalizeBrokerForwardArguments({ target: "zcode", content: "x", requestId: "!" }), /requestId/);

  const toolResult = await callBrokerForward(
    { source: "zcode", workspace },
    {
      target: "codex",
      content: "from mcp",
      requestId: "REQ-006",
      mode: "message"
    }
  );
  assert.equal(toolResult.isError, false);
  assert.match(toolResult.content[0].text, /BROKER_FORWARD_OK:REQ-006/);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].content, "from mcp");

  server.dispose();
  assert.equal(fs.existsSync(getBrokerRuntimeFilePath(workspace)), false);

  console.log("mcp bridge tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
