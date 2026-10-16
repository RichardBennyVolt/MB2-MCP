// Raw JSON-RPC over stdio, the way non-SDK clients (Codex/rmcp, DeepSeek Harness, …) talk to the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function session(protocolVersion) {
  const child = spawn(process.execPath, [path.join(root, "dist", "index.js")], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MB2_READONLY: "1" } });
  let buf = "";
  const lines = [];
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      lines.push(line);
      const msg = JSON.parse(line); // every stdout line must be JSON-RPC
      const w = waiters.findIndex((x) => x.id === msg.id);
      if (w >= 0) waiters.splice(w, 1)[0].resolve(msg);
    }
  });
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      waiters.push({ id, resolve });
      send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30000).unref();
    });
  return { child, send, request, lines, protocolVersion };
}

for (const version of ["2024-11-05", "2025-03-26", "2025-06-18"]) {
  test(`handshake + tools with protocol ${version}`, async () => {
    const s = session(version);
    try {
      const t0 = Date.now();
      const init = await s.request(1, "initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "raw", version: "0" } });
      assert.ok(Date.now() - t0 < 5000, "server must answer initialize quickly (Codex default startup timeout is 10 s)");
      assert.equal(init.result.protocolVersion, version);
      assert.equal(init.result.serverInfo.name, "mb2-mcp");
      assert.ok(init.result.capabilities.tools);
      assert.ok(init.result.instructions.length < 32768, "DeepSeek Harness caps instructions at 32 KiB");
      s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const list = await s.request(2, "tools/list", {});
      assert.ok(list.result.tools.length >= 20);
      for (const t of list.result.tools) {
        assert.ok(/^[a-zA-Z0-9_-]{1,64}$/.test(t.name));
        assert.ok(`mcp__bannerlord__${t.name}`.length <= 64, "qualified tool names must fit OpenAI's 64-char limit");
      }
      const call = await s.request(3, "tools/call", { name: "list_modules", arguments: { filter: "official" } });
      assert.equal(call.result.isError, false);
      assert.equal(call.result.content[0].type, "text");
      const bad = await s.request(4, "tools/call", { name: "no_such_tool", arguments: {} });
      assert.equal(bad.result.isError, true);
      const ro = await s.request(5, "tools/call", { name: "create_module", arguments: { module_id: "ShouldNotExist" } });
      assert.equal(ro.result.isError, true);
      assert.match(ro.result.content[0].text, /read-only/i);
      const ping = await s.request(6, "ping", {});
      assert.ok(ping.result);
    } finally {
      s.child.stdin.end();
      s.child.kill();
    }
  });
}
