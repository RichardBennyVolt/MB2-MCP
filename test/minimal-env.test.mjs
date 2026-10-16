// Codex and DeepSeek Harness start MCP servers with a filtered environment.
// Make sure detection, logs and the .NET bridge still work with only a handful of variables.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("works with a minimal environment (Codex-style env filtering)", { skip: process.platform !== "win32" }, async () => {
  const env = {};
  for (const k of ["PATH", "Path", "PATHEXT", "USERPROFILE", "USERNAME", "HOMEDRIVE", "HOMEPATH"]) if (process.env[k]) env[k] = process.env[k];
  env.MB2_READONLY = "1";
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "index.js")], env, stderr: "inherit" });
  const client = new Client({ name: "minimal-env", version: "1.0.0" });
  await client.connect(transport);
  try {
    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError };
    };
    const info = await call("game_info");
    assert.equal(info.isError, false, info.text);
    assert.match(info.text, /Game: .*Bannerlord/);
    assert.match(info.text, /\.NET \(XSD validation \+ XSLT preview\): available/);
    const pv = await call("xslt_preview", { module: "NavalDLC", xml_id: "SPCultures" });
    assert.equal(pv.isError, false, pv.text);
    assert.match(pv.text, /### Culture 'nord'/);
    const logs = await call("read_logs", { action: "list" });
    assert.equal(logs.isError, false, logs.text);
  } finally {
    await client.close();
  }
});
