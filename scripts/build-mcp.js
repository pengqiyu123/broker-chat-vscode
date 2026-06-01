const esbuild = require("esbuild");
const path = require("path");

const projectRoot = path.join(__dirname, "..");

async function main() {
  await esbuild.build({
    entryPoints: [path.join(projectRoot, "src", "mcp", "broker-mcp-server.ts")],
    outfile: path.join(projectRoot, "dist", "mcp", "broker-mcp-server.js"),
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    banner: {
      js: "#!/usr/bin/env node"
    },
    logLevel: "info"
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
