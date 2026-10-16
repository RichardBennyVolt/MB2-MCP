// Generates docs/TOOLS.md from the tool definitions in dist/ (run `npm run build` first).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { ALL_TOOLS, TOOL_GROUPS } = await import(pathToFileURL(path.join(root, "dist", "tools", "index.js")).href);
const { VERSION } = await import(pathToFileURL(path.join(root, "dist", "version.js")).href);

const GROUP_TITLES = {
  core: "Browse & validate",
  edit: "Edit game data",
  l10n: "Localization",
  scene: "Scenes & prefabs",
  assets: "Assets",
  editor: "Modding Kit editor (live)",
  logs: "Logs & history",
};

function typeOf(s) {
  if (s.enum) return s.enum.map((v) => `\`${v}\``).join(" | "); // esc() escapes the pipes for the table
  if (s.type === "array") return `${s.items?.type === "object" ? "object" : (s.items?.type ?? "any")}[]`;
  return s.type ?? "any";
}

const esc = (t) => String(t).replace(/\|/g, "\\|").replace(/\n/g, " ");
const lines = [
  "# Tool reference",
  "",
  `Generated from the tool definitions of mb2-mcp ${VERSION} (\`npm run docs\`). ${ALL_TOOLS.length} tools in ${TOOL_GROUPS.length} groups; \`MB2_TOOLSETS\` selects groups.`,
  "",
];
for (const g of TOOL_GROUPS) {
  const tools = ALL_TOOLS.filter((t) => t.group === g);
  if (!tools.length) continue;
  lines.push(`## ${GROUP_TITLES[g] ?? g} (\`${g}\`)`, "");
  for (const t of tools) {
    lines.push(`### \`${t.name}\`${t.readOnly ? " · read-only" : ""}`, "", t.description, "");
    const props = Object.entries(t.inputSchema.properties ?? {});
    if (props.length) {
      const req = new Set(t.inputSchema.required ?? []);
      lines.push("| Parameter | Type | Description |", "|---|---|---|");
      for (const [name, s] of props) lines.push(`| \`${name}\`${req.has(name) ? " **(required)**" : ""} | ${esc(typeOf(s))} | ${esc(s.description ?? "")} |`);
      lines.push("");
    } else lines.push("_No parameters._", "");
  }
}
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "TOOLS.md"), lines.join("\n"));
console.log(`docs/TOOLS.md: ${ALL_TOOLS.length} tools`);
