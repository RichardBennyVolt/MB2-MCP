// End-to-end test: talks to the real server over stdio with the official MCP client SDK.
// Needs a local Bannerlord install (auto-detected or MB2_GAME_DIR). Writes only into a temp folder.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb2mcp-e2e-"));
const modsDir = path.join(tmp, "mods");
fs.mkdirSync(modsDir);
const verbose = process.env.E2E_VERBOSE === "1";
let client;

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.map((c) => c.text ?? "").join("\n");
  if (verbose) console.log(`\n===== ${name} ${JSON.stringify(args).slice(0, 200)}\n${text}`);
  return { text, isError: !!res.isError };
}

async function ok(name, args) {
  const r = await call(name, args);
  assert.equal(r.isError, false, `${name} failed: ${r.text}`);
  return r.text;
}

before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "index.js")],
    env: { ...process.env, MB2_MODULE_DIRS: modsDir, MB2_DATA_DIR: path.join(tmp, "data") },
    stderr: "inherit",
  });
  client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  if (!process.env.E2E_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  else console.log("kept", tmp);
});

test("tool list has simple, portable schemas", async () => {
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 20);
  for (const t of tools) {
    assert.match(t.name, /^[a-z0-9_]{1,40}$/);
    assert.equal(t.inputSchema.type, "object");
    const s = JSON.stringify(t.inputSchema);
    assert.ok(!/anyOf|oneOf|allOf|\$ref|\$defs/.test(s), `${t.name} uses complex schema`);
    assert.ok(t.description.length > 30);
  }
  const inst = client.getInstructions();
  assert.ok(inst && inst.includes("SubModule.xml"));
});

test("browse vanilla data", async () => {
  const info = await ok("game_info");
  assert.match(info, /Game: .*Bannerlord/);
  const mods = await ok("list_modules", { filter: "official" });
  assert.match(mods, /Native/);
  const mi = await ok("module_info", { module: "SandBoxCore" });
  assert.match(mi, /Items → items \(dir\)/);
  const types = await ok("list_types", { module: "official" });
  assert.match(types, /NPCCharacters/);
  const s = await ok("search_objects", { query: "empire_sword_1", type: "Item", limit: 5 });
  assert.match(s, /CraftedItem\.empire_sword_1_t2/);
  const w = await ok("search_objects", { type: "NPCCharacter", where: ["culture=Culture.vlandia", "level>=26", "is_hero!=true"], limit: 5 });
  assert.match(w, /match/);
  const cn = await ok("search_objects", { query: "剑", type: "Item", limit: 3 });
  assert.match(cn, /〔/);
  const g = await ok("get_object", { ref: "Item.empire_sword_1_t2", lang: "CNs" });
  assert.match(g, /<CraftedItem/);
  assert.match(g, /\[effective\]/);
  const refs = await ok("find_references", { ref: "Culture.empire", limit: 3 });
  assert.match(refs, /object\(s\) reference/);
  const sch = await ok("describe_schema", { element: "Item" });
  assert.match(sch, /attributes \(/);
  assert.match(sch, /observed in official/);
  const sch2 = await ok("describe_schema", { element: "Weapon", path: "Item/ItemComponent/Weapon" });
  assert.match(sch2, /weapon_class/);
  const list = await ok("describe_schema", {});
  assert.match(list, /NPCCharacters/);
});

test("create module and edit data", async () => {
  const created = await ok("create_module", { module_id: "E2ETestMod", name: "E2E Test Mod", location: modsDir, with_csharp: true });
  assert.match(created, /Created module E2ETestMod/);
  const dir = path.join(modsDir, "E2ETestMod");
  assert.ok(fs.existsSync(path.join(dir, "SubModule.xml")));
  assert.ok(fs.existsSync(path.join(dir, "Source", "E2ETestMod.csproj")));

  const cloned = await ok("clone_object", { source: "Item.empire_sword_1_t2", module: "E2ETestMod", new_id: "e2e_sword", set: { name: "E2E Sword" } });
  assert.match(cloned, /inserted CraftedItem 'e2e_sword'/);
  assert.match(cloned, /registered <XmlName id="Items"/);
  assert.match(cloned, /XSD check: OK/);

  const troopXml = `<NPCCharacter id="e2e_troop" default_group="Infantry" level="16" name="E2E Swordsman" occupation="Soldier" culture="Culture.empire" skill_template="SkillSet.infantry_heavyinfantry_level6_template_skills">
  <face>
    <face_key_template value="BodyProperty.fighter_empire" />
  </face>
  <skills>
    <skill id="OneHanded" value="80" />
    <skill id="Athletics" value="60" />
  </skills>
  <Equipments>
    <EquipmentRoster>
      <equipment slot="Item0" id="Item.e2e_sword" />
      <equipment slot="Item1" id="Item.does_not_exist_xyz" />
    </EquipmentRoster>
  </Equipments>
</NPCCharacter>`;
  const w = await ok("write_object", { module: "E2ETestMod", xml: troopXml });
  assert.match(w, /inserted NPCCharacter 'e2e_troop'/);
  assert.match(w, /unresolved references: Item\.does_not_exist_xyz/);
  assert.match(w, /no \{=id\} localization prefix/);

  const bad = await call("write_object", { module: "E2ETestMod", xml: `<Item id="x" name="Salt & Pepper"/>` });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Unescaped '&'/);

  const sa = await ok("set_attributes", { module: "E2ETestMod", ref: "NPCCharacter.e2e_troop", path: "skills/skill[@id='OneHanded']", set: { value: "95" } });
  assert.match(sa, /value="95"/);
  const sa2 = await ok("set_attributes", { module: "E2ETestMod", ref: "NPCCharacter.e2e_troop", set: { level: "21" }, remove: ["skill_template"] });
  assert.match(sa2, /level="21"/);
  assert.ok(!/skill_template/.test(sa2.split("\n\n")[1] ?? ""), "skill_template removed");

  const refs = await ok("find_references", { ref: "Item.e2e_sword" });
  assert.match(refs, /NPCCharacter\.e2e_troop/);

  const notMine = await call("set_attributes", { module: "E2ETestMod", ref: "Item.empire_sword_1_t2", set: { value: "1" } });
  assert.equal(notMine.isError, true);
  assert.match(notMine.text, /xslt_patch/);

  const vanilla = await call("write_object", { module: "Native", xml: `<Item id="x"/>` });
  assert.equal(vanilla.isError, true);
  assert.match(vanilla.text, /official/);
});

test("xslt patches with game-identical preview", async () => {
  const p1 = await ok("xslt_patch", { module: "E2ETestMod", target: "Item.torch", set: { weight: "0.5", value: "7" } });
  assert.match(p1, /created ModuleData\/XSLT\/e2etestmod_Items\.xslt/);
  assert.match(p1, /-.*weight="0\.2"|weight="0\.5"/);
  assert.match(p1, /\+.*weight="0\.5"/);
  const p2 = await ok("xslt_patch", { module: "E2ETestMod", target: "NPCCharacter.imperial_recruit", path: "skills/skill[@id='OneHanded']", set: { value: "77" } });
  assert.match(p2, /\+.*value="77"/);
  const p3 = await ok("xslt_patch", { module: "E2ETestMod", target: "Culture.empire", set: { name: "{=e2e_emp}Empire Reborn" } });
  assert.match(p3, /\+.*Empire Reborn/);
  const p4 = await ok("xslt_patch", { module: "E2ETestMod", target: "Item.torch", remove_attributes: ["prefab"] });
  assert.match(p4, /updated rule/);
  const xslt = fs.readFileSync(path.join(modsDir, "E2ETestMod", "ModuleData", "XSLT", "e2etestmod_Items.xslt"), "utf8");
  assert.match(xslt, /name\(\)='prefab'/);
  assert.match(xslt, /<xsl:attribute name="weight">0\.5<\/xsl:attribute>/);
  assert.match(p1, /XSD check of the patched object: OK/);
  const p5 = await ok("xslt_patch", { module: "E2ETestMod", target: "Item.torch", append_xml: `<Flags Civilian="true" />` });
  assert.match(p5, /\+\s*<Flags Civilian="true"/);
  // Items.xsd allows a single <Flags>: the preview must flag the second one.
  assert.match(p5, /XSD problems in the patched result/);
  const pv = await ok("xslt_preview", { module: "E2ETestMod" });
  assert.match(pv, /### Item 'torch'/);
  assert.match(pv, /### Culture 'empire'/);
  const sub = fs.readFileSync(path.join(modsDir, "E2ETestMod", "SubModule.xml"), "utf8");
  assert.match(sub, /path="XSLT\/e2etestmod_Items"/);
  assert.match(sub, /path="XSLT\/e2etestmod_SPCultures"/);
});

test("validate, localization, history", async () => {
  const v = await ok("validate_module", { module: "E2ETestMod" });
  assert.match(v, /error\(s\)/);
  assert.match(v, /Item\.does_not_exist_xyz/);
  assert.match(v, /DLL E2ETestMod\.dll not found/);

  const scan = await ok("l10n_scan", { module: "E2ETestMod" });
  assert.match(scan, /Missing ids/);
  const fixed = await ok("l10n_scan", { module: "E2ETestMod", fix_missing_ids: true });
  assert.match(fixed, /id\(s\) added/);
  const status = await ok("l10n_status", { module: "E2ETestMod", language: "zh" });
  assert.match(status, /简体中文/);
  const lines = status.split("\n").filter((l) => l.startsWith("{"));
  assert.ok(lines.length >= 2, "expects untranslated entries");
  const tr = {};
  for (const l of lines) {
    const e = JSON.parse(l);
    tr[e.id] = `【译】${e.text}`;
  }
  const set = await ok("l10n_set", { module: "E2ETestMod", language: "CNs", translations: tr });
  assert.match(set, /added/);
  const ld = path.join(modsDir, "E2ETestMod", "ModuleData", "Languages", "CNs", "language_data.xml");
  assert.ok(fs.existsSync(ld));
  assert.match(fs.readFileSync(ld, "utf8"), /id="简体中文"/);
  const status2 = await ok("l10n_status", { module: "E2ETestMod", language: "简体中文" });
  assert.match(status2, /0 untranslated/);

  const hist = await ok("edit_history", { limit: 50 });
  assert.match(hist, /create_module/);
  const del = await ok("delete_object", { module: "E2ETestMod", ref: "NPCCharacter.e2e_troop" });
  assert.match(del, /deleted NPCCharacter 'e2e_troop'/);
  const undo = await ok("undo_edit", {});
  assert.match(undo, /Undid #\d+ delete_object/);
  const back = await ok("get_object", { ref: "NPCCharacter.e2e_troop" });
  assert.match(back, /<NPCCharacter/);

  const es = await ok("edit_submodule", { module: "E2ETestMod", version: "v1.0.1", add_dependencies: ["Bannerlord.Harmony?"] });
  assert.match(es, /Version = v1\.0\.1/);
  const sub = fs.readFileSync(path.join(modsDir, "E2ETestMod", "SubModule.xml"), "utf8");
  assert.match(sub, /<Version value="v1\.0\.1" \/>/);
  assert.match(sub, /Id="Bannerlord\.Harmony"/);
});

test("logs", async () => {
  const r = await call("read_logs", { action: "list" });
  assert.equal(r.isError, false);
  const r2 = await call("read_logs", { errors_only: true, tail: 5 });
  assert.equal(typeof r2.text, "string");
});
