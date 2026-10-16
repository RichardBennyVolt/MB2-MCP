import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { Ctx } from "./context.js";
import { BRIDGE_VERSION } from "./scene/bridge-cs.js";
import { bridgeInstallState, editorExe, findCsc } from "./scene/bridge.js";
import { callTool, toolList } from "./server.js";
import { enabledTools } from "./tools/index.js";
import { VERSION } from "./version.js";

export function entryScript(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "index.js");
}

function tomlStr(s: string): string {
  return s.includes("'") ? JSON.stringify(s) : `'${s}'`;
}

function yamlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function quoteArg(s: string): string {
  return /[\s&()^|<>"]/.test(s) ? `"${s}"` : s;
}

/** Prints copy-paste configuration for each supported harness. */
export function printConfig(which: string, config: Config): string {
  const ctx = new Ctx(config);
  ctx.registry.refresh();
  const node = process.execPath;
  const script = entryScript();
  const game = config.gameDirOverride ?? ctx.registry.gameDir ?? "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Mount & Blade II Bannerlord";
  const env: Record<string, string> = { MB2_GAME_DIR: game };
  if (config.extraModuleDirs.length) env.MB2_MODULE_DIRS = config.extraModuleDirs.join(";");
  const name = "bannerlord";
  const parts: Record<string, string> = {};

  parts.claude = [
    "### Claude Code",
    "# Option A — CLI (user scope = available in every project):",
    `claude mcp add ${name} --scope user ${Object.entries(env)
      .map(([k, v]) => `-e ${k}=${quoteArg(v)}`)
      .join(" ")} -- ${quoteArg(node)} ${quoteArg(script)}`,
    "# Option B — .mcp.json in your mod project (project scope):",
    JSON.stringify({ mcpServers: { [name]: { type: "stdio", command: node, args: [script], env } } }, null, 2),
  ].join("\n");

  parts.codex = [
    "### Codex CLI / IDE — add to ~/.codex/config.toml",
    `[mcp_servers.${name}]`,
    `command = ${tomlStr(node)}`,
    `args = [${tomlStr(script)}]`,
    "startup_timeout_sec = 30",
    "tool_timeout_sec = 300",
    "# read-only tools are annotated (readOnlyHint), so only edits ask for approval:",
    'default_tools_approval_mode = "writes"',
    "",
    `[mcp_servers.${name}.env]`,
    ...Object.entries(env).map(([k, v]) => `${k} = ${tomlStr(v)}`),
    "",
    "# or: codex mcp add " + name + " " + Object.entries(env).map(([k, v]) => `--env ${k}=${quoteArg(v)}`).join(" ") + ` -- ${quoteArg(node)} ${quoteArg(script)}`,
  ].join("\n");

  parts.dsh = [
    "### DeepSeek Harness (dsh) — merge into ~/.dsh/cordis.patch.yml (all profiles) or ~/.dsh/profiles/<profile>/cordis.patch.yml",
    "- insert:",
    `    - id: mcp-${name}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    `        serverName: ${name}`,
    "        transport: stdio",
    `        command: ${yamlStr(node)}`,
    `        args: [${yamlStr(script)}]`,
    "        env:",
    ...Object.entries(env).map(([k, v]) => `          ${k}: ${yamlStr(v)}`),
    "        toolCallTimeoutMs: 300000",
  ].join("\n");

  parts.json = [
    "### Generic MCP client (Cursor, Cline, Windsurf, Cherry Studio, …) — mcpServers JSON",
    JSON.stringify({ mcpServers: { [name]: { command: node, args: [script], env } } }, null, 2),
  ].join("\n");

  const keys = which === "all" ? ["claude", "codex", "dsh", "json"] : [which === "deepseek" ? "dsh" : which];
  const out: string[] = [];
  for (const k of keys) {
    if (!parts[k]) throw new Error(`Unknown client '${which}'. Use: claude | codex | dsh | json | all`);
    out.push(parts[k], "");
  }
  return out.join("\n");
}

export async function runDoctor(config: Config): Promise<string> {
  const L: string[] = [`mb2-mcp ${VERSION} doctor — node ${process.version} on ${process.platform}`];
  const ctx = new Ctx(config);
  let t = Date.now();
  ctx.registry.refresh();
  const loc = ctx.registry.location;
  L.push(loc.gameDir ? `✔ game: ${loc.gameDir} (${ctx.registry.gameVersion()}, via ${loc.detectedBy}, ${Date.now() - t} ms)` : `✘ game not found: ${loc.detectedBy}. Set MB2_GAME_DIR.`);
  if (loc.workshopDir) L.push(`✔ workshop: ${loc.workshopDir}`);
  const mods = ctx.registry.modules;
  L.push(`✔ modules: ${mods.length} (${mods.filter((m) => m.writable).length} writable)`);
  t = Date.now();
  ctx.indexAll();
  const st = ctx.index.stats();
  L.push(`✔ index: ${st.files} files, ${st.objects} objects in ${Date.now() - t} ms`);
  const xsd = ctx.schemas.ids();
  L.push(xsd.length ? `✔ XmlSchemas: ${xsd.length} XSD files` : "✘ XmlSchemas folder not found");
  if (ctx.dotnet.available()) {
    t = Date.now();
    try {
      const native = ctx.registry.get("SandBoxCore");
      const file = native ? path.join(native.dir, "ModuleData", "spcultures.xml") : null;
      const schemaFile = ctx.schemas.pathFor("SPCultures");
      if (file && schemaFile) {
        const [r] = await ctx.dotnet.run([{ op: "xsd", xml: file, xsd: schemaFile }]);
        L.push(r.ok ? `✔ .NET bridge (PowerShell): XSD validation works (${Date.now() - t} ms)` : `✘ .NET bridge error: ${r.error}`);
      } else L.push("✔ .NET bridge available (no sample file to test)");
    } catch (e) {
      L.push(`✘ .NET bridge failed: ${(e as Error).message}`);
    }
  } else L.push(`✘ .NET bridge: ${ctx.dotnet.unavailableReason()}`);
  t = Date.now();
  ctx.prefabs.ensure(mods);
  L.push(`✔ prefabs: ${ctx.prefabs.count()} in ${Date.now() - t} ms`);
  t = Date.now();
  ctx.assets.ensure(mods);
  const kinds = ctx.assets.counts();
  L.push(`✔ asset packages: ${ctx.assets.packages().length} (${[...kinds].map(([k, n]) => `${k} ${n}`).join(", ")}) in ${Date.now() - t} ms`);
  if (loc.gameDir) {
    const exe = editorExe(loc.gameDir);
    L.push(exe ? `✔ Modding Kit: ${exe}` : "✘ Modding Kit not installed (scene editor live tools need it; file-based scene tools still work)");
    const bst = bridgeInstallState(loc.gameDir);
    L.push(bst.installed ? `✔ editor bridge v${bst.version} installed${bst.version !== BRIDGE_VERSION ? ` (✘ current is ${BRIDGE_VERSION}: run editor_bridge_install)` : ""}` : `• editor bridge not installed (run the editor_bridge_install tool; csc: ${findCsc() ? "found" : "missing"})`);
  }
  const tools = enabledTools(config.toolsets);
  const bad = toolList(tools).filter((x) => JSON.stringify(x.inputSchema).match(/anyOf|oneOf|allOf|\$ref/));
  L.push(`✔ ${tools.length} tools${config.toolsets.length ? ` (MB2_TOOLSETS=${config.toolsets.join(",")})` : ""}${bad.length ? ` (✘ complex schemas: ${bad.map((b) => b.name).join(", ")})` : ""}`);
  const r = await callTool(ctx, "search_objects", { query: "empire_sword", type: "Item", limit: 3 });
  L.push(r.isError ? `✘ sample search failed: ${r.text}` : `✔ sample search:\n${r.text.split("\n").slice(0, 4).map((x) => `    ${x}`).join("\n")}`);
  L.push(`data dir (history/backups): ${config.dataDir}`);
  L.push("", "Next: node " + quoteArg(entryScript()) + " config   (prints config for Claude Code, Codex, DeepSeek Harness)");
  return L.join("\n");
}
