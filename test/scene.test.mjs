// Scene / prefab / asset tools against the real game data (file mode). Writes only to a temp folder.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb2mcp-scene-"));
const modsDir = path.join(tmp, "mods");
const srcDir = path.join(tmp, "sources");
fs.mkdirSync(modsDir);
fs.mkdirSync(srcDir);
const verbose = process.env.E2E_VERBOSE === "1";
let client;

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (verbose) console.log(`\n===== ${name} ${JSON.stringify(args).slice(0, 220)}\n${text}`);
  return { text, isError: !!res.isError, content: res.content };
}
async function ok(name, args) {
  const r = await call(name, args);
  assert.equal(r.isError, false, `${name} failed: ${r.text}`);
  return r.text;
}

function png(w, h) {
  // Minimal PNG header (signature + IHDR); enough for inspection, not a decodable image.
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

before(async () => {
  fs.writeFileSync(path.join(srcDir, "My Crate_d.png"), png(512, 512));
  fs.writeFileSync(path.join(srcDir, "odd_size.png"), png(300, 200));
  const fbx = Buffer.alloc(64);
  fbx.write("Kaydara FBX Binary  \u0000\u001a\u0000", 0, "latin1");
  fbx.writeUInt32LE(7400, 23);
  fs.writeFileSync(path.join(srcDir, "crate.fbx"), fbx);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "index.js")],
    env: { ...process.env, MB2_MODULE_DIRS: modsDir, MB2_DATA_DIR: path.join(tmp, "data") },
    stderr: "inherit",
  });
  client = new Client({ name: "scene-e2e", version: "1.0.0" });
  await client.connect(transport);
  await ok("create_module", { module_id: "SceneTestMod", location: modsDir });
});

after(async () => {
  await client?.close();
  if (!process.env.E2E_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  else console.log("kept", tmp);
});

test("browse vanilla scenes, prefabs and resources", async () => {
  const list = await ok("scene_list", { module: "Native", query: "scn_" });
  assert.match(list, /Native\/scn_/);
  const info = await ok("scene_info", { scene: "Native/scn_item_tableau" });
  assert.match(info, /Entities: \d+/);
  assert.match(info, /Checks:/);
  const ents = await ok("scene_entities", { scene: "SandBox/arena_aserai_a", tag: "sp_arena" });
  assert.match(ents, /\[\d+(\/\d+)*\] sp_arena_\d/);
  const one = await ok("scene_entities", { scene: "SandBox/arena_aserai_a", entity: "tournament_fight_set" });
  assert.match(one, /<game_entity name="tournament_fight_set"/);
  const pf = await ok("prefab_search", { query: "barrel" });
  assert.match(pf, /prefab\(s\)/);
  const pfName = /\n(\S*barrel\S*) — /.exec(pf)?.[1];
  assert.ok(pfName, "a barrel prefab exists");
  const pfx = await ok("prefab_search", { name: pfName });
  assert.match(pfx, /<game_entity/);
  const res = await ok("asset_search", { query: "editor_plane", kind: "mesh" });
  assert.match(res, /mesh\s+editor_plane/);
  const tex = await ok("asset_search", { query: "/^cg_/", kind: "texture", limit: 3 });
  assert.match(tex, /texture/);
});

test("create and edit a scene file", async () => {
  const c = await ok("scene_create", { module: "SceneTestMod", name: "stm_empty" });
  assert.match(c, /Created empty scene SceneTestMod\/stm_empty/);
  const dir = path.join(modsDir, "SceneTestMod", "SceneObj", "stm_empty");
  assert.ok(fs.existsSync(path.join(dir, "scene.xscene")));
  assert.ok(fs.existsSync(path.join(dir, "atmosphere.xml")));
  const copy = await ok("scene_create", { module: "SceneTestMod", name: "stm_copy", template: "Native/scn_item_tableau" });
  assert.match(copy, /as a copy of Native\/scn_item_tableau/);
  const copied = fs.readFileSync(path.join(modsDir, "SceneTestMod", "SceneObj", "stm_copy", "scene.xscene"), "utf8");
  assert.match(copied, /<scene name="stm_copy"/);

  const pf = await ok("prefab_search", { query: "barrel" });
  const prefab = /\n(\S*barrel\S*) — /.exec(pf)[1];
  const add = await ok("scene_edit", { scene: "stm_empty", action: "add", prefab, position: [5, 5, 1], rotation: [0, 0, 90], count: 3, offset: [2, 0, 0], add_tags: ["mcp_test"] });
  assert.match(add, new RegExp(`added ${prefab}_1 \\(prefab ${prefab}\\) at \\(5\\.000, 5\\.000, 1\\.000\\)`));
  assert.match(add, /added .*_3 .* at \(9\.000, 5\.000, 1\.000\)/);
  const mesh = await ok("scene_edit", { scene: "stm_empty", action: "add", mesh: "editor_plane_low", physics: "bo_editor_plane", name: "floor2", position: [0, 0, 0], scale: 4 });
  assert.match(mesh, /added floor2 \(mesh editor_plane_low\)/);
  let text = fs.readFileSync(path.join(dir, "scene.xscene"), "utf8");
  assert.match(text, new RegExp(`<game_entity name="${prefab}_1" prefab="${prefab}">`));
  assert.match(text, /rotation_euler="0\.000, 0\.000, 1\.571"/);
  assert.match(text, /<tag name="mcp_test"\/>/);
  assert.match(text, /scale="4\.000, 4\.000, 4\.000"/);
  assert.match(text, /<meta_mesh_component name="editor_plane_low"\/>/);

  const list = await ok("scene_entities", { scene: "stm_empty", tag: "mcp_test" });
  assert.match(list, /3 entities match/);
  assert.match(list, /rot°=\(0\.0, 0\.0, 90\.0\)/);
  const handle = /\n\[(\d+)\] \S+_2 /.exec(list)[1];

  const upd = await ok("scene_edit", { scene: "stm_empty", action: "update", entities: [handle], move_by: [0, 0, 3], rotate_by: [0, 0, 90], add_tags: ["moved"], remove_tags: ["mcp_test"], script: "AmbientSoundEmitter", variables: { SoundName: "event:/test" }, attributes: { mobility: "1" } });
  assert.match(upd, /pos=\(7\.000, 5\.000, 4\.000\)/);
  assert.match(upd, /rot°=\(0\.0, 0\.0, 180\.0\)/);
  assert.match(upd, /tags=moved/);
  assert.match(upd, /scripts=AmbientSoundEmitter/);
  text = fs.readFileSync(path.join(dir, "scene.xscene"), "utf8");
  assert.match(text, /<variable name="SoundName" value="event:\/test"\/>/);
  assert.match(text, /mobility="1"/);

  const dup = await ok("scene_edit", { scene: "stm_empty", action: "duplicate", entities: ["floor2"], count: 2, offset: [0, 10, 0] });
  assert.match(dup, /floor2_copy1 at \(0\.000, 10\.000, 0\.000\)/);
  assert.match(dup, /floor2_copy2 at \(0\.000, 20\.000, 0\.000\)/);
  const del = await ok("scene_edit", { scene: "stm_empty", action: "delete", entities: ["floor2_copy2"] });
  assert.match(del, /deleted \[\d+\] floor2_copy2/);
  const near = await ok("scene_entities", { scene: "stm_empty", near: [0, 10, 0], radius: 1 });
  assert.match(near, /floor2_copy1/);
  assert.doesNotMatch(near, /floor2_copy2/);

  const set = await ok("scene_settings", { scene: "stm_empty", environment: { is_indoors: "true", atmosphere_name: "TOD_12_00_SemiCloudy" }, atmosphere: { time_of_day: "14.500" } });
  assert.match(set, /is_indoors=true/);
  assert.match(fs.readFileSync(path.join(dir, "atmosphere.xml"), "utf8"), /name="time_of_day" value="14\.500"/);
  const show = await ok("scene_settings", { scene: "stm_empty" });
  assert.match(show, /atmosphere_properties\.atmosphere_name = TOD_12_00_SemiCloudy/);

  const info = await ok("scene_info", { scene: "stm_empty" });
  assert.match(info, /Checks: OK/);
  assert.match(info, /Not referenced by any ModuleData/);

  // Prefab from a scene entity (a linked instance gets expanded).
  const pc = await ok("prefab_create", { module: "SceneTestMod", name: "stm_my_barrel", from_scene: "stm_empty", entity: handle });
  assert.match(pc, /Created prefab 'stm_my_barrel'/);
  assert.match(pc, /Expanded 1 linked prefab instance/);
  const pfile = fs.readFileSync(path.join(modsDir, "SceneTestMod", "Prefabs", "scenetestmod_prefabs.xml"), "utf8");
  assert.match(pfile, /<game_entity name="stm_my_barrel" old_prefab_name="/);
  assert.match(pfile, /position="0\.000, 0\.000, 0\.000"/);
  const found = await ok("prefab_search", { name: "stm_my_barrel" });
  assert.match(found, /SceneTestMod Prefabs\/scenetestmod_prefabs\.xml/);

  // Undo the delete.
  const undo = await ok("undo_edit", { module: "SceneTestMod" });
  assert.match(undo, /Undid #\d+ prefab_create/);
});

test("import asset sources", async () => {
  const imp = await ok("asset_import", { module: "SceneTestMod", files: [srcDir], normalize_names: true });
  assert.match(imp, /copied AssetSources\/my_crate_d\.png \(0 KB, PNG 512x512\) → editor creates Assets\/my_crate_d_tex\.tpac/);
  assert.match(imp, /odd_size\.png[\s\S]*not a multiple of 4|not a power of two/);
  assert.match(imp, /crate\.fbx .*binary FBX 7400/);
  const st = await ok("asset_status", { module: "SceneTestMod" });
  assert.match(st, /3 file\(s\) — 0 imported, 3 pending/);
  const again = await ok("asset_import", { module: "SceneTestMod", files: [path.join(srcDir, "crate.fbx")] });
  assert.match(again, /skipped crate\.fbx \(already exists/);
  // Optional: one of your own modules with converted assets (MB2_TEST_ASSET_MODULE) is reported as imported.
  const assetModule = process.env.MB2_TEST_ASSET_MODULE;
  if (assetModule) assert.match(await ok("asset_status", { module: assetModule }), /imported/);
});

test("editor tools without a running editor", async () => {
  const st = await ok("editor_status", {});
  assert.match(st, /Modding Kit:/);
  // Never touch an editor the user is running.
  if (/Bridge connection: OK/.test(st)) return;
  const r = await call("scene_entities", { live: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /bridge/i);
  // Never touch a game the user is running: only check the no-game answers when none runs.
  if (/Running: no Bannerlord process/.test(st)) {
    assert.match(await ok("editor_command", { action: "dialogs" }), /No Bannerlord process/);
    assert.match(await ok("editor_command", { action: "dismiss_dialogs" }), /No Bannerlord process/);
    const shot = await call("editor_command", { action: "screenshot" });
    assert.equal(shot.isError, true);
    assert.match(shot.text, /No Bannerlord process/);
  }
});

test("siege spawner names, scene levels and the editor camera", async () => {
  await ok("scene_create", { module: "SceneTestMod", name: "stm_siege" });
  const file = path.join(modsDir, "SceneTestMod", "SceneObj", "stm_siege", "scene.xscene");

  // Spawner prefabs keep the prefab-derived name the editor needs, also in rows.
  const add = await ok("scene_edit", { scene: "stm_siege", action: "add", prefab: "ballista_a_spawner", position: [0, 0, 0], count: 2, offset: [5, 0, 0] });
  assert.equal((add.match(/added ballista_a_spawner \(prefab ballista_a_spawner\)/g) ?? []).length, 2);
  const bad = await call("scene_edit", { scene: "stm_siege", action: "add", prefab: "ballista_a_spawner", name: "gate_ballista" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /'gate', which does not exist/);
  const spawners = await ok("scene_entities", { scene: "stm_siege", prefab: "ballista_a_spawner" });
  const h0 = /\n\[(\d+)\] ballista_a_spawner /.exec(spawners)[1];
  const ren = await call("scene_edit", { scene: "stm_siege", action: "update", entities: [h0], name: "my_ballista" });
  assert.equal(ren.isError, true);
  assert.match(ren.text, /BallistaSpawner/);
  const ren2 = await call("scene_edit", { scene: "stm_siege", action: "update", entities: [h0], attributes: { name: "gate" } });
  assert.equal(ren2.isError, true);
  const dup = await ok("scene_edit", { scene: "stm_siege", action: "duplicate", entities: [h0] });
  assert.match(dup, /→ ballista_a_spawner at/);

  // Several targets get exactly the given name unless number_names is set.
  await ok("scene_edit", { scene: "stm_siege", action: "add", mesh: "editor_plane_low", name: "marker", count: 2, offset: [0, 3, 0] });
  const markers = await ok("scene_entities", { scene: "stm_siege", name: "marker" });
  const mh = [...markers.matchAll(/\n\[(\d+)\] marker_\d /g)].map((m) => m[1]);
  assert.equal(mh.length, 2);
  const same = await ok("scene_edit", { scene: "stm_siege", action: "update", entities: mh, name: "gate_marker" });
  assert.equal((same.match(/updated \[\d+\] gate_marker /g) ?? []).length, 2);
  const numbered = await ok("scene_edit", { scene: "stm_siege", action: "update", entities: mh, name: "gate_marker", number_names: true });
  assert.match(numbered, /gate_marker_1 /);
  assert.match(numbered, /gate_marker_2 /);

  // Scene levels: defined in the root, joined per entity, protected while used.
  const lv = await ok("scene_settings", { scene: "stm_siege", add_levels: ["siege", "civilian"] });
  assert.match(lv, /\+siege \(mask 2\), \+civilian \(mask 4\)/);
  let text = fs.readFileSync(file, "utf8");
  assert.match(text, /<level name="siege" mask="2"\/>/);
  await ok("scene_edit", { scene: "stm_siege", action: "update", entities: [h0], levels: ["siege"] });
  text = fs.readFileSync(file, "utf8");
  assert.match(text, /<levels>\s*<level name="siege"\/>\s*<\/levels>/);
  const unknown = await call("scene_edit", { scene: "stm_siege", action: "update", entities: [h0], levels: ["night"] });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Unknown scene level/);
  const rm = await call("scene_settings", { scene: "stm_siege", remove_levels: ["siege"] });
  assert.equal(rm.isError, true);
  assert.match(rm.text, /used by 1 entit/);
  await ok("scene_settings", { scene: "stm_siege", remove_levels: ["civilian"] });
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /civilian/);

  // Editor camera: normalized, never vertical; a vertical one saved by the editor is reported.
  const vert = await call("scene_settings", { scene: "stm_siege", editor_camera: { forward: "0, 0, -1" } });
  assert.equal(vert.isError, true);
  assert.match(vert.text, /straight up or down/);
  await ok("scene_settings", { scene: "stm_siege", editor_camera: { position: "10, 20, 30", forward: "1, 1, -0.2" } });
  text = fs.readFileSync(file, "utf8");
  assert.match(text, /editor_camera_position="10\.000, 20\.000, 30\.000"/);
  assert.match(text, /editor_camera_forward="0\.700, 0\.700, -0\.140"/);
  fs.writeFileSync(file, text.replace(/editor_camera_forward="[^"]*"/, 'editor_camera_forward="0.000, 0.000, -1.000"').replace('name="ballista_a_spawner"', 'name="gate_ballista"'));
  const info = await ok("scene_info", { scene: "stm_siege" });
  assert.match(info, /Levels: base \(mask 1\), siege \(mask 2, 1 entities\)/);
  assert.match(info, /saved editor camera looks straight up\/down/);
  assert.match(info, /Siege spawners whose name does not lead to a prefab \(1\)/);
  await ok("scene_settings", { scene: "stm_siege", copy_editor_camera_from: "stm_empty" });
  assert.match(fs.readFileSync(file, "utf8"), /editor_camera_forward="0\.413, 0\.487, -0\.769"/);
});
