// Manual end-to-end test of the live editor bridge. Launches the real Modding Kit editor!
//   node test/live.manual.mjs [--keep-bridge]
// Requires the Modding Kit. Installs Modules/MB2MCP.EditorBridge, starts the editor, drives it, quits it,
// then reverts the install (unless --keep-bridge) and deletes the screenshots it took.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = fs.mkdtempSync(path.join(os.tmpdir(), "mb2mcp-live-"));
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "index.js")], env: { ...process.env, MB2_DATA_DIR: data }, stderr: "inherit" });
const client = new Client({ name: "live", version: "1.0.0" });
await client.connect(transport);
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`;

async function call(name, args = {}, quiet = false) {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  const text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const images = res.content.filter((c) => c.type === "image");
  if (!quiet) console.log(`\n[${stamp()}] ===== ${name} ${JSON.stringify(args)}${res.isError ? " (ERROR)" : ""}\n${text}${images.length ? `\n<${images.length} image(s): ${images.map((i) => `${i.mimeType} ${Math.round(i.data.length * 0.75 / 1024)} KB`).join(", ")}>` : ""}`);
  return { text, isError: !!res.isError, images };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
let installSeq = null;
const screenshots = [];
try {
  const install = await call("editor_bridge_install", { force: true });
  installSeq = /edit #(\d+)/.exec(install.text)?.[1] ?? null;
  await call("editor_launch", {});
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    await sleep(5000);
    const st = await call("editor_status", {}, true);
    const lines = st.text.split("\n").filter((l) => /^(Editor:|Bridge connection|Startup warnings|Open game message boxes|- ')/.test(l));
    console.log(`[${stamp()}] ${lines.join(" | ")}`);
    ready = /edit mode ON/.test(st.text);
  }
  if (!ready) throw new Error("editor did not become ready");
  await sleep(3000);
  await call("scene_info", { live: true });
  const prefab = "arrow_barrel";
  await call("scene_edit", { live: true, action: "add", prefab, name: "mcp_barrel", position: [2, 2, 5], rotation: [0, 0, 30], count: 3, offset: [3, 0, 0], snap_to_ground: true, add_tags: ["mcp_live"] });
  await call("scene_edit", { live: true, action: "add", mesh: "editor_plane_low", name: "mcp_plane", position: [0, 10, 0.5], scale: 2 });
  const list = await call("scene_entities", { live: true, name: "mcp_" });
  const handles = [...list.text.matchAll(/#(\d+) mcp_barrel/g)].map((m) => Number(m[1]));
  await call("scene_edit", { live: true, action: "update", entities: [handles[0]], move_by: [0, 0, 1], rotate_by: [0, 0, 45], add_tags: ["moved"] });
  await call("scene_edit", { live: true, action: "duplicate", entities: ["mcp_plane"], count: 2, offset: [0, 5, 0] });
  await call("scene_edit", { live: true, action: "select", entities: handles });
  await call("scene_entities", { live: true, selected: true });
  await call("scene_edit", { live: true, action: "focus", entities: [handles[1]] });
  await call("editor_command", { action: "raycast", position: [2, 2, 50] });
  await call("editor_command", { action: "warning", message: "Hello from MB2-MCP" });
  const cmds = await call("editor_command", { action: "list_commands", prefix: "" }, true);
  const top = cmds.text.split("\n").slice(1);
  console.log(`[${stamp()}] list_commands: ${top.length} entries: ${top.join(" ")}`);
  for (const group of top.filter((c) => c.endsWith(".")).slice(0, 30)) {
    const sub = await call("editor_command", { action: "list_commands", prefix: group }, true);
    console.log(`[${stamp()}] ${group}* → ${sub.text.split("\n").slice(1).join(" ")}`);
  }
  const shot = await call("editor_command", { action: "screenshot" });
  if (shot.images.length) fs.writeFileSync(path.join(data, "editor.png"), Buffer.from(shot.images[0].data, "base64"));
  const engineShot = await call("editor_command", { action: "screenshot", source: "engine" });
  if (engineShot.images.length) fs.writeFileSync(path.join(data, "engine.png"), Buffer.from(engineShot.images[0].data, "base64"));
  for (const t of [shot.text, engineShot.text]) screenshots.push(...[...t.matchAll(/: (\S.*screenshot_\d+\.png)$/gm)].map((m) => m[1]));
  const del = await call("scene_edit", { live: true, action: "delete", entities: ["@selected"] });
  if (!/Deleted 3 /.test(del.text)) console.log("!! expected the 3 selected barrels to be deleted (focus must not change the selection)");
  await call("scene_entities", { live: true, name: "mcp_" });
  await call("scene_info", { live: true });
} catch (e) {
  ok = false;
  console.error("LIVE TEST FAILED:", e);
} finally {
  try {
    await call("editor_command", { action: "quit", confirm: true });
  } catch (e) {
    console.error("quit failed", e);
  }
  let exited = false;
  for (let i = 0; i < 30 && !exited; i++) {
    await sleep(2000);
    const st = await call("editor_status", {}, true);
    exited = /Running: no Bannerlord process/.test(st.text);
    if (exited) console.log(`[${stamp()}] game exited`);
  }
  for (const p of screenshots) fs.rmSync(p, { force: true });
  if (installSeq && exited && !process.argv.includes("--keep-bridge")) await call("undo_edit", { seq: Number(installSeq) });
  else if (installSeq) console.log(`Bridge left installed (undo later with: MB2_DATA_DIR=${data} → undo_edit seq=${installSeq}).`);
  await client.close();
  console.log(ok ? "LIVE TEST PASSED" : "LIVE TEST FAILED", "data:", data);
}
