import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "../context.js";
import { CORE_SP_MODULES, type ModuleInfo } from "../model/modules.js";
import type { Transaction } from "../ops/history.js";
import { slug } from "../ops/objects-edit.js";
import { assetStatus, expectedPackage, importSources, MESH_EXT } from "../scene/assets.js";
import { BRIDGE_VERSION } from "../scene/bridge-cs.js";
import {
  bridgeCall,
  BRIDGE_MODULE_ID,
  bridgeDir,
  bridgeInstallState,
  BridgeUnavailable,
  editorBinDir,
  editorExe,
  findCsc,
  gameProcesses,
  installBridge,
  launchEditor,
  linkedIntoGame,
  pidAlive,
  readBridgeStatus,
} from "../scene/bridge.js";
import { checkModulePackages, describePackageProblems, displayName, RESOURCE_KINDS, type ResourceKind } from "../scene/tpac.js";
import { describeSession, latestSessionPid, logMark, logSince, messageHints, sessionDiagnostics } from "../scene/gamelog.js";
import {
  captureGameWindow,
  dialogLine,
  dismissDialogs,
  fillDialog,
  listDialogs,
  listWindows,
  MODULE_WARNING_FOLLOW_UPS,
  answeredSummary,
  readDialogLog,
  STARTUP_NOTICES,
  watchModuleWarnings,
  type GameDialog,
  type GameWindow,
} from "../scene/windows.js";
import {
  atmosphereEdits,
  buildEntityXml,
  DEG,
  fmtNum,
  fmtVec,
  parseVec,
  listScenes,
  minimalSceneXml,
  readAtmosphereValues,
  renameSceneText,
  resolveScene,
  SceneDoc,
  SPAWNER_SCRIPT,
  spawnerNameProblem,
  verticalCamera,
  type EntityNode,
  type SceneRef,
} from "../scene/xscene.js";
import type { PrefabRec } from "../scene/prefabs.js";
import type { Args } from "../util/args.js";
import { decodeBmp, encodePng, fitImage, imageMime } from "../util/image.js";
import { clip, encodeText, readTextFile } from "../util/text.js";
import { applyEdits, elementSource, insertAfterEdit, insertBeforeEdit, insertChildEdit, removeElementEdit, replaceElementEdit, setAttributesEdits, type Edit } from "../xml/edit.js";
import { childElements, firstChild, getAttr, parseTree, scanXml, type XElem } from "../xml/scanner.js";
import { checkWellFormed } from "../xml/wellformed.js";
import { bool, int, schema, str, strEnum, strList, strMap, type ToolDef, type ToolOutput } from "./common.js";
import { isDirEntry } from "../util/fsx.js";

// ---- argument helpers ------------------------------------------------------------------------------

export const vecSchema = (description: string): Record<string, unknown> => ({ type: "array", items: { type: "number" }, description });

export function vecArg(a: Args, name: string, allowScalar = false): number[] | undefined {
  const v = a.value(name);
  if (v === undefined || v === null || v === "") return undefined;
  let nums: number[] | undefined;
  if (typeof v === "number") nums = allowScalar ? [v, v, v] : undefined;
  else if (Array.isArray(v)) nums = v.map((x) => Number(x));
  else if (typeof v === "string") {
    const s = v.trim().replace(/^\[|\]$/g, "");
    const parts = s.split(/[,\s]+/).filter(Boolean).map(Number);
    nums = parts.length === 1 && allowScalar ? [parts[0], parts[0], parts[0]] : parts;
  } else if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    nums = [Number(o.x), Number(o.y), Number(o.z)];
  }
  if (!nums || nums.length < 3 || nums.slice(0, 3).some((n) => !Number.isFinite(n))) throw new Error(`'${name}' must be three numbers like [x, y, z]${allowScalar ? " or one number" : ""}.`);
  return nums.slice(0, 3);
}

function rotArg(a: Args, name: string): number[] | undefined {
  const v = vecArg(a, name);
  if (!v) return undefined;
  return (a.str("rotation_unit") ?? "deg").toLowerCase().startsWith("rad") ? v : v.map((x) => x * DEG);
}

export const fmtV = (v: number[]): string => `(${v.map(fmtNum).join(", ")})`;
const fmtDeg = (v: number[]): string => `(${v.map((r) => (r / DEG).toFixed(1)).join(", ")})`;

// ---- formatting --------------------------------------------------------------------------------------

function fileEntityLine(doc: SceneDoc, n: EntityNode): string {
  const s = doc.summary(n);
  const parts = [`[${s.handle}]`, s.name ?? "(unnamed)"];
  if (s.prefab) parts.push(`prefab=${s.prefab}`);
  else if (s.oldPrefab) parts.push(`from_prefab=${s.oldPrefab}`);
  if (s.childIndex !== undefined) parts.push(`prefab_child#${s.childIndex}`);
  if (s.meshes.length) parts.push(`mesh=${s.meshes.slice(0, 3).join("+")}${s.meshes.length > 3 ? "+…" : ""}`);
  if (s.physics) parts.push(`physics=${s.physics}`);
  if (s.position) parts.push(`pos=${fmtV(s.position)}`);
  if (s.rotation && s.rotation.some((r) => Math.abs(r) > 1e-4)) parts.push(`rot°=${fmtDeg(s.rotation)}`);
  if (s.quaternion) parts.push(`quat=(${s.quaternion})`);
  if (s.scale && s.scale.some((x) => Math.abs(x - 1) > 1e-4)) parts.push(`scale=${fmtV(s.scale)}`);
  if (s.tags.length) parts.push(`tags=${s.tags.join(",")}`);
  if (s.scripts.length) parts.push(`scripts=${s.scripts.join(",")}`);
  if (s.children) parts.push(`children=${s.children}`);
  if (n.depth > 0) parts.push(`world≈${fmtV(doc.worldFrame(n).origin)}`);
  parts.push(`line ${s.line}`);
  return parts.join(" ");
}

interface LiveEntity {
  handle: number;
  name?: string;
  prefab?: string;
  position: number[];
  rotation: number[];
  scale: number[];
  tags: string[];
  children: number;
  parent?: string;
  selected?: boolean;
}

function liveLine(e: LiveEntity): string {
  const parts = [`#${e.handle}`, e.name || "(unnamed)"];
  if (e.prefab) parts.push(`prefab=${e.prefab}`);
  parts.push(`pos=${fmtV(e.position)}`);
  if (e.rotation.some((r) => Math.abs(r) > 1e-4)) parts.push(`rot°=${fmtDeg(e.rotation)}`);
  if (e.scale.some((x) => Math.abs(x - 1) > 1e-3)) parts.push(`scale=${fmtV(e.scale)}`);
  if (e.tags?.length) parts.push(`tags=${e.tags.join(",")}`);
  if (e.children) parts.push(`children=${e.children}`);
  if (e.parent) parts.push(`parent=${e.parent}`);
  if (e.selected) parts.push("[selected]");
  return parts.join(" ");
}

export interface LiveStatus {
  bridge: string;
  pid: number;
  editMode: boolean;
  state?: string;
  scene?: string;
  entities?: number;
  rootEntities?: number;
  selected?: number;
  sceneFile?: string;
  /** Scene.IsLoadingFinished() (bridge 0.2.3+): false while the engine still loads the scene. */
  loaded?: boolean;
  /** A running mission: editor play mode or a game mission (bridge 0.3.0+). */
  mission?: LiveMission;
}

export interface LiveAgent {
  index: number;
  name?: string;
  position: number[];
  direction: number[];
  controller: string;
  active: boolean;
  mounted: boolean;
  health: number;
  using?: string;
}

export interface LiveMission {
  editorPlay: boolean;
  scene?: string;
  levels?: string;
  state?: string;
  mode?: string;
  loaded?: boolean;
  time?: number;
  agents?: number;
  mainAgent?: LiveAgent;
}

export function missionLine(m: LiveMission): string {
  if (!m.scene) return `Play mode: ${m.editorPlay ? "the editor is starting or leaving play mode" : "a mission is starting or ending"}.`;
  const who = m.mainAgent ? `; player #${m.mainAgent.index} at ${fmtV(m.mainAgent.position)}${m.mainAgent.mounted ? " (mounted)" : ""}, controller ${m.mainAgent.controller}` : "; no player agent yet";
  return `${m.editorPlay ? "Play mode (editor)" : "Mission"}: scene '${m.scene}'${m.levels ? ` levels '${m.levels}'` : ""}, ${m.state}${m.loaded === false ? ", loading" : ""}, mode ${m.mode}, ${m.agents} agents${who}. Live scene_* commands wait until play mode ends; use mission / navmesh_query / editor_play.`;
}

const STILL_LOADING = "The engine reports the scene as still loading (Scene.IsLoadingFinished = false): entity lists can be incomplete and commands may wait — check editor_status again before editing.";

/** When this server last changed each scene live (scene name → time); changes made by hand in the editor are not tracked. */
const liveEdits = new Map<string, number>();
const LIVE_MUTATIONS = new Set(["spawn", "transform", "modify", "delete", "duplicate"]);

/** Time of the last live change this server made to `scene` after `file` was written, or null. */
export function unsavedLiveEdits(scene: string | undefined, file: string | null): number | null {
  const t = scene ? liveEdits.get(scene) : undefined;
  if (!t) return null;
  if (file) {
    try {
      if (fs.statSync(file).mtimeMs >= t) return null;
    } catch {
      /* no file: unsaved */
    }
  }
  return t;
}

export function unsavedLine(t: number): string {
  return `Unsaved: changes made through this server at ${new Date(t).toLocaleTimeString()} are newer than the scene file — save in the editor (Ctrl+S) first. (Changes made by hand in the editor are not tracked.)`;
}

export async function livePing(timeoutMs = 1500): Promise<LiveStatus | null> {
  try {
    return await bridgeCall<LiveStatus>("ping", {}, timeoutMs);
  } catch {
    return null;
  }
}

/** "<file> (last saved 10:05:12, 3 min ago …)" — tells an approver what quitting would lose. */
export function sceneFileLine(file: string | null, reported?: string): string {
  if (!file) return `${reported ?? "?"} (no scene file found for it — a new scene that was never saved?)`;
  const st = fs.statSync(file);
  const mins = Math.round((Date.now() - st.mtimeMs) / 60000);
  return `${file} (last saved ${new Date(st.mtimeMs).toLocaleTimeString()}, ${mins < 1 ? "less than a minute ago" : `${mins} min ago`}; later changes exist only in the editor)`;
}

/**
 * The scene.xscene behind the path the editor reports. It is usually relative to the game's working folder
 * (bin/Win64_Shipping_wEditor) or starts with $BASE, and may name the scene folder rather than the file.
 */
export function editorSceneFile(ctx: Ctx, scene: string | undefined, reported: string | undefined): string | null {
  const g = ctx.registry.gameDir;
  const candidates: string[] = [];
  if (reported) {
    const r = reported.replace(/\\/g, "/");
    const abs = /^\$BASE\//i.test(r) && g ? path.join(g, r.slice(6)) : path.isAbsolute(r) ? r : g ? path.resolve(editorBinDir(g), r) : path.resolve(r);
    candidates.push(abs, path.join(abs, "scene.xscene"), `${abs}.xscene`);
  }
  if (scene) {
    try {
      candidates.push(resolveScene(ctx.registry, scene).file);
    } catch {
      /* not a module scene */
    }
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * Deletes what this server leaves in the bridge folder — screenshots, capture leftovers, walk traces, dialog and bridge
 * logs — and nothing else (bridge.json and autostart.json of a running editor stay).
 */
export function cleanupOwnFiles(dir: string): { files: number; bytes: number } {
  const mine = /^(screenshot[_-].*\.(png|bmp)|.*\.(capture\.bmp|preview\.png)|walk_\d+_.*\.json|dialogs\.log|bridge\.log)$/i;
  let files = 0;
  let bytes = 0;
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const p = path.join(dir, f);
    if (!mine.test(f)) continue;
    const st = fs.lstatSync(p);
    if (!st.isFile()) continue;
    bytes += st.size;
    fs.rmSync(p, { force: true });
    files++;
  }
  return { files, bytes };
}

/** One line about the open scene for quit confirmations. */
async function openSceneSummary(ctx: Ctx): Promise<string> {
  const ping = await livePing(5000);
  if (!ping) return "Open scene: unknown (the editor did not answer).";
  if (!ping.scene) return "No scene is open in the editor.";
  const file = editorSceneFile(ctx, ping.scene, ping.sceneFile);
  const unsaved = unsavedLiveEdits(ping.scene, file);
  return `Open scene: '${ping.scene}' — ${sceneFileLine(file, ping.sceneFile)}.${unsaved ? ` ${unsavedLine(unsaved)}` : ""}`;
}

/** Pids of Bannerlord processes, and of everything related (launcher, crash watchdog, crash uploader). */
export function gamePids(): { game: number[]; related: number[] } {
  const procs = gameProcesses();
  return { game: procs.filter((p) => /^bannerlord/i.test(p.name)).map((p) => p.pid), related: procs.map((p) => p.pid) };
}

/** What keeps the game from answering: message boxes, other open editor windows, a frozen window, a watchdog dump in progress. */
async function blockingReport(ctx: Ctx, game: number[], related: number[]): Promise<string[]> {
  const L: string[] = [];
  const [dialogs, windows] = await Promise.all([listDialogs(ctx.config.dataDir, related).catch(() => [] as GameDialog[]), listWindows(ctx.config.dataDir, game).catch(() => [] as GameWindow[])]);
  for (const pid of game) {
    const own = windows.filter((w) => w.pid === pid && w.cls !== "#32770");
    const main = own.reduce<GameWindow | null>((best, w) => (!best || w.width * w.height > best.width * best.height ? w : best), null);
    if (main?.hung) L.push(`Game window of pid ${pid} is NOT RESPONDING (its main thread is blocked).`);
    if (main?.iconic) L.push(`Game window of pid ${pid} is minimized.`);
    const others = own.filter((w) => w !== main && w.title && !dialogs.some((d) => d.hwnd === w.hwnd));
    if (others.length) L.push(`Other open game windows (a modal one blocks the editor until closed): ${others.map((w) => `'${w.title}'${w.hung ? " (not responding)" : ""}`).join(", ")}`);
    const wd = sessionDiagnostics(pid).watchdog;
    if (wd?.pending) L.push(`Crash watchdog: collecting a dump for "${wd.pending}" — the game is frozen until it finishes (seconds to minutes per warning).`);
  }
  if (dialogs.length) {
    L.push(`Open message boxes (they block the game until answered): ${dialogs.length}`, ...dialogs.map((d) => `- ${dialogLine(d)}`));
    L.push("Answer them in the game, or call editor_command action=dismiss_dialogs (presses OK, or `button`; scene editor dialogs only with a named `button`).");
  }
  return L;
}

/** bridgeCall that, when the editor does not answer, says what blocks it. */
export async function liveCall<T = unknown>(ctx: Ctx, cmd: string, args: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
  try {
    const res = await bridgeCall<T>(cmd, args, timeoutMs);
    if (LIVE_MUTATIONS.has(cmd)) {
      const p = await livePing(1500);
      if (p?.scene) liveEdits.set(p.scene, Date.now());
    }
    return res;
  } catch (e) {
    if (e instanceof BridgeUnavailable || !/did not (answer|process)/.test((e as Error).message)) throw e;
    const st = readBridgeStatus();
    const report = st ? await blockingReport(ctx, [st.pid], [...new Set([st.pid, ...gamePids().related])]).catch(() => [] as string[]) : [];
    if (!report.length) throw e;
    throw new Error([(e as Error).message, ...report, "Retry once it is resolved."].join("\n"));
  }
}

const DIALOG_LOG = (): string => path.join(bridgeDir(), "dialogs.log");

/** Asks the renderer for a screenshot. It sees the game's render target — black while the scene editor is in front. */
async function engineScreenshot(ctx: Ctx, target: string, maxW: number, kept: string): Promise<string | ToolOutput> {
  // The engine always writes an uncompressed BMP (whatever the extension); it is converted below.
  const raw = target.replace(/\.[^.\\/]*$/, "") + ".capture.bmp";
  const p = await liveCall<string>(ctx, "screenshot", { path: raw }, 20000);
  // The file is written asynchronously at the end of a frame.
  const t0 = Date.now();
  let last = -1;
  while (Date.now() - t0 < 15000) {
    if (fs.existsSync(p)) {
      const size = fs.statSync(p).size;
      if (size > 0 && size === last) break;
      last = size;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!fs.existsSync(p)) return `Screenshot requested (${p}) but the file did not appear within 15 s.`;
  const buf = fs.readFileSync(p);
  const kind = imageMime(buf);
  if (kind !== "image/bmp") {
    if (p !== target) fs.renameSync(p, target);
    if (!kind || buf.length > 8 * 1024 * 1024) return `Engine screenshot (${(buf.length / 1024).toFixed(0)} KB, too large to show); ${kept}`;
    return { text: `Engine screenshot; ${kept}`, images: [{ data: buf.toString("base64"), mimeType: kind }] };
  }
  const full = decodeBmp(buf);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, encodePng(full));
  fs.rmSync(p, { force: true });
  const small = fitImage(full, maxW, Math.round((maxW * 10) / 16));
  return {
    text: `Engine screenshot (${full.width}×${full.height}, shown at ${small.width}×${small.height}); ${kept}`,
    images: [{ data: encodePng(small).toString("base64"), mimeType: "image/png" }],
  };
}

const LIVE_HINT = "Live changes are in the editor's memory only — press Ctrl+S in the editor to save the scene (they are not part of the editor's undo history).";

// ---- siege spawners --------------------------------------------------------------------------------

const rootScriptCache = new Map<string, string[]>();

/** Scripts on a prefab's root entity (PrefabRec.scripts also lists its children's). */
function prefabRootScripts(rec: PrefabRec): string[] {
  const key = `${rec.abs}|${rec.start}|${rec.end}`;
  let v = rootScriptCache.get(key);
  if (!v) {
    try {
      const root = parseTree(readTextFile(rec.abs).text.slice(rec.start, rec.end), 5).root;
      v = childElements(firstChild(root, "scripts"), "script")
        .map((s) => getAttr(s, "name") ?? "")
        .filter(Boolean);
    } catch {
      v = [];
    }
    rootScriptCache.set(key, v);
  }
  return v;
}

function prefabSpawnerScript(ctx: Ctx, prefab: string): string | null {
  ctx.prefabs.ensure(ctx.registry.modules);
  const rec = ctx.prefabs.find(prefab)[0];
  return rec ? (prefabRootScripts(rec).find((x) => SPAWNER_SCRIPT.test(x)) ?? null) : null;
}

/** Siege spawner script of a scene-file entity (its own, or its prefab root's). */
function spawnerScriptOf(ctx: Ctx, doc: SceneDoc, node: EntityNode): string | null {
  const s = doc.summary(node);
  return s.scripts.find((x) => SPAWNER_SCRIPT.test(x)) ?? (s.prefab ? prefabSpawnerScript(ctx, s.prefab) : null);
}

const CAMERA_FIELDS = ["editor_camera_position", "editor_camera_forward", "editor_camera_elevation", "editor_camera_bearing"];

/** scene_settings editor_camera / copy_editor_camera_from → <editor_data> attributes; vertical cameras are refused. */
function editorCameraArgs(ctx: Ctx, a: Args): Array<[string, string]> {
  const out = new Map<string, string>();
  const from = a.str("copy_editor_camera_from");
  if (from) {
    const src = new SceneDoc(resolveScene(ctx.registry, from).file).editorCamera();
    if (!src.attrs.length) throw new Error(`${from} has no saved editor camera.`);
    for (const [k, v] of src.attrs) out.set(k, v);
  }
  for (const [key, raw] of a.map("editor_camera")) {
    const k = key.startsWith("editor_camera_") ? key : `editor_camera_${key}`;
    if (!CAMERA_FIELDS.includes(k)) throw new Error(`Unknown editor camera field '${key}' (position, forward, elevation, bearing).`);
    if (k.endsWith("position") || k.endsWith("forward")) {
      let v = raw
        .replace(/[[\]]/g, "")
        .split(/[,\s]+/)
        .filter(Boolean)
        .map(Number);
      if (v.length !== 3 || v.some((x) => !Number.isFinite(x))) throw new Error(`${key} needs three numbers, e.g. "10, 20, 5".`);
      if (k.endsWith("forward")) {
        const l = Math.hypot(v[0], v[1], v[2]);
        if (!l) throw new Error("forward must not be zero.");
        v = v.map((x) => x / l);
      }
      out.set(k, fmtVec(v));
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${key} must be a number.`);
      out.set(k, fmtNum(n));
    }
  }
  const fwd = out.get("editor_camera_forward");
  if (fwd && verticalCamera(parseVec(fwd))) {
    throw new Error(`The editor camera would look straight up or down (forward ${fwd}). A camera saved that way (e.g. from the Top view) makes the next open show a black viewport; tilt it a little.`);
  }
  return [...out];
}

function prefabExists(ctx: Ctx): (p: string) => boolean {
  ctx.prefabs.ensure(ctx.registry.modules);
  return (p) => ctx.prefabs.find(p).length > 0;
}

// ---- shared helpers ------------------------------------------------------------------------------------

function sceneSummaryHeader(ref: SceneRef): string {
  return `${ref.module.id}/${ref.name} — ${ref.file} (${(ref.size / 1024).toFixed(0)} KB, modified ${new Date(ref.mtimeMs).toLocaleString()})${ref.module.writable ? "" : " [read-only module]"}`;
}

async function openWarning(ref: SceneRef): Promise<string | null> {
  const st = await livePing(1200);
  if (st?.scene && st.scene.toLowerCase() === ref.name.toLowerCase()) {
    return `WARNING: '${ref.name}' is open in the running editor. Saving there will overwrite these file changes (or reload the scene in the editor to see them). Use live=true to edit the open scene instead.`;
  }
  return null;
}

/** Keeps references.txt (resource list the editor writes next to the scene) in sync with added meshes. */
function updateReferences(tx: Transaction, dir: string, meshes: string[]): boolean {
  const file = path.join(dir, "references.txt");
  if (!meshes.length || !fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const entries = lines.slice(/^\d+$/.test(lines[0] ?? "") ? 1 : 0);
  const have = new Set(entries.map((l) => l.trim()));
  let added = 0;
  for (const m of meshes) {
    const e = `mesh ${m}`;
    if (!have.has(e)) {
      entries.push(e);
      have.add(e);
      added++;
    }
  }
  if (!added) return false;
  entries.sort((a, b) => a.localeCompare(b));
  tx.write(file, Buffer.from([String(entries.length), ...entries, ""].join("\n"), "utf8"));
  return true;
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let i = 1; taken.has(name); i++) name = `${base}_${i}`;
  taken.add(name);
  return name;
}

function stripGuids(xml: string): string {
  const edits: Edit[] = [];
  scanXml(xml, {
    onOpen: (el) => {
      for (const a of el.attrs) {
        if (a.name !== "guid") continue;
        let k = a.nameStart;
        while (k > 0 && /\s/.test(xml[k - 1])) k--;
        edits.push({ start: k, end: a.valueEnd + 1, text: "" });
      }
    },
  });
  return applyEdits(xml, edits);
}

/**
 * Prefab definitions cannot link other prefabs, so linked instances (prefab="P") inside the source
 * are replaced by a copy of P's definition carrying the instance's name and transform
 * (old_prefab_name="P", like the editor's "break prefab"). Per-child overrides are dropped.
 */
function expandPrefabLinks(ctx: Ctx, xml: string): { xml: string; expanded: number; dropped: number } {
  const { root } = parseTree(xml, 5);
  if (!root) return { xml, expanded: 0, dropped: 0 };
  const layout = { eol: xml.includes("\r\n") ? "\r\n" : "\n", unit: "\t" };
  const linked: XElem[] = [];
  const visit = (el: XElem): void => {
    if (el.name === "game_entity" && getAttr(el, "prefab")) {
      linked.push(el);
      return;
    }
    for (const c of el.children ?? []) visit(c);
  };
  visit(root);
  if (!linked.length) return { xml, expanded: 0, dropped: 0 };
  ctx.prefabs.ensure(ctx.registry.modules);
  let dropped = 0;
  const edits: Edit[] = [];
  for (const el of linked) {
    const pf = getAttr(el, "prefab")!;
    const defs = ctx.prefabs.find(pf);
    if (!defs.length) throw new Error(`Linked prefab '${pf}' (line ${el.line}) was not found in any Prefabs folder.`);
    const d = defs[defs.length - 1];
    const dtext = readTextFile(d.abs).text;
    const del = parseTree(dtext, 5).root?.children?.find((c) => c.start === d.start);
    if (!del) throw new Error(`Cannot read prefab '${pf}' from ${d.rel}.`);
    let def = stripGuids(elementSource(dtext, del));
    let r = parseTree(def, 5).root!;
    def = applyEdits(def, setAttributesEdits(def, r, [["name", getAttr(el, "name") ?? pf], ["old_prefab_name", pf]]));
    const instT = (el.children ?? []).find((c) => c.name === "transform");
    if (instT) {
      const tXml = xml.slice(instT.start, instT.end);
      r = parseTree(def, 5).root!;
      const defT = (r.children ?? []).find((c) => c.name === "transform");
      const anchor = (r.children ?? []).find((c) => !["flags", "visibility_masks", "tags", "levels"].includes(c.name));
      def = applyEdits(def, [defT ? replaceElementEdit(def, defT, tXml, layout) : anchor ? insertBeforeEdit(def, anchor, tXml, layout) : insertChildEdit(def, r, tXml, layout)]);
    }
    if ((el.children ?? []).some((c) => c.name === "children")) dropped++;
    edits.push(replaceElementEdit(xml, el, def, layout));
  }
  return { xml: applyEdits(xml, edits), expanded: linked.length, dropped };
}

async function commitTx<T>(ctx: Ctx, tx: Transaction, moduleId: string, fn: () => Promise<T> | T): Promise<{ result: T; seq: number | null }> {
  try {
    const result = await fn();
    const entry = tx.commit();
    return { result, seq: entry?.seq ?? null };
  } catch (e) {
    const entry = tx.commit();
    if (entry) {
      try {
        ctx.history.undo(entry.seq, true);
      } catch {
        /* best effort */
      }
    }
    throw e;
  } finally {
    ctx.afterWrite(moduleId);
  }
}

const footer = (seq: number | null): string => (seq !== null ? `\n(edit #${seq} — undo_edit seq=${seq} reverts it)` : "");

function sceneUsage(ctx: Ctx, name: string): string[] {
  const out: string[] = [];
  ctx.indexAll();
  for (const f of ctx.index.files()) {
    if (f.kind !== "data") continue;
    let text: string;
    try {
      text = readTextFile(f.abs).text;
    } catch {
      continue;
    }
    if (!text.includes(name)) continue;
    scanXml(text, {
      maxErrors: 1,
      onOpen: (el) => {
        for (const a of el.attrs) if (a.value === name && out.length < 30) out.push(`${f.module} ${f.rel}:${el.line} <${el.name} ${a.name}="${name}">`);
      },
    });
  }
  return out;
}

// ---- tools ---------------------------------------------------------------------------------------------

export const sceneTools: ToolDef[] = [
  {
    name: "scene_list",
    group: "scene",
    title: "List scenes",
    description: "Lists scenes (SceneObj/<name>/scene.xscene) of all or selected modules with size, date and whether terrain/navmesh data exists.",
    inputSchema: schema({
      module: str("Module filter: id, comma list, official | mods | writable."),
      query: str("Substring of the scene name."),
      limit: int("Max rows (default 100)."),
    }),
    readOnly: true,
    handler: (a, ctx) => {
      const mods = ctx.selectModules(a.str("module"));
      const q = (a.str("query") ?? "").toLowerCase();
      const order = new Map(ctx.registry.loadOrder(mods).map((m, i) => [m.id, i]));
      let scenes = listScenes(mods).filter((s) => !q || s.name.toLowerCase().includes(q));
      scenes.sort((x, y) => Number(y.module.writable) - Number(x.module.writable) || (order.get(x.module.id) ?? 0) - (order.get(y.module.id) ?? 0) || x.name.localeCompare(y.name));
      const total = scenes.length;
      scenes = scenes.slice(0, a.int("limit", 100, 1, 1000));
      const lines = [`${total} scene(s)${total > scenes.length ? `, showing ${scenes.length}` : ""}:`];
      for (const s of scenes) {
        const flags: string[] = [];
        if (fs.existsSync(path.join(s.dir, "terrain.bin"))) flags.push("terrain");
        if (fs.existsSync(path.join(s.dir, "navmesh.bin"))) flags.push("navmesh");
        lines.push(`${s.module.id}/${s.name}  ${(s.size / 1024).toFixed(0)} KB  ${new Date(s.mtimeMs).toISOString().slice(0, 10)}${flags.length ? `  [${flags.join(", ")}]` : ""}${s.module.writable ? "  writable" : ""}`);
      }
      return lines.join("\n");
    },
  },
  {
    name: "scene_info",
    group: "scene",
    title: "Scene overview and checks",
    description:
      "Overview of a scene file: header, environment/atmosphere settings, terrain, entity/prefab/script/tag statistics, spawn points, bounding box, where the game references it, and checks (unknown prefabs/meshes/physics shapes, XML errors). live=true reports the scene currently open in the Modding Kit editor instead (needs the editor bridge).",
    inputSchema: schema({
      scene: str("Scene name, Module/scene, or path. Not needed with live=true."),
      module: str("Module to look in when several have a scene with that name."),
      live: bool("Report the scene open in the running editor (default false)."),
      check: bool("Run consistency checks (default true)."),
    }),
    readOnly: true,
    handler: async (a, ctx) => {
      if (a.bool("live", false)) {
        const st = await liveCall<LiveStatus>(ctx, "ping", {}, 5000);
        const lines = [`Editor bridge ${st.bridge} (pid ${st.pid}), state ${st.state ?? "?"}, edit mode ${st.editMode ? "ON" : "off"}`];
        if (st.scene) lines.push(`Open scene: ${st.scene}${st.sceneFile ? ` (${st.sceneFile})` : ""}`, `Entities: ${st.entities} (${st.rootEntities} root), selected: ${st.selected}`);
        else lines.push("No scene is open in the editor.");
        if (st.selected) {
          const sel = await liveCall<{ total: number; entities: LiveEntity[] }>(ctx, "selection", {}, 10000);
          lines.push("Selection:", ...sel.entities.slice(0, 30).map(liveLine));
        }
        return lines.join("\n");
      }
      const ref = resolveScene(ctx.registry, a.req("scene"), a.str("module"));
      const doc = new SceneDoc(ref.file);
      const L: string[] = [sceneSummaryHeader(ref)];
      L.push(`<scene name="${doc.name}" version="${getAttr(doc.root, "version") ?? "?"}" unique_token="${getAttr(doc.root, "unique_token") ?? "-"}">`);
      // Files in the folder.
      const files = fs.readdirSync(ref.dir, { withFileTypes: true }).map((d) => (isDirEntry(d, path.join(ref.dir, d.name)) ? `${d.name}/` : `${d.name} (${(fs.statSync(path.join(ref.dir, d.name)).size / 1024).toFixed(0)} KB)`));
      L.push(`Folder: ${files.join(", ")}`);
      // Environment.
      const env: string[] = [];
      const envEl = doc.root.children?.find((c) => c.name === "environment_properties");
      const visitEnv = (el: typeof envEl): void => {
        for (const c of el?.children ?? []) {
          if (c.name === "property") env.push(`${getAttr(c, "name")}=${getAttr(c, "value")}`);
          else visitEnv(c);
        }
      };
      visitEnv(envEl);
      if (env.length) L.push(`Environment: ${env.slice(0, 40).join("; ")}`);
      const atmo = readAtmosphereValues(path.join(ref.dir, "atmosphere.xml"));
      if (atmo.length) {
        const keys = ["name", "time_of_day", "color_grade_name", "is_indoor", "season", "cloud_amount", "fog_density", "sun_altitude", "skybox_background_texture_name"];
        L.push(`atmosphere.xml: ${atmo.filter(([k]) => keys.includes(k)).map(([k, v]) => `${k}=${v}`).join("; ")} (${atmo.length} values; scene_settings edits them)`);
      }
      const terrain = doc.root.children?.find((c) => c.name === "terrain");
      if (terrain) {
        const en = getAttr(terrain, "enabled") === "true";
        const nx = Number(getAttr(terrain, "node_dimension_x") ?? 0);
        const ny = Number(getAttr(terrain, "node_dimension_y") ?? 0);
        const ns = Number(getAttr(terrain, "node_size") ?? 0);
        L.push(en ? `Terrain: ${nx}×${ny} nodes of ${ns} m → ${(nx * ns).toFixed(0)}×${(ny * ns).toFixed(0)} m, heights ${getAttr(terrain, "min_height")}…${getAttr(terrain, "max_height")}` : "Terrain: disabled");
      }
      const levelDefs = doc.levelDefs();
      const levelUse = new Map<string, number>();
      for (const n of doc.entities()) for (const l of doc.entityLevels(n)) levelUse.set(l, (levelUse.get(l) ?? 0) + 1);
      if (levelDefs.length || levelUse.size) {
        L.push(`Levels: ${levelDefs.map((d) => `${d.name} (mask ${d.mask}${levelUse.get(d.name) ? `, ${levelUse.get(d.name)} entities` : ""})`).join(", ") || "none defined"}`);
      }
      const cam = doc.editorCamera();
      if (cam.attrs.length) L.push(`Editor camera: position ${cam.position ? fmtV(cam.position) : "?"}, forward ${cam.forward ? fmtV(cam.forward) : "?"}${verticalCamera(cam.forward) ? " — VERTICAL" : ""}`);
      let giFlag: string | undefined;
      const findGi = (el: XElem | undefined): void => {
        for (const c of el?.children ?? []) {
          if (c.name === "property" && getAttr(c, "name") === "gi_data_exists") giFlag = getAttr(c, "value");
          else findGi(c);
        }
      };
      findGi(firstChild(doc.root, "environment_properties"));
      const prtFiles = fs.readdirSync(ref.dir).filter((f) => /prt/i.test(f));
      if (giFlag !== undefined || prtFiles.length) {
        const desc = prtFiles.map((f) => {
          const st = fs.statSync(path.join(ref.dir, f));
          return `${f} ${(st.size / 1024 / 1024).toFixed(1)} MB (${new Date(st.mtimeMs).toLocaleString()})`;
        });
        L.push(`GI: gi_data_exists=${giFlag ?? "unset"}; ${desc.length ? desc.join(", ") : "no PRT data file"}`);
      }
      // Statistics.
      const all = doc.entities();
      const roots = all.filter((n) => n.depth === 0);
      const prefabs = new Map<string, number>();
      const scripts = new Map<string, number>();
      const tags = new Map<string, number>();
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      const names = new Map<string, number>();
      for (const n of all) {
        const s = doc.summary(n);
        if (s.prefab) prefabs.set(s.prefab, (prefabs.get(s.prefab) ?? 0) + 1);
        for (const sc of s.scripts) scripts.set(sc, (scripts.get(sc) ?? 0) + 1);
        for (const t of s.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
        if (n.depth === 0) {
          if (s.name) names.set(s.name, (names.get(s.name) ?? 0) + 1);
          if (s.position) for (let i = 0; i < 3; i++) {
            min[i] = Math.min(min[i], s.position[i]);
            max[i] = Math.max(max[i], s.position[i]);
          }
        }
      }
      const top = (m: Map<string, number>, k: number): string =>
        [...m]
          .sort((x, y) => y[1] - x[1])
          .slice(0, k)
          .map(([n, c]) => `${n}×${c}`)
          .join(", ");
      L.push(`Entities: ${all.length} (${roots.length} root); prefab instances: ${[...prefabs.values()].reduce((x, y) => x + y, 0)}`);
      if (prefabs.size) L.push(`Top prefabs: ${top(prefabs, 15)}`);
      if (scripts.size) L.push(`Scripts: ${top(scripts, 15)}`);
      if (tags.size) L.push(`Tags: ${top(tags, 30)}`);
      const spawns = [...tags.keys()].filter((t) => /^sp_|spawn/i.test(t));
      if (spawns.length) L.push(`Spawn-related tags: ${spawns.map((t) => `${t}×${tags.get(t)}`).join(", ")}`);
      if (Number.isFinite(min[0])) L.push(`Root positions span x ${fmtNum(min[0])}…${fmtNum(max[0])}, y ${fmtNum(min[1])}…${fmtNum(max[1])}, z ${fmtNum(min[2])}…${fmtNum(max[2])}`);
      const paths = doc.root.children?.find((c) => c.name === "Paths")?.children?.length ?? 0;
      if (paths) L.push(`Paths: ${paths}`);
      const usage = sceneUsage(ctx, ref.name);
      L.push(usage.length ? `Referenced by game data:\n  ${usage.join("\n  ")}` : "Not referenced by any ModuleData XML (settlement locations, custom battle scene lists, …).");
      if (a.bool("check", true)) {
        const issues: string[] = [];
        const wf = checkWellFormed(doc.text, 5);
        for (const p of wf) issues.push(`XML line ${p.line}: ${p.message}`);
        ctx.prefabs.ensure(ctx.registry.modules);
        const missingPrefabs = [...prefabs.keys()].filter((p) => !ctx.prefabs.find(p).length);
        if (missingPrefabs.length) issues.push(`Prefabs not defined in any module's Prefabs/*.xml (${missingPrefabs.length}): ${missingPrefabs.slice(0, 20).join(", ")}`);
        ctx.assets.ensure(ctx.registry.modules);
        const meshes = new Set<string>();
        const shapes = new Set<string>();
        const materials = new Set<string>();
        scanXml(doc.text, {
          maxErrors: 1,
          onOpen: (el) => {
            if (el.name === "meta_mesh_component") {
              const n = getAttr(el, "name");
              if (n) meshes.add(n);
              const m = getAttr(el, "material");
              if (m) materials.add(m);
            } else if (el.name === "physics") {
              const n = getAttr(el, "shape");
              if (n) shapes.add(n);
            } else if (el.name === "decal_component") {
              const m = getAttr(el, "material");
              if (m) materials.add(m);
            }
          },
        });
        const unknown = (set: Set<string>, kinds: ResourceKind[]): string[] => (ctx.assets.knows(kinds[0]) ? [...set].filter((n) => !ctx.assets.has(n, kinds)) : []);
        const um = unknown(meshes, ["mesh"]);
        const us = unknown(shapes, ["physics_shape"]);
        const umat = unknown(materials, ["material"]);
        if (um.length) issues.push(`Meshes not found in any asset package (${um.length}/${meshes.size}): ${um.slice(0, 20).join(", ")}`);
        if (us.length) issues.push(`Physics shapes not found (${us.length}/${shapes.size}): ${us.slice(0, 20).join(", ")}`);
        if (umat.length) issues.push(`Materials not found (${umat.length}/${materials.size}): ${umat.slice(0, 20).join(", ")}`);
        const dupes = [...names].filter(([, c]) => c > 1);
        if (dupes.length) issues.push(`Duplicate root entity names (${dupes.length}): ${dupes.slice(0, 10).map(([n, c]) => `${n}×${c}`).join(", ")}`);
        const badSpawners: string[] = [];
        const exists = prefabExists(ctx);
        for (const n of all) {
          const sc = spawnerScriptOf(ctx, doc, n);
          const nm = getAttr(n.el, "name") ?? "";
          if (sc && spawnerNameProblem(nm, sc, exists)) badSpawners.push(`[${n.handle}] '${nm}' (${sc})`);
        }
        if (badSpawners.length) {
          issues.push(
            `Siege spawners whose name does not lead to a prefab (${badSpawners.length}) — the editor instantiates '<name minus its last _part>' and crashes loading the scene: ${badSpawners.slice(0, 12).join(", ")}${badSpawners.length > 12 ? ", …" : ""}`,
          );
        }
        const definedLevels = new Set(levelDefs.map((d) => d.name));
        const undefinedLevels = [...levelUse.keys()].filter((l) => !definedLevels.has(l));
        if (undefinedLevels.length) issues.push(`Entities use levels the scene does not define: ${undefinedLevels.map((l) => `${l} (${levelUse.get(l)})`).join(", ")} — scene_settings add_levels.`);
        if (verticalCamera(cam.forward)) issues.push(`The saved editor camera looks straight up/down (forward ${fmtV(cam.forward!)}); reopening can show a black viewport — scene_settings editor_camera / copy_editor_camera_from.`);
        if (giFlag === "true" && !prtFiles.length) issues.push("gi_data_exists=true but the scene folder has no PRT data file.");
        L.push(issues.length ? `Checks:\n  - ${issues.join("\n  - ")}` : "Checks: OK (prefabs, meshes, physics shapes and materials resolve; XML well-formed).");
        if (um.length || us.length || umat.length) L.push("  (Names are matched against the resource tables of every module's .tpac packages; engine built-ins can occasionally be reported.)");
      }
      return L.join("\n");
    },
  },
  {
    name: "scene_entities",
    group: "scene",
    title: "List or inspect scene entities",
    description:
      "Lists entities of a scene file with handles ([12], [12/0] for children), name, prefab, mesh, position, rotation (degrees), scale, tags and scripts; filters by name/prefab/tag/script/mesh or distance. entity=<handle|name> returns the entity's XML. live=true lists the scene open in the Modding Kit editor (#handles are session ids for scene_edit live=true).",
    inputSchema: schema({
      scene: str("Scene name, Module/scene or path (file mode)."),
      module: str("Module to look in when the scene name is ambiguous."),
      live: bool("Query the scene open in the running editor (default false)."),
      entity: str("Handle or name of one entity to show in full."),
      name: str("Substring (or /regex/) of the entity name."),
      prefab: str("Substring of the prefab name (files: prefab or old_prefab_name; live: linked prefab instances)."),
      tag: str("Exact tag."),
      script: str("Exact script component name (file mode)."),
      mesh: str("Substring of a meta mesh name (file mode)."),
      near: vecSchema("Only entities within `radius` of this [x, y, z] point."),
      radius: int("Radius in meters for `near` (default 10)."),
      recursive: bool("Include child entities (default: true when filtering, false otherwise)."),
      selected: bool("live=true: only the editor's current selection."),
      limit: int("Max rows (default 60)."),
      offset: int("Skip rows (paging)."),
    }),
    readOnly: true,
    handler: async (a, ctx) => {
      const limit = a.int("limit", 60, 1, 500);
      const offset = a.int("offset", 0, 0);
      const near = vecArg(a, "near");
      const radius = a.int("radius", 10, 0);
      if (a.bool("live", false)) {
        if (a.bool("selected", false)) {
          const sel = await liveCall<{ total: number; entities: LiveEntity[] }>(ctx, "selection", {}, 15000);
          return [`${sel.total} selected entit${sel.total === 1 ? "y" : "ies"}:`, ...sel.entities.map(liveLine)].join("\n");
        }
        const args: Record<string, unknown> = { limit, offset, rootOnly: !a.bool("recursive", !!(a.str("name") || a.str("tag") || a.str("prefab") || near)) };
        const nameQ = a.str("entity") ?? a.str("name");
        if (nameQ) args.name = nameQ;
        if (a.str("tag")) args.tag = a.str("tag");
        if (a.str("prefab")) args.prefab = a.str("prefab");
        if (near) {
          args.near = near;
          args.radius = radius;
        }
        const res = await liveCall<{ total: number; entities: LiveEntity[] }>(ctx, "entities", args, 20000);
        const lines = [`${res.total} entit${res.total === 1 ? "y" : "ies"} in the editor${res.total > res.entities.length ? `, showing ${offset + 1}-${offset + res.entities.length}` : ""}:`];
        lines.push(...res.entities.map(liveLine));
        if (res.total > offset + res.entities.length) lines.push(`… next page: offset=${offset + res.entities.length}`);
        if ((await livePing(1500))?.loaded === false) lines.push(STILL_LOADING);
        return lines.join("\n");
      }
      const ref = resolveScene(ctx.registry, a.req("scene"), a.str("module"));
      const doc = new SceneDoc(ref.file);
      const ent = a.str("entity");
      if (ent) {
        const n = doc.find(ent);
        let xml = doc.source(n);
        if (xml.length > 20000) xml = `${xml.slice(0, 20000)}\n… (${xml.length} chars; read the file at line ${n.el.line})`;
        return [`${ref.module.id}/${ref.name} ${fileEntityLine(doc, n)}`, ref.file, xml].join("\n");
      }
      const nameQ = a.str("name");
      let re: RegExp | null = null;
      if (nameQ && nameQ.length > 2 && nameQ.startsWith("/") && nameQ.lastIndexOf("/") > 0) re = new RegExp(nameQ.slice(1, nameQ.lastIndexOf("/")), "i");
      const prefabQ = a.str("prefab")?.toLowerCase();
      const tagQ = a.str("tag");
      const scriptQ = a.str("script");
      const meshQ = a.str("mesh")?.toLowerCase();
      const filtering = !!(nameQ || prefabQ || tagQ || scriptQ || meshQ || near);
      const recursive = a.bool("recursive", filtering);
      const hits = doc.entities().filter((n) => {
        if (!recursive && n.depth > 0) return false;
        const s = doc.summary(n);
        if (nameQ) {
          const nm = s.name ?? "";
          if (re ? !re.test(nm) : !nm.toLowerCase().includes(nameQ.toLowerCase())) return false;
        }
        if (prefabQ && !`${s.prefab ?? ""}|${s.oldPrefab ?? ""}`.toLowerCase().includes(prefabQ)) return false;
        if (tagQ && !s.tags.includes(tagQ)) return false;
        if (scriptQ && !s.scripts.includes(scriptQ)) return false;
        if (meshQ && !s.meshes.some((m) => m.toLowerCase().includes(meshQ))) return false;
        if (near) {
          const w = n.depth === 0 ? (s.position ?? [0, 0, 0]) : doc.worldFrame(n).origin;
          if (Math.hypot(w[0] - near[0], w[1] - near[1], w[2] - near[2]) > radius) return false;
        }
        return true;
      });
      const page = hits.slice(offset, offset + limit);
      const lines = [`${ref.module.id}/${ref.name}: ${hits.length} entit${hits.length === 1 ? "y" : "ies"}${filtering ? " match" : recursive ? "" : " at root level"}${hits.length > page.length ? `, showing ${offset + 1}-${offset + page.length}` : ""} (rot° in degrees; positions of children are local, world≈ approximate):`];
      for (const n of page) lines.push(fileEntityLine(doc, n));
      if (hits.length > offset + page.length) lines.push(`… next page: offset=${offset + page.length}`);
      return lines.join("\n");
    },
  },
  {
    name: "scene_edit",
    group: "scene",
    title: "Edit scene entities",
    description:
      "Adds, updates, deletes or duplicates entities. File mode edits scene.xscene of a writable module (formatting preserved, undoable). live=true edits the scene open in the Modding Kit editor through the bridge (then save with Ctrl+S in the editor); live also supports select, focus and snap_to_ground. add: place a prefab (prefab=…) or a mesh (mesh=…, physics=bo_…) or raw <game_entity> XML, `count`+`offset` make rows. update: position/move_by, rotation/rotate_by (degrees unless rotation_unit=rad), scale, name (exact for every target unless number_names), add_tags/remove_tags, attributes, script+variables, levels (file mode). Live targets: #handles from scene_entities live (valid until the scene is reopened) or names (child entities included). Siege spawner names are protected: the editor derives their prefab from the name.",
    inputSchema: schema(
      {
        action: strEnum(["add", "update", "delete", "duplicate", "select", "focus"], "What to do."),
        scene: str("Scene name, Module/scene or path (file mode)."),
        module: str("Module to look in when the scene name is ambiguous."),
        live: bool("Edit the scene open in the running editor instead of the file (default false)."),
        entities: strList("Targets: handles ([12], 12/0 in files; #id numbers live), names, 'guid:{…}' or '@selected' (live)."),
        prefab: str("add: prefab name (see prefab_search)."),
        mesh: str("add: meta mesh name (see asset_search kind=mesh)."),
        physics: str("add (file mode, with mesh): physics shape such as bo_…"),
        xml: str("add (file mode): a complete <game_entity> element."),
        name: str("Name of new entities / new name for update. Siege spawners (BallistaSpawner, MangonelSpawner…) must keep '<prefab>_spawner' names — the editor derives their prefab from the name; other names are refused."),
        number_names: bool("Append _1, _2 … to `name`: default true when add makes several entities (never for siege spawners), false for update (every target gets exactly `name`)."),
        levels: strList("update (file mode): the scene levels the entities belong to, e.g. [\"siege\"] ([] = every level). Define levels with scene_settings add_levels."),
        parent: str("add (file mode): handle or name of the parent entity."),
        position: vecSchema("[x, y, z] position (add: placement; update: absolute)."),
        rotation: vecSchema("[x, y, z] euler rotation (degrees unless rotation_unit=rad)."),
        rotation_unit: strEnum(["deg", "rad"], "Unit of rotation / rotate_by (default deg)."),
        scale: vecSchema("[x, y, z] scale (a single number scales uniformly)."),
        move_by: vecSchema("update: relative move [dx, dy, dz]."),
        rotate_by: vecSchema("update: relative rotation [dx, dy, dz] (degrees by default)."),
        add_tags: strList("Tags to add."),
        remove_tags: strList("Tags to remove."),
        attributes: strMap("update (file mode): attributes to set on <game_entity>, e.g. {\"mobility\": \"1\"}."),
        remove_attributes: strList("update (file mode): attributes to remove."),
        script: str("update (file mode): script component name whose variables to set (created if missing)."),
        variables: strMap("update (file mode): script variables, e.g. {\"SoundName\": \"event:/…\"}."),
        count: int("add/duplicate: number of copies (default 1)."),
        offset: vecSchema("add/duplicate: step between copies [dx, dy, dz] (duplicate default [1,0,0])."),
        snap_to_ground: bool("live: drop new/moved entities onto terrain or geometry below."),
        add_to_selection: bool("live select: keep the current selection."),
        visible: bool("live update: show/hide the entities."),
      },
      ["action"],
    ),
    handler: async (a, ctx) => {
      const action = a.req("action");
      const position = vecArg(a, "position");
      const rotation = rotArg(a, "rotation");
      const scale = vecArg(a, "scale", true);
      const moveBy = vecArg(a, "move_by");
      const rotateBy = rotArg(a, "rotate_by");
      const offset = vecArg(a, "offset");
      const count = a.int("count", 1, 1, 500);
      const addTags = a.list("add_tags");
      const removeTags = a.list("remove_tags");
      const targets = a.list("entities").map((s) => s.replace(/^\[(.*)\]$/, "$1"));

      if (a.bool("live", false)) {
        if (ctx.config.readOnly && action !== "select" && action !== "focus") throw new Error("Read-only mode (MB2_READONLY): live edits are disabled.");
        const liveRefs = targets.map((t) => (/^#?\d+$/.test(t) ? Number(t.replace("#", "")) : t));
        let res: unknown;
        switch (action) {
          case "add": {
            const spawner = a.str("prefab") ? prefabSpawnerScript(ctx, a.req("prefab")) : null;
            const numberNames = !spawner && a.bool("number_names", true);
            if (spawner && a.str("name")) {
              const problem = spawnerNameProblem(a.req("name"), spawner, prefabExists(ctx));
              if (problem) throw new Error(problem);
            }
            res = await liveCall(ctx, "spawn", {
              prefab: a.str("prefab"),
              mesh: a.str("mesh"),
              name: a.str("name"),
              numberNames,
              position: position ?? [0, 0, 0],
              rotation: rotation ?? [0, 0, 0],
              scale: scale ?? [1, 1, 1],
              count,
              offset: offset ?? [0, 0, 0],
              tags: addTags,
              snapToGround: a.bool("snap_to_ground", false),
            });
            break;
          }
          case "update": {
            if (!liveRefs.length) throw new Error("update needs entities.");
            const tr: Record<string, unknown> = { entities: liveRefs, snapToGround: a.bool("snap_to_ground", false) };
            if (position) tr.position = position;
            if (moveBy) tr.moveBy = moveBy;
            if (rotation) tr.rotation = rotation;
            if (rotateBy) tr.rotateBy = rotateBy;
            if (scale) tr.scale = scale;
            const hasTransform = position || moveBy || rotation || rotateBy || scale || a.bool("snap_to_ground", false);
            if (hasTransform) res = await liveCall(ctx, "transform", tr);
            if (a.has("levels")) throw new Error("levels can only be changed in the scene file (live=false); the editor's own level panel does it live.");
            if (a.str("name") || addTags.length || removeTags.length || a.has("visible")) {
              const mod: Record<string, unknown> = { entities: liveRefs, addTags, removeTags, numberNames: a.bool("number_names", false) };
              if (a.str("name")) mod.name = a.str("name");
              if (a.has("visible")) mod.visible = a.bool("visible", true);
              res = await liveCall(ctx, "modify", mod);
            }
            if (!res) throw new Error("Nothing to update: give position/move_by/rotation/rotate_by/scale/name/tags/visible.");
            break;
          }
          case "delete":
            if (!liveRefs.length) throw new Error("delete needs entities.");
            return `Deleted ${await liveCall<number>(ctx, "delete", { entities: liveRefs })} entit(ies) in the editor.\n${LIVE_HINT}`;
          case "duplicate":
            if (!liveRefs.length) throw new Error("duplicate needs entities.");
            res = await liveCall(ctx, "duplicate", { entities: liveRefs, count, offset: offset ?? [1, 0, 0] });
            break;
          case "select":
            return `Selected ${await liveCall<number>(ctx, "select", { entities: liveRefs, add: a.bool("add_to_selection", false), focus: true })} entit(ies).`;
          case "focus": {
            const p = await liveCall<number[]>(ctx, "focus", liveRefs.length ? { entities: liveRefs } : { position: position ?? [0, 0, 0] });
            return `Asked the editor to zoom to ${fmtV(p)}. It keeps the camera's direction and stops at a viewing distance, so the camera is not placed at that point and the target may still be hidden — take a screenshot to see what is in view.`;
          }
          default:
            throw new Error(`Unknown action '${action}'.`);
        }
        const list = (Array.isArray(res) ? res : []) as LiveEntity[];
        return [`${action}: ${list.length} entit${list.length === 1 ? "y" : "ies"}`, ...list.slice(0, 50).map(liveLine), "", LIVE_HINT].join("\n");
      }

      // ---- file mode -------------------------------------------------------------------------------
      if (action === "select" || action === "focus") throw new Error(`${action} only works with live=true (it acts on the running editor).`);
      const ref = resolveScene(ctx.registry, a.req("scene"), a.str("module"));
      const mod = ctx.registry.requireWritable(ref.module.id);
      const doc = new SceneDoc(ref.file);
      const warn = await openWarning(ref);
      const out: string[] = [];
      const addedMeshes: string[] = [];
      const tx = ctx.history.begin("scene_edit", mod.id, `${action} in scene ${ref.name}`);
      const { seq } = await commitTx(ctx, tx, mod.id, () => {
        if (action === "add") {
          const parent = a.str("parent") ? doc.find(a.req("parent")) : undefined;
          const taken = new Set(doc.entities().map((n) => getAttr(n.el, "name") ?? ""));
          const edits: Edit[] = [];
          const xmlArg = a.str("xml");
          if (xmlArg) {
            const root = parseTree(xmlArg.trim(), 5).root;
            if (!root || root.name !== "game_entity") throw new Error("xml must be a single <game_entity> element.");
            const wf = checkWellFormed(xmlArg, 3);
            if (wf.length) throw new Error(`xml is not well-formed: line ${wf[0].line}: ${wf[0].message}`);
            for (let i = 0; i < count; i++) edits.push(doc.insertEntityEdit(stripGuids(xmlArg.trim()), parent));
            out.push(`added ${count} entit${count === 1 ? "y" : "ies"} from XML`);
          } else {
            const prefab = a.str("prefab");
            const mesh = a.str("mesh");
            if (!prefab && !mesh) throw new Error("add needs prefab, mesh or xml.");
            if (prefab) {
              ctx.prefabs.ensure(ctx.registry.modules);
              const p = ctx.prefabs.find(prefab);
              if (!p.length) throw new Error(`Prefab '${prefab}' was not found in any module's Prefabs folder (prefab_search lists them).`);
              addedMeshes.push(...p[0].meshes);
            }
            if (mesh) addedMeshes.push(mesh);
            const base = a.str("name") ?? prefab ?? mesh ?? "entity";
            const spawner = prefab ? prefabSpawnerScript(ctx, prefab) : null;
            if (spawner) {
              const problem = spawnerNameProblem(base, spawner, prefabExists(ctx));
              if (problem) throw new Error(problem);
            }
            // Spawners keep their prefab-derived name (several may share it); number_names=false keeps names exact.
            const exact = !!spawner || (a.has("number_names") && !a.bool("number_names", true));
            for (let i = 0; i < count; i++) {
              const pos = (position ?? [0, 0, 0]).map((v, k) => v + (offset?.[k] ?? 0) * i);
              const name = exact ? base : uniqueName(count > 1 || taken.has(base) ? `${base}_${i + 1}` : base, taken);
              const xml = buildEntityXml({ name, prefab, mesh, physics: a.str("physics"), position: pos, rotation, scale, tags: addTags });
              edits.push(doc.insertEntityEdit(xml, parent));
              out.push(`added ${name}${prefab ? ` (prefab ${prefab})` : ` (mesh ${mesh})`} at ${fmtV(pos)}${parent ? ` under ${parent.handle}` : ""}`);
            }
          }
          doc.apply(edits);
        } else if (action === "update") {
          if (!targets.length) throw new Error("update needs entities (handles or names).");
          const nodes = [...new Map(targets.map((t) => doc.find(t)).map((n) => [n.handle, n])).values()];
          const setAttrs = a.map("attributes");
          const remAttrs = a.list("remove_attributes");
          const vars = a.map("variables");
          const script = a.str("script");
          if (vars.length && !script) throw new Error("variables need script=<script component name>.");
          const newName = a.str("name");
          const numberNames = a.bool("number_names", false) && nodes.length > 1;
          const nameFor = (idx: number): string | undefined => (newName ? (numberNames ? `${newName}_${idx + 1}` : newName) : undefined);
          const levels = a.has("levels") ? a.list("levels") : null;
          if (levels) {
            const defined = doc.levelDefs().map((d) => d.name);
            const unknownLevels = levels.filter((l) => !defined.includes(l));
            if (unknownLevels.length) throw new Error(`Unknown scene level(s): ${unknownLevels.join(", ")} (defined: ${defined.join(", ") || "none"}). Add them with scene_settings add_levels.`);
          }
          // A siege spawner renamed away from '<prefab>_spawner' crashes the editor when the scene loads.
          const attrName = setAttrs.find(([k]) => k === "name")?.[1];
          nodes.forEach((n, idx) => {
            const sc = spawnerScriptOf(ctx, doc, n);
            if (!sc) return;
            for (const nn of [nameFor(idx), attrName]) {
              const problem = nn ? spawnerNameProblem(nn, sc, prefabExists(ctx)) : null;
              if (problem) throw new Error(`[${n.handle}] ${problem}`);
            }
          });
          const build = (n: EntityNode, idx: number): Edit[] => {
            const s = doc.summary(n);
            const edits: Edit[] = [];
            const t: { position?: number[]; rotation?: number[]; scale?: number[] } = {};
            if (position) t.position = position;
            if (moveBy) t.position = (s.position ?? [0, 0, 0]).map((v, k) => v + moveBy[k]);
            if (rotation) t.rotation = rotation;
            if (rotateBy) t.rotation = (s.rotation ?? [0, 0, 0]).map((v, k) => v + rotateBy[k]);
            if (scale) t.scale = scale;
            edits.push(...doc.transformEdits(n, t));
            const attrChanges: Array<[string, string | null]> = [...setAttrs.map(([k, v]) => [k, v] as [string, string | null]), ...remAttrs.map((k) => [k, null] as [string, string | null])];
            const nn = nameFor(idx);
            if (nn) attrChanges.push(["name", nn]);
            if (attrChanges.length) edits.push(...setAttributesEdits(doc.text, n.el, attrChanges));
            if (addTags.length || removeTags.length) edits.push(...doc.tagEdits(n, addTags, removeTags));
            if (script && vars.length) edits.push(...doc.scriptEdits(n, script, vars));
            if (levels) edits.push(...doc.entityLevelEdits(n, levels));
            return edits;
          };
          let edits: Edit[] = [];
          nodes.forEach((n, i) => edits.push(...build(n, i)));
          if (!edits.length) throw new Error("Nothing to update: give position/move_by/rotation/rotate_by/scale/name/tags/attributes/variables/levels.");
          try {
            doc.apply(edits);
          } catch {
            // Overlapping edits (e.g. parent and child both targeted): apply one entity at a time.
            const handles = nodes.map((n) => n.handle);
            handles.forEach((h, i) => {
              edits = build(doc.find(h), i);
              doc.apply(edits);
            });
          }
          for (const h of nodes.map((n) => n.handle)) out.push(`updated ${fileEntityLine(doc, doc.find(h))}`);
        } else if (action === "delete") {
          if (!targets.length) throw new Error("delete needs entities.");
          const nodes = [...new Map(targets.map((t) => doc.find(t)).map((n) => [n.handle, n])).values()];
          const isInside = (n: EntityNode): boolean => nodes.some((o) => o !== n && n.handle.startsWith(`${o.handle}/`));
          const keep = nodes.filter((n) => !isInside(n));
          for (const n of keep) out.push(`deleted [${n.handle}] ${getAttr(n.el, "name") ?? "(unnamed)"}`);
          doc.apply(keep.map((n) => removeElementEdit(doc.text, n.el)));
        } else if (action === "duplicate") {
          if (!targets.length) throw new Error("duplicate needs entities.");
          const step = offset ?? [1, 0, 0];
          const taken = new Set(doc.entities().map((n) => getAttr(n.el, "name") ?? ""));
          const edits: Edit[] = [];
          for (const t of targets) {
            const n = doc.find(t);
            const s = doc.summary(n);
            const copies: string[] = [];
            for (let i = 1; i <= count; i++) {
              let xml = stripGuids(doc.source(n));
              const r = parseTree(xml, 5).root!;
              // Spawner copies keep the prefab-derived name the editor needs.
              const name = spawnerScriptOf(ctx, doc, n) ? (s.name ?? "") : uniqueName(`${s.name ?? "entity"}_copy${count > 1 ? i : ""}`, taken);
              const changes: Edit[] = setAttributesEdits(xml, r, [["name", name]]);
              xml = applyEdits(xml, changes);
              const r2 = parseTree(xml, 5).root!;
              const tr = r2.children?.find((c) => c.name === "transform");
              const pos = (s.position ?? [0, 0, 0]).map((v, k) => v + step[k] * i);
              xml = tr ? applyEdits(xml, setAttributesEdits(xml, tr, [["position", pos.map(fmtNum).join(", ")]])) : xml;
              copies.push(xml);
              out.push(`duplicated [${n.handle}] → ${name} at ${fmtV(pos)}`);
            }
            edits.push(insertAfterEdit(doc.text, n.el, copies.join("\n"), doc.layout()));
          }
          doc.apply(edits);
        } else throw new Error(`Unknown action '${action}'.`);
        tx.write(ref.file, doc.serialize());
        if (updateReferences(tx, ref.dir, addedMeshes)) out.push("updated references.txt");
      });
      if (warn) out.unshift(warn);
      return out.join("\n") + footer(seq);
    },
  },
  {
    name: "scene_create",
    group: "scene",
    title: "Create a scene",
    description:
      "Creates SceneObj/<name>/ in a writable module: a copy of an existing scene (template=…, any module; terrain/navmesh files are copied, name and unique token renewed) or a minimal empty scene like the editor's New Scene (envmap probe + ground plane, terrain off).",
    inputSchema: schema(
      {
        module: str("Writable module."),
        name: str("Scene name (folder name), e.g. mymod_arena_a."),
        template: str("Scene to copy (name or Module/name). Omit for an empty scene."),
      },
      ["module", "name"],
    ),
    handler: async (a, ctx) => {
      const mod = ctx.registry.requireWritable(a.req("module"));
      const name = a.req("name").trim();
      if (!/^[A-Za-z0-9_\-]+$/.test(name)) throw new Error("Scene names may contain letters, digits, '_' and '-'.");
      const dir = path.join(mod.dir, "SceneObj", name);
      if (fs.existsSync(dir)) throw new Error(`${dir} already exists.`);
      const clash = listScenes(ctx.registry.modules).filter((s) => s.name.toLowerCase() === name.toLowerCase());
      const tx = ctx.history.begin("scene_create", mod.id, `create scene ${name}`);
      const lines: string[] = [];
      const { seq } = await commitTx(ctx, tx, mod.id, () => {
        tx.mkdir(dir);
        const tplSpec = a.str("template");
        if (tplSpec) {
          const tpl = resolveScene(ctx.registry, tplSpec);
          for (const e of fs.readdirSync(tpl.dir, { withFileTypes: true })) {
            if (!e.isFile()) continue;
            const src = path.join(tpl.dir, e.name);
            if (e.name.toLowerCase() === "scene.xscene") {
              const tf = readTextFile(src);
              tx.write(path.join(dir, e.name), encodeText(renameSceneText(tf.text, name), tf.encoding));
            } else tx.copyIn(src, path.join(dir, e.name), { backup: true });
          }
          lines.push(`Created ${mod.id}/${name} as a copy of ${tpl.module.id}/${tpl.name} (${fs.readdirSync(tpl.dir).length} item(s); ShaderCache folders are rebuilt by the game).`);
        } else {
          tx.write(path.join(dir, "scene.xscene"), encodeText(minimalSceneXml(name), "utf8"));
          const native = ctx.registry.get("Native");
          const atmo = native ? path.join(native.dir, "Atmospheres", "scene_atmosphere.xml") : "";
          if (atmo && fs.existsSync(atmo)) tx.copyIn(atmo, path.join(dir, "atmosphere.xml"), { backup: true });
          lines.push(`Created empty scene ${mod.id}/${name} (envmap probe + 20 m ground plane, no terrain).`);
        }
      });
      lines.push(`Folder: ${dir}`);
      if (clash.length) lines.push(`Note: a scene named '${name}' also exists in ${clash.map((c) => c.module.id).join(", ")}; scene names should be unique across loaded modules.`);
      lines.push("Next: scene_edit to place prefabs, or open it in the Modding Kit editor (editor_launch, then File → Open Scene). Reference it from data (e.g. a settlement <Location scene_name=…>) to use it in game.");
      return lines.join("\n") + footer(seq);
    },
  },
  {
    name: "scene_settings",
    group: "scene",
    title: "Scene environment & atmosphere",
    description:
      "Reads or changes a scene's <environment_properties> (e.g. atmosphere_name, is_indoors, water_level, physics_world_min, gi_data_exists), its atmosphere.xml values (time_of_day, color_grade_name, season, fog_density, sun_altitude, …), its level definitions (base, siege, civilian… — entities join them with scene_edit levels) and the editor camera saved in <editor_data>. Without changes it lists the current values.",
    inputSchema: schema(
      {
        scene: str("Scene name, Module/scene or path."),
        module: str("Module to look in when the scene name is ambiguous."),
        environment: strMap("environment property name → value."),
        atmosphere: strMap("atmosphere.xml value name → value."),
        add_levels: strList("Scene levels to define, e.g. [\"siege\"]; each gets the next free mask bit."),
        remove_levels: strList("Scene levels to remove (refused while entities still use them)."),
        editor_camera: strMap("Editor camera to save: position, forward (direction; normalized, must not be vertical), elevation, bearing (or the full editor_camera_* names)."),
        copy_editor_camera_from: str("Copy the editor camera fields from another scene (name, Module/scene or path), e.g. a backup that opened correctly."),
      },
      ["scene"],
    ),
    handler: async (a, ctx) => {
      const ref = resolveScene(ctx.registry, a.req("scene"), a.str("module"));
      const env = a.map("environment");
      const atm = a.map("atmosphere");
      const addLevels = a.list("add_levels");
      const removeLevels = a.list("remove_levels");
      const camera = editorCameraArgs(ctx, a);
      const atmoFile = path.join(ref.dir, "atmosphere.xml");
      if (!env.length && !atm.length && !addLevels.length && !removeLevels.length && !camera.length) {
        const doc = new SceneDoc(ref.file);
        const props: string[] = [];
        const visit = (el: XElem | undefined, prefix: string): void => {
          for (const c of el?.children ?? []) {
            if (c.name === "property") props.push(`${prefix}${getAttr(c, "name")} = ${getAttr(c, "value")}`);
            else visit(c, `${c.name}.`);
          }
        };
        visit(doc.root.children?.find((c) => c.name === "environment_properties"), "");
        const values = readAtmosphereValues(atmoFile);
        const cam = doc.editorCamera();
        return [
          sceneSummaryHeader(ref),
          `levels: ${doc.levelDefs().map((d) => `${d.name} (mask ${d.mask})`).join(", ") || "none defined"}`,
          `editor camera: ${cam.attrs.map(([k, v]) => `${k.replace("editor_camera_", "")}=${v}`).join(", ") || "none saved"}${verticalCamera(cam.forward) ? " — looks straight up/down: the next open may show a black viewport" : ""}`,
          "environment_properties:",
          ...props.map((p) => `  ${p}`),
          fs.existsSync(atmoFile) ? "atmosphere.xml:" : "(no atmosphere.xml)",
          ...values.map(([k, v]) => `  ${k} = ${v}`),
        ].join("\n");
      }
      const mod = ctx.registry.requireWritable(ref.module.id);
      const warn = await openWarning(ref);
      const out: string[] = [];
      const tx = ctx.history.begin("scene_settings", mod.id, `settings of scene ${ref.name}`);
      const { seq } = await commitTx(ctx, tx, mod.id, () => {
        if (env.length || addLevels.length || removeLevels.length || camera.length) {
          const doc = new SceneDoc(ref.file);
          if (env.length) {
            const { edits, missing } = doc.environmentEdits(env);
            doc.apply(edits);
            out.push(`scene.xscene: ${env.map(([k, v]) => `${k}=${v}`).join(", ")}${missing.length ? ` (added new: ${missing.join(", ")})` : ""}`);
          }
          if (addLevels.length || removeLevels.length) {
            const { edits, added } = doc.sceneLevelEdits(addLevels, removeLevels);
            doc.apply(edits);
            out.push(`levels: ${[...added.map(([n, m]) => `+${n} (mask ${m})`), ...removeLevels.map((n) => `−${n}`)].join(", ") || "unchanged (already defined)"} → ${doc.levelDefs().map((d) => d.name).join(", ")}`);
          }
          if (camera.length) {
            doc.apply(doc.editorDataEdits(camera));
            out.push(`editor camera: ${camera.map(([k, v]) => `${k.replace("editor_camera_", "")}=${v}`).join(", ")}`);
          }
          tx.write(ref.file, doc.serialize());
        }
        if (atm.length) {
          if (!fs.existsSync(atmoFile)) throw new Error(`${atmoFile} does not exist.`);
          const tf = readTextFile(atmoFile);
          const { edits, missing } = atmosphereEdits(tf.text, atm);
          const text = applyEdits(tf.text, edits);
          const wf = checkWellFormed(text, 1);
          if (wf.length) throw new Error(`Internal error: atmosphere.xml would be invalid (${wf[0].message}).`);
          tx.write(atmoFile, encodeText(text, tf.encoding));
          out.push(`atmosphere.xml: ${atm.map(([k, v]) => `${k}=${v}`).join(", ")}${missing.length ? ` (added new: ${missing.join(", ")})` : ""}`);
        }
      });
      if (warn) out.unshift(warn);
      return out.join("\n") + footer(seq);
    },
  },
  {
    name: "prefab_search",
    group: "scene",
    title: "Search prefabs",
    description:
      "Searches prefab definitions (Modules/*/Prefabs/*.xml — what the editor's prefab browser shows) by name, mesh, script or tag. name=<exact> returns the prefab's XML. Use the names with scene_edit action=add prefab=….",
    inputSchema: schema({
      query: str("Substring (or /regex/) of the prefab name."),
      name: str("Exact prefab name to show in full."),
      module: str("Module filter (id, comma list, official, mods)."),
      mesh: str("Substring of a mesh used by the prefab."),
      script: str("Script component name used by the prefab."),
      tag: str("Tag used by the prefab."),
      limit: int("Max rows (default 40)."),
      offset: int("Skip rows."),
    }),
    readOnly: true,
    handler: (a, ctx) => {
      const mods = ctx.selectModules(a.str("module"));
      ctx.prefabs.ensure(ctx.registry.modules);
      const allowed = new Set(mods.map((m) => m.id));
      const exact = a.str("name");
      if (exact) {
        const defs = ctx.prefabs.find(exact).filter((p) => allowed.has(p.module));
        if (!defs.length) return `Prefab '${exact}' not found. Try query=${exact.slice(0, 12)}.`;
        const p = defs[defs.length - 1];
        const text = readTextFile(p.abs).text;
        const root = parseTree(text, 5).root;
        const el = root?.children?.find((c) => c.start === p.start) ?? root?.children?.find((c) => getAttr(c, "name") === p.name);
        let xml = el ? elementSource(text, el) : "";
        if (xml.length > 20000) xml = `${xml.slice(0, 20000)}\n… (${xml.length} chars)`;
        return [
          `Prefab ${p.name} — ${p.module} ${p.rel}:${p.line}${defs.length > 1 ? ` (also in ${defs.slice(0, -1).map((d) => d.module).join(", ")})` : ""}`,
          `meshes: ${p.meshes.join(", ") || "-"}; physics: ${p.physics.join(", ") || "-"}; scripts: ${p.scripts.join(", ") || "-"}; tags: ${p.tags.join(", ") || "-"}; child entities: ${p.children}`,
          p.abs,
          xml,
        ].join("\n");
      }
      const q = a.str("query") ?? "";
      let re: RegExp | null = null;
      if (q.length > 2 && q.startsWith("/") && q.lastIndexOf("/") > 0) re = new RegExp(q.slice(1, q.lastIndexOf("/")), "i");
      const meshQ = a.str("mesh")?.toLowerCase();
      const scriptQ = a.str("script");
      const tagQ = a.str("tag");
      if (!q && !meshQ && !scriptQ && !tagQ) throw new Error("Give query, name, mesh, script or tag.");
      const hits = ctx.prefabs.all().filter((p) => {
        if (!allowed.has(p.module)) return false;
        if (q && (re ? !re.test(p.name) : !p.name.toLowerCase().includes(q.toLowerCase()))) return false;
        if (meshQ && !p.meshes.some((m) => m.toLowerCase().includes(meshQ))) return false;
        if (scriptQ && !p.scripts.includes(scriptQ)) return false;
        if (tagQ && !p.tags.includes(tagQ)) return false;
        return true;
      });
      hits.sort((x, y) => (x.name.toLowerCase() === q.toLowerCase() ? -1 : 0) - (y.name.toLowerCase() === q.toLowerCase() ? -1 : 0) || x.name.localeCompare(y.name));
      const limit = a.int("limit", 40, 1, 300);
      const offset = a.int("offset", 0, 0);
      const page = hits.slice(offset, offset + limit);
      const lines = [`${hits.length} prefab(s)${hits.length > page.length ? `, showing ${offset + 1}-${offset + page.length}` : ""}:`];
      for (const p of page) {
        const bits = [p.meshes.length ? `mesh=${clip(p.meshes.slice(0, 3).join("+"), 60)}` : "", p.scripts.length ? `scripts=${p.scripts.slice(0, 3).join(",")}` : "", p.tags.length ? `tags=${p.tags.slice(0, 4).join(",")}` : "", p.children ? `children=${p.children}` : ""].filter(Boolean);
        lines.push(`${p.name} — ${p.module} ${p.rel}:${p.line}${bits.length ? ` | ${bits.join(" ")}` : ""}`);
      }
      if (hits.length > offset + page.length) lines.push(`… next page: offset=${offset + page.length}`);
      return lines.join("\n");
    },
  },
  {
    name: "prefab_create",
    group: "scene",
    title: "Create a prefab",
    description:
      "Saves a prefab into <module>/Prefabs/<module>_prefabs.xml from a scene entity (from_scene + entity; its position is reset to the origin) or from <game_entity> XML. The editor loads module prefabs at startup (restart it to see new ones).",
    inputSchema: schema(
      {
        module: str("Writable module."),
        name: str("Prefab name (unique across modules)."),
        from_scene: str("Scene that contains the source entity."),
        entity: str("Handle or name of the entity in from_scene."),
        xml: str("Alternatively a complete <game_entity> element."),
        keep_position: bool("Keep the entity's position instead of moving it to the origin (default false)."),
        overwrite: bool("Replace an existing prefab with this name in the same module."),
      },
      ["module", "name"],
    ),
    handler: async (a, ctx) => {
      const mod = ctx.registry.requireWritable(a.req("module"));
      const name = a.req("name").trim();
      ctx.prefabs.ensure(ctx.registry.modules);
      const existing = ctx.prefabs.find(name);
      const mine = existing.filter((p) => p.module === mod.id);
      if (existing.length && !(mine.length && a.bool("overwrite", false))) {
        throw new Error(`A prefab named '${name}' already exists in ${existing.map((p) => p.module).join(", ")}${mine.length ? " (pass overwrite=true to replace yours)" : "; pick another name"}.`);
      }
      let xml: string;
      if (a.str("xml")) xml = a.req("xml").trim();
      else {
        if (!a.str("from_scene") || !a.str("entity")) throw new Error("Give from_scene + entity, or xml.");
        const doc = new SceneDoc(resolveScene(ctx.registry, a.req("from_scene")).file);
        xml = doc.source(doc.find(a.req("entity")));
      }
      const wf = checkWellFormed(xml, 3);
      if (wf.length) throw new Error(`XML is not well-formed: line ${wf[0].line}: ${wf[0].message}`);
      xml = stripGuids(xml);
      if (parseTree(xml, 5).root?.name !== "game_entity") throw new Error("The prefab must be a <game_entity> element.");
      const exp = expandPrefabLinks(ctx, xml);
      xml = exp.xml;
      let root = parseTree(xml, 5).root!;
      xml = applyEdits(xml, setAttributesEdits(xml, root, [["name", name]]));
      root = parseTree(xml, 5).root!;
      const tr = root.children?.find((c) => c.name === "transform");
      if (tr && !a.bool("keep_position", false) && getAttr(tr, "position") !== undefined) xml = applyEdits(xml, setAttributesEdits(xml, tr, [["position", "0.000, 0.000, 0.000"]]));
      const file = mine.length ? mine[0].abs : path.join(mod.dir, "Prefabs", `${slug(mod.id)}_prefabs.xml`);
      const tx = ctx.history.begin("prefab_create", mod.id, `prefab ${name}`);
      const { seq } = await commitTx(ctx, tx, mod.id, () => {
        let text: string;
        let enc: ReturnType<typeof readTextFile>["encoding"] = "utf8";
        if (fs.existsSync(file)) {
          const tf = readTextFile(file);
          text = tf.text;
          enc = tf.encoding;
        } else text = '<?xml version="1.0" encoding="utf-8"?>\r\n<prefabs>\r\n</prefabs>\r\n';
        const proot = parseTree(text, 5).root;
        if (!proot || proot.name !== "prefabs") throw new Error(`${file} has no <prefabs> root.`);
        const old = mine.length ? proot.children?.find((c) => c.start === mine[0].start) : undefined;
        const layout = { eol: text.includes("\r\n") ? "\r\n" : "\n", unit: "\t" };
        const edit = old ? { ...removeElementEdit(text, old) } : null;
        text = applyEdits(text, edit ? [edit] : []);
        const proot2 = parseTree(text, 5).root!;
        text = applyEdits(text, [insertChildEdit(text, proot2, xml, layout)]);
        const chk = checkWellFormed(text, 1);
        if (chk.length) throw new Error(`Internal error: prefab file would be invalid (${chk[0].message}).`);
        tx.write(file, encodeText(text, enc));
      });
      ctx.prefabs.touch(mod);
      const notes = exp.expanded ? `\nExpanded ${exp.expanded} linked prefab instance(s) into full copies${exp.dropped ? ` (${exp.dropped} had per-child overrides that were dropped)` : ""}.` : "";
      return `${mine.length ? "Replaced" : "Created"} prefab '${name}' in ${path.relative(mod.dir, file)}.${notes}\nRestart the Modding Kit editor to use it there; scene_edit action=add prefab=${name} works immediately in files.${footer(seq)}`;
    },
  },
  {
    name: "asset_import",
    group: "assets",
    title: "Import asset sources",
    description:
      "Copies FBX meshes and textures (png/tga/dds/tif/psd/bmp/jpg) into <module>/AssetSources (the folder the Modding Kit editor imports from), checks them (FBX version, texture size, naming) and creates Assets/. Copying is not converting: new files become Assets/*.tpac only through the editor's Resource Browser → Import new asset; the result says what to do next, in which order (materials before FBX, with an editor restart in between) and whether the running editor has the module loaded. Folders are expanded (top level).",
    inputSchema: schema(
      {
        module: str("Writable module."),
        files: strList("Absolute paths of files or folders to import."),
        subfolder: str("Optional subfolder inside AssetSources."),
        normalize_names: bool("Lower-case names and replace spaces/special characters (default false)."),
        overwrite: bool("Replace files that already exist (files over 200 MB are replaced without backup)."),
        reimport: bool("Ask the running editor to re-convert replaced sources (default true). New files are converted only through the Resource Browser's Import new asset."),
      },
      ["module", "files"],
    ),
    handler: async (a, ctx) => {
      const mod = ctx.registry.requireWritable(a.req("module"));
      const files = a.list("files");
      if (!files.length) throw new Error("files is empty.");
      const tx = ctx.history.begin("asset_import", mod.id, `import ${files.length} asset source(s)`);
      const { result: res, seq } = await commitTx(ctx, tx, mod.id, () =>
        importSources(tx, mod, files, { subfolder: a.str("subfolder"), normalize: a.bool("normalize_names", false), overwrite: a.bool("overwrite", false) }),
      );
      const L: string[] = [];
      if (res.createdDirs.length) L.push(`Created folders: ${res.createdDirs.join(", ")}`);
      for (const c of res.copied) {
        const size = c.bytes > 1024 * 1024 ? `${(c.bytes / 1024 / 1024).toFixed(1)} MB` : `${(c.bytes / 1024).toFixed(0)} KB`;
        const info = [c.check.format, c.check.width ? `${c.check.width}x${c.check.height}` : ""].filter(Boolean).join(" ");
        L.push(`copied ${c.to} (${size}${info ? `, ${info}` : ""}) → editor creates Assets/${expectedPackage(c.to)}`);
        for (const n of c.check.notes) L.push(`    note: ${n}`);
      }
      for (const s of res.skipped) L.push(`skipped ${s}`);
      if (res.copied.length) {
        const fresh = res.copied.filter((c) => !c.replaced);
        const replaced = res.copied.filter((c) => c.replaced);
        L.push(`Copied ${res.copied.length} file(s) — nothing is converted yet. The editor turns sources into Assets/*.tpac only when you import them:`);
        if (fresh.length) {
          L.push(
            `  - ${fresh.length} new file(s): Resource Browser → ${mod.id} → Assets → right-click → Import new asset, select them (filter by type, e.g. *.png, and multi-select). editor_command action=console command=resource.show_resource_browser opens the browser. reimport_assets does NOT convert new files.`,
          );
        }
        if (replaced.length) L.push(`  - ${replaced.length} replaced file(s) of earlier imports: the editor re-converts those after reimport_assets (or on its next start).`);
        if (res.copied.some((c) => MESH_EXT.has(path.extname(c.to).toLowerCase()))) {
          L.push(
            "  - Order matters for FBX: their materials must exist before conversion. Create/import textures and materials first, RESTART the editor (it registers new material packages only at startup), then convert the FBX files — meshes converted earlier keep empty material slots, and the editor stalls on each of them while loading (asset_status reports them).",
          );
        }
        const running = gamePids().game;
        for (const pid of running) {
          const loaded = sessionDiagnostics(pid).modules;
          if (loaded && !loaded.some((m) => m.toLowerCase() === mod.id.toLowerCase())) {
            L.push(`  - The running editor (pid ${pid}) was started without ${mod.id} (loaded: ${loaded.join(", ")}); it cannot import into it until restarted with editor_launch modules=["${mod.id}"].`);
          }
        }
        if (replaced.length && a.bool("reimport", true)) {
          try {
            await liveCall(ctx, "reimport", {}, 8000);
            L.push("Asked the running editor to re-check modified sources.");
          } catch (e) {
            if (!(e instanceof BridgeUnavailable)) L.push(`The editor did not take the re-check request (${(e as Error).message.split("\n")[0]}); call editor_command action=reimport_assets once it is free (e.g. after closing an open dialog).`);
          }
        }
        L.push("After converting: asset_status checks the packages (missing materials, broken names); meshes from an FBX are named after its nodes — asset_search gives the exact names for scene_edit.");
      }
      return L.join("\n") + footer(seq);
    },
  },
  {
    name: "asset_status",
    group: "assets",
    title: "Asset import status",
    description:
      "Compares a module's AssetSources with the editor's imported packages (Assets/*.tpac): imported, pending (copied but never converted), stale (source changed after import) and orphaned packages, plus the meshes/materials/textures/physics shapes each package contains. Checks the packages like the editor will when loading them: sub-meshes without a material or with an unknown one, resource names corrupted with control characters, physics shapes without their mesh.",
    inputSchema: schema({ module: str("Module id."), details: bool("List the resources inside every package (default false: first 40).") }, ["module"]),
    readOnly: true,
    handler: (a, ctx) => {
      const mod = ctx.registry.require(a.req("module"));
      const st = assetStatus(mod);
      const L: string[] = [`${mod.id} assets — ${mod.dir}`];
      const count = (s: string): number => st.sources.filter((x) => x.state === s).length;
      L.push(`AssetSources: ${st.sources.length} file(s) — ${count("imported")} imported, ${count("pending")} pending, ${count("stale")} stale`);
      for (const s of st.sources.filter((x) => x.state !== "imported").slice(0, 40)) L.push(`  ${s.state.toUpperCase()} ${s.rel}${s.packages.length ? ` (package ${s.packages.join(", ")})` : ` (expects Assets/${expectedPackage(s.rel)})`}`);
      const kinds = new Map<string, number>();
      for (const p of st.packages) for (const r of p.resources) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
      L.push(`Assets/: ${st.packages.length} package(s), ${(st.packages.reduce((s, p) => s + p.size, 0) / 1024 / 1024).toFixed(1)} MB; resources: ${[...kinds].map(([k, n]) => `${k}×${n}`).join(", ") || "none"}`);
      if (st.orphans.length) L.push(`Orphaned packages (source file missing): ${st.orphans.slice(0, 20).map((p) => p.rel).join(", ")}`);
      const show = a.bool("details", false) ? st.packages : st.packages.filter((p) => p.resources.some((r) => r.kind === "mesh" || r.kind === "physics_shape")).slice(0, 40);
      if (show.length) {
        L.push("Packages:");
        for (const p of show) {
          const by = new Map<string, string[]>();
          for (const r of p.resources) by.set(r.kind, [...(by.get(r.kind) ?? []), r.name]);
          L.push(`  ${p.rel} (${(p.size / 1024).toFixed(0)} KB): ${[...by].map(([k, n]) => `${k}: ${n.slice(0, 12).join(", ")}${n.length > 12 ? ` … (${n.length})` : ""}`).join(" | ")}`);
        }
      }
      const packed = fs.existsSync(path.join(mod.dir, "AssetPackages")) ? fs.readdirSync(path.join(mod.dir, "AssetPackages")).filter((f) => f.endsWith(".tpac")) : [];
      L.push(packed.length ? `AssetPackages/ (published, packed): ${packed.length} file(s)` : "AssetPackages/: none (the editor's Publish/pack step creates them for release)");
      ctx.assets.ensure(ctx.registry.modules);
      const problems = checkModulePackages(mod, ctx.assets);
      const issues = describePackageProblems(problems);
      L.push(
        `Package checks (${problems.packages} package(s), ${problems.meshes} mesh(es), ${problems.physicsShapes} physics shape(s)): ${issues.length ? "" : "OK — every sub-mesh has a known material, names are clean."}`,
        ...issues.map((l) => (l.startsWith("  ") ? l : `  - ${l}`)),
      );
      return L.join("\n");
    },
  },
  {
    name: "asset_search",
    group: "assets",
    title: "Search game resources",
    description:
      "Searches resource names inside every module's asset packages (vanilla AssetPackages and mod Assets): meshes, materials, textures, physics shapes, skeletons, animations, particle systems, shaders. Use the names in scenes (meta_mesh_component, physics shape), items (mesh=…) or materials.",
    inputSchema: schema(
      {
        query: str("Substring or /regex/ of the resource name."),
        kind: strEnum(RESOURCE_KINDS, "Resource kind filter."),
        module: str("Module filter (id, comma list, official, mods)."),
        limit: int("Max rows (default 50)."),
        offset: int("Skip rows."),
      },
      ["query"],
    ),
    readOnly: true,
    handler: (a, ctx) => {
      const mods = ctx.selectModules(a.str("module"));
      const t0 = Date.now();
      ctx.assets.ensure(mods);
      const kind = a.str("kind") as ResourceKind | undefined;
      if (kind && !RESOURCE_KINDS.includes(kind)) throw new Error(`kind must be one of ${RESOURCE_KINDS.join(", ")}`);
      const res = ctx.assets.search(a.req("query"), { kind, modules: new Set(mods.map((m) => m.id)), limit: a.int("limit", 50, 1, 500), offset: a.int("offset", 0, 0) });
      const lines = [`${res.total} resource(s) (scanned in ${Date.now() - t0} ms):`];
      for (const r of res.rows) lines.push(`${r.kind.padEnd(15)} ${displayName(r.name)} — ${r.module} ${r.file}`);
      if (!res.total) lines.push("Nothing found. Try a shorter query or another kind.");
      return lines.join("\n");
    },
  },
  {
    name: "editor_status",
    group: "editor",
    title: "Modding Kit editor status",
    description:
      "Shows whether the Modding Kit (scene editor) is installed, whether the MB2-MCP editor bridge module is installed and current, which Bannerlord processes run, message boxes that block the game (e.g. 'RGL WARNING', 'Safe Mode') and — if the bridge is connected — the editor state, open scene, entity and selection counts.",
    inputSchema: schema({}),
    readOnly: true,
    handler: async (_a, ctx) => {
      const g = ctx.registry.gameDir;
      const L: string[] = [];
      if (!g) return "Game folder not detected; set MB2_GAME_DIR.";
      const exe = editorExe(g);
      L.push(exe ? `Modding Kit: installed (${exe})` : "Modding Kit: NOT installed — Steam → Library → Tools → \"Mount & Blade II: Bannerlord - Modding Kit\".");
      L.push(`C# compiler for the bridge: ${findCsc() ?? "not found"}`);
      const st = bridgeInstallState(g);
      L.push(
        st.installed
          ? `Bridge module: installed v${st.version ?? "?"} at ${st.dir}${st.version !== BRIDGE_VERSION ? ` — outdated (current ${BRIDGE_VERSION}), run editor_bridge_install` : ""}${st.dllEditor ? "" : " — DLL missing, run editor_bridge_install"}`
          : "Bridge module: not installed (editor_bridge_install compiles it for your game version).",
      );
      const procs = gameProcesses();
      L.push(procs.length ? `Running: ${procs.map((p) => `${p.name} (pid ${p.pid}, ${p.memMb} MB)`).join(", ")}` : "Running: no Bannerlord process.");
      const { game, related } = gamePids();
      if (procs.some((p) => /crashuploader/i.test(p.name))) L.push("The crash uploader is running: the game hit an error and is preparing a crash report; answer its window.");
      for (const pid of game) {
        const d = sessionDiagnostics(pid);
        if (d.modules) L.push(`Modules loaded by pid ${pid}: ${d.modules.join(", ")}`);
        L.push(...describeSession(d, true).filter((l) => !l.startsWith("Crash watchdog"))); // blockingReport reports the watchdog
      }
      if (game.length && process.platform === "win32") {
        const auto = answeredSummary(readDialogLog(DIALOG_LOG()), game);
        if (auto) L.push(`${auto}; log ${DIALOG_LOG()}`);
        try {
          L.push(...(await blockingReport(ctx, game, related)));
        } catch (e) {
          L.push(`Windows and message boxes: not checked (${(e as Error).message.split("\n")[0]})`);
        }
      } else if (!game.length) {
        // Post-mortem of the last session: why it stalled or what it complained about.
        const last = latestSessionPid();
        const d = last ? sessionDiagnostics(last) : null;
        const lines = d ? describeSession(d, false) : [];
        if (d && lines.length) L.push(`Last game session (pid ${last}${d.modules ? `, modules ${d.modules.join(", ")}` : ""}):`, ...lines.map((l) => `  ${l}`));
      }
      const file = readBridgeStatus();
      if (!file) L.push("Bridge connection: none (no bridge.json — the editor with the bridge module is not running).");
      else if (!pidAlive(file.pid)) L.push(`Bridge connection: stale bridge.json (process ${file.pid} exited).`);
      else {
        try {
          const hello = await bridgeCall<{ bridge: string; lastTickMsAgo: number; busyWith?: string; busyMs?: number; lastLong?: string }>("hello", {}, 3000);
          L.push(`Bridge connection: OK on 127.0.0.1:${file.port}, bridge ${hello.bridge}, main thread ${hello.lastTickMsAgo < 0 ? "not ticking yet (still loading)" : `ticked ${hello.lastTickMsAgo} ms ago`}`);
          if (hello.busyWith) L.push(`Editor main thread: running '${hello.busyWith}' for ${Math.round((hello.busyMs ?? 0) / 1000)} s — later requests wait behind it; do not repeat it.`);
          if (hello.lastLong) L.push(`Last long bridge command: ${hello.lastLong}`);
          if (hello.bridge !== BRIDGE_VERSION) L.push(`The running bridge is ${hello.bridge}; this server ships ${BRIDGE_VERSION} — run editor_bridge_install while the editor is closed.`);
          const ping = await livePing(5000);
          if (ping) {
            L.push(`Editor: state ${ping.state ?? "?"}, edit mode ${ping.editMode ? "ON" : "off"}${ping.scene ? `, scene '${ping.scene}' with ${ping.entities} entities (${ping.rootEntities} root), ${ping.selected} selected` : ", no scene open"}`);
            if (ping.scene) {
              const file = editorSceneFile(ctx, ping.scene, ping.sceneFile);
              L.push(`Scene file: ${sceneFileLine(file, ping.sceneFile)}`);
              const unsaved = unsavedLiveEdits(ping.scene, file);
              if (unsaved) L.push(unsavedLine(unsaved));
            }
            if (ping.scene && ping.loaded === false) L.push(STILL_LOADING);
            if (ping.mission) L.push(missionLine(ping.mission));
            if (!ping.editMode && ping.state === "InitialState") L.push("Tip: editor_command action=enter_editor opens the scene editor from the main menu.");
          } else L.push("Editor: busy (no answer within 5 s).");
        } catch (e) {
          L.push(`Bridge connection: failed (${(e as Error).message})`);
        }
      }
      L.push(`Bridge folder: ${bridgeDir()}`);
      return L.join("\n");
    },
  },
  {
    name: "editor_bridge_install",
    group: "editor",
    title: "Install the editor bridge",
    description:
      "Compiles the MB2-MCP editor bridge (a small C# module) against your installed game with the Windows .NET compiler and installs it as Modules/MB2MCP.EditorBridge. Inside the Modding Kit editor it lets the live tools (scene_* live=true, editor_command) inspect and edit the open scene. Re-run after game updates.",
    inputSchema: schema({ force: bool("Recompile even if the current version is installed.") }),
    handler: async (a, ctx) => {
      const g = ctx.registry.gameDir;
      if (!g) throw new Error("Game folder not detected; set MB2_GAME_DIR.");
      if (ctx.config.readOnly) throw new Error("Read-only mode (MB2_READONLY): writes are disabled.");
      const st = bridgeInstallState(g);
      if (st.installed && st.version === BRIDGE_VERSION && st.dllEditor && !a.bool("force", false)) {
        return `The bridge ${BRIDGE_VERSION} is already installed at ${st.dir}. Pass force=true to recompile (e.g. after a game update).`;
      }
      const running = gameProcesses().filter((p) => /bannerlord/i.test(p.name));
      if (running.length && st.dllEditor) throw new Error(`Close the game/editor first (running: ${running.map((p) => p.name).join(", ")}); the DLL is locked while it runs.`);
      const tx = ctx.history.begin("editor_bridge_install", BRIDGE_MODULE_ID, `install editor bridge ${BRIDGE_VERSION}`);
      const { result, seq } = await commitTx(ctx, tx, BRIDGE_MODULE_ID, () => installBridge(ctx, tx));
      return [
        ...result.lines,
        "Next: editor_launch starts the Modding Kit with the bridge (and your module) loaded and opens the scene editor.",
        "Or start the Modding Kit yourself with 'MB2-MCP Editor Bridge' ticked in the mod list, then press Ctrl+E in the main menu.",
      ].join("\n") + footer(seq);
    },
  },
  {
    name: "editor_launch",
    group: "editor",
    title: "Start the Modding Kit editor",
    description:
      "Starts the Modding Kit build (bin/Win64_Shipping_wEditor/Bannerlord.exe) with the official singleplayer modules, the given modules and the editor bridge, and (open_editor=true) enters the scene editor automatically (with an empty scene; open yours in the editor). Loading usually takes 1–5 minutes; poll editor_status until it reports 'edit mode ON'. While it loads, 'RGL WARNING' message boxes about other mods' SubModule.xml entries (common with Workshop mods made for launcher extensions) are answered automatically with OK, together with the two prompts that follow each of them (the crash watchdog's 'collect necessary files?' → No, nothing is collected or uploaded; 'Always Ignore?' → Cancel, no setting changes) and the shader-cache notices ('Mod change detected').",
    inputSchema: schema({
      modules: strList("Your module ids to load (with their dependencies), e.g. [\"MyMod\"]."),
      open_editor: bool("Enter the scene editor automatically (default true; needs the bridge)."),
      dismiss_module_warnings: bool(
        "During the first 10 minutes press OK on module-metadata warnings, No/Cancel on the 'collect files?' and 'Always Ignore?' prompts that follow each of them, and OK on shader-cache notices (default true). Other message boxes are left for you; editor_status lists them.",
      ),
      decline_safe_mode: bool("If the game asks to start in Safe Mode after a crash, answer No (keeps your modules and the bridge loaded). Default false: the question is left to you."),
      ignore_asset_problems: bool("Start even when your modules' packages contain meshes without a material (the editor then stalls on a crash-watchdog dump for each while loading)."),
      force: bool("Start even if a Bannerlord process is already running."),
    }),
    handler: async (a, ctx) => {
      const g = ctx.registry.gameDir;
      if (!g) throw new Error("Game folder not detected; set MB2_GAME_DIR.");
      const running = gameProcesses().filter((p) => /^bannerlord/i.test(p.name));
      if (running.length && !a.bool("force", false)) throw new Error(`Bannerlord is already running (${running.map((p) => `${p.name} pid ${p.pid}`).join(", ")}). Use editor_status, or pass force=true.`);
      const set = new Map<string, ModuleInfo>();
      const launcher = ctx.registry.launcher;
      for (const m of ctx.registry.modules) {
        if (!m.official || m.category.toLowerCase() === "multiplayer") continue;
        const enabled = launcher ? launcher.enabled.has(m.id.toLowerCase()) : CORE_SP_MODULES.includes(m.id);
        if (enabled || CORE_SP_MODULES.includes(m.id)) set.set(m.id, m);
      }
      for (const id of a.list("modules")) for (const dep of ctx.registry.dependencyClosure(ctx.registry.require(id))) set.set(dep.id, dep);
      const st = bridgeInstallState(g);
      const bridge = ctx.registry.get(BRIDGE_MODULE_ID);
      const notes: string[] = [];
      if (bridge && st.dllEditor) set.set(bridge.id, bridge);
      else notes.push("The editor bridge is not installed (editor_bridge_install); live tools and automatic editor entry will not work.");
      const mods = ctx.registry.loadOrder([...set.values()]);
      // The game only loads modules found in <game>/Modules (plus subscribed Workshop items).
      const unreachable = mods.filter((m) => m.source === "extra" && !linkedIntoGame(g, m.dir));
      if (unreachable.length) {
        throw new Error(
          unreachable
            .map((m) => `Module '${m.id}' is in ${m.dir}, outside ${path.join(g, "Modules")}, so the game cannot load it. Link it into the game folder (no copy), then launch again:\n  mklink /J "${path.join(g, "Modules", path.basename(m.dir))}" "${m.dir}"`)
            .join("\n"),
        );
      }
      // Meshes without materials make the editor stop on a crash-watchdog dump for every one while loading.
      ctx.assets.ensure(ctx.registry.modules);
      const assetLines: string[] = [];
      let missingMaterials = 0;
      for (const m of mods.filter((x) => x.writable)) {
        const problems = checkModulePackages(m, ctx.assets);
        const lines = describePackageProblems(problems, 8);
        if (!lines.length) continue;
        missingMaterials += problems.nullMaterials.length;
        assetLines.push(`${m.id}:`, ...lines.map((l) => (l.startsWith("  ") ? `  ${l}` : `  - ${l}`)));
      }
      if (missingMaterials && !a.bool("ignore_asset_problems", false)) {
        throw new Error(
          [`Not starting: ${missingMaterials} sub-mesh(es) in the modules to load have no material.`, ...assetLines, "Fix or move those packages first (asset_status shows details), or pass ignore_asset_problems=true to start anyway."].join("\n"),
        );
      }
      if (assetLines.length) notes.push("Asset package problems (asset_status shows details):", ...assetLines);
      const openEditor = a.bool("open_editor", true) && !!(bridge && st.dllEditor);
      const res = launchEditor(ctx, mods, openEditor);
      if (res.pid && a.bool("dismiss_module_warnings", true) && process.platform === "win32") {
        try {
          fs.rmSync(DIALOG_LOG(), { force: true });
          const rules: Record<string, string> = { ...STARTUP_NOTICES, ...(a.bool("decline_safe_mode", false) ? { "Safe Mode": "No" } : {}) };
          await watchModuleWarnings(ctx.config.dataDir, res.pid, 600, DIALOG_LOG(), rules, MODULE_WARNING_FOLLOW_UPS);
          notes.push(
            `For 10 minutes, module-metadata warnings ('RGL WARNING' from SubModule.xml checks) are answered OK, the prompts that follow each of them No ('collect necessary files?': nothing is collected or uploaded) and Cancel ('Always Ignore?': no setting changes), shader-cache notices OK${a.bool("decline_safe_mode", false) ? ", and a Safe Mode question No" : ""}; editor_status reports what was answered. A crash prompt that does not follow a module warning is left to you.`,
          );
        } catch (e) {
          notes.push(`Could not start the warning watcher (${(e as Error).message.split("\n")[0]}); answer 'RGL WARNING' boxes in the game or with editor_command action=dismiss_dialogs.`);
        }
      }
      return [
        `Started ${res.exe} (pid ${res.pid ?? "?"})`,
        `Arguments: ${res.args.join(" ")}`,
        openEditor
          ? "The bridge enters the scene editor once the main menu is ready (usually 1–5 min: after a startup warning the game can sit idle for minutes while its crash watchdog analyses it). Poll editor_status until it reports 'edit mode ON'. The editor starts with an empty scene: open yours in the editor (File → Open) before using scene_* live=true."
          : "Press Ctrl+E in the main menu to open the scene editor.",
        ...notes,
      ].join("\n");
    },
  },
  {
    name: "editor_command",
    group: "editor",
    title: "Run an editor action",
    description:
      "Live actions in the running Modding Kit editor (needs the bridge): console (run a developer console command), list_commands (console commands by prefix; entries ending in '.' are groups such as 'scene.', 'resource.', 'prefab.' — list them with that prefix), check_scene (editor's scene problem check), reimport_assets (re-converts changed sources of earlier imports — new files need the Resource Browser's Import new asset), raycast (from/to or a position straight down → hit point), ground_height, warning (show a message in the editor), enter_editor (from the main menu), ping, quit (confirm=true; closes the game without saving). Also without the bridge: screenshot (captures the game window and returns the image; when the game is frozen or has no window yet, the message box blocking it), dialogs (the game's message boxes such as 'RGL WARNING', prompts Windows shows for it, the scene editor's modal Qt dialogs such as 'Do you want to save the scene?' with their texts, fields and buttons, and its other open windows), dismiss_dialogs (press OK, or `button`, on them; editor dialogs and file dialogs only with a named `button`) and fill_dialog (type into an editor dialog's input fields, set its check boxes and select a list/tree item — by label or #n — then read everything back; it never presses a button). With the bridge also: perf (frame times over `seconds`: average, percentiles, fps, plus the engine's main/renderer fps). cleanup deletes the screenshots, walk traces and dialog/bridge logs this server left in the bridge folder.",
    inputSchema: schema(
      {
        action: strEnum(
          ["screenshot", "console", "list_commands", "check_scene", "reimport_assets", "raycast", "ground_height", "warning", "enter_editor", "ping", "dialogs", "dismiss_dialogs", "fill_dialog", "perf", "cleanup", "quit"],
          "Action.",
        ),
        button: str(
          "dismiss_dialogs: button text or control id to press (default: OK, or the only button). 'OK', 'Cancel', 'Yes', 'No', 'Retry', 'Ignore', 'Close' also match Windows boxes in any language (e.g. 否(N)). Scene editor (Qt) dialogs and file dialogs are only answered with a named button. Dialogs without a matching button are left open.",
        ),
        title: str("dismiss_dialogs/fill_dialog: only dialogs whose title contains this text (e.g. 'RGL WARNING', 'Save Scene')."),
        fields: strMap("fill_dialog: input fields to set, by label, name or #1, #2 … in order, e.g. {\"Name\": \"my_scene_v2\"}."),
        check: strMap("fill_dialog: check boxes or radio buttons to set, by label, to true/false."),
        select: str("fill_dialog: text of a list or tree item to select (e.g. a module or scene name)."),
        seconds: int("perf: sampling time (default 5, max 120)."),
        confirm: bool("quit: must be true — closes the game; unsaved editor changes are lost."),
        command: str("console: the command line, e.g. 'help'."),
        prefix: str("list_commands: command prefix (default all)."),
        position: vecSchema("raycast/ground_height: [x, y, z] point to probe downwards from."),
        from: vecSchema("raycast: start point."),
        to: vecSchema("raycast: end point."),
        message: str("warning: text to show in the editor's warning panel."),
        source: strEnum(["window", "engine"], "screenshot: 'window' (default) captures the game/editor window including the editor UI and works without the bridge; 'engine' asks the renderer (needs the bridge; black while the scene editor is in front)."),
        path: str("screenshot: keep a full-resolution copy in this .png file (default: nothing is kept on disk)."),
        max_width: int("screenshot: width of the image returned to you (default 1280; the saved file keeps full size)."),
      },
      ["action"],
    ),
    handler: async (a, ctx): Promise<string | ToolOutput> => {
      const action = a.req("action");
      switch (action) {
        case "dialogs":
        case "dismiss_dialogs": {
          const { game, related: pids } = gamePids();
          if (!game.length) return "No Bannerlord process is running.";
          if (action === "dialogs") {
            const list = await listDialogs(ctx.config.dataDir, pids);
            const windows = (await listWindows(ctx.config.dataDir, game).catch(() => [] as GameWindow[])).filter((w) => w.cls !== "#32770" && w.title);
            const L: string[] = list.length
              ? [`${list.length} open message box(es):`, ...list.flatMap((d) => [`- ${dialogLine(d)}`, ...d.texts.map((t) => `  ${clip(t.replace(/\r/g, ""), 1500)}`)])]
              : ["The game shows no message box."];
            const rest = windows.filter((w) => !list.some((d) => d.hwnd === w.hwnd));
            if (rest.length) L.push(`Game windows: ${rest.map((w) => `'${w.title}' (${w.cls}, ${w.width}×${w.height}${w.hung ? ", NOT RESPONDING" : ""}${w.iconic ? ", minimized" : ""})`).join("; ")}`);
            return L.join("\n");
          }
          if (ctx.config.readOnly) throw new Error("Read-only mode (MB2_READONLY): dismissing game dialogs is disabled.");
          const done = await dismissDialogs(ctx.config.dataDir, pids, { button: a.str("button"), title: a.str("title") });
          if (!done.length) return "The game shows no message box (matching the filter).";
          const lines = done.map(
            (d) =>
              `- ${d.pressed ? `pressed '${d.pressed}'${d.closed ? "" : d.system ? " (still open: Windows shows this box with higher rights — answer it on screen)" : " (still open)"}` : (d.qt || d.fileDialog) && !a.str("button") ? "left open (editor dialogs are only answered with a named button, e.g. button='Cancel')" : "left open (no matching button)"}: ${dialogLine(d)}`,
          );
          const after = await listDialogs(ctx.config.dataDir, pids).catch(() => []);
          if (after.length) lines.push(`${after.length} message box(es) now open — the game may show the next one; call again or check editor_status.`);
          return lines.join("\n");
        }
        case "fill_dialog": {
          const { game, related } = gamePids();
          if (!game.length) return "No Bannerlord process is running.";
          if (ctx.config.readOnly) throw new Error("Read-only mode (MB2_READONLY): filling game dialogs is disabled.");
          const fields = a.map("fields");
          const checks = a.map("check").map(([k, v]) => [k, /^(true|1|yes|on)$/i.test(v.trim())] as [string, boolean]);
          if (!fields.length && !checks.length && !a.str("select")) throw new Error("Give fields, check and/or select.");
          const r = await fillDialog(ctx.config.dataDir, related, { title: a.str("title"), fields, checks, select: a.str("select") });
          const L = [`Dialog '${r.title}' (window ${r.hwnd}):`];
          for (const x of r.applied) L.push(`- ${x.kind === "F" ? "field" : x.kind === "C" ? "check" : "select"} ${x.kind === "S" ? `'${x.value || x.key}'` : `'${x.key}' = '${x.value}'`}: ${x.outcome}`);
          if (r.fields.length) L.push(`Now: ${r.fields.map((f) => `${f.label || "(unlabeled)"}=${f.kind === "check" || f.kind === "radio" ? f.value : `'${f.value}'`}${f.disabled ? " (disabled)" : ""}`).join("; ")}`);
          const sel = r.items.filter((i) => i.selected).map((i) => i.text);
          if (sel.length) L.push(`Selected: ${sel.join(", ")}`);
          if (r.applied.some((x) => /^no list or tree item/.test(x.outcome)) && r.items.length) L.push(`Items: ${r.items.slice(0, 60).map((i) => i.text).join(" | ")}${r.items.length > 60 ? " | …" : ""}`);
          L.push("Nothing was pressed: confirm with editor_command action=dismiss_dialogs button=<OK/Save/…> once the values are right.");
          return L.join("\n");
        }
        case "perf": {
          type Perf = { id: number; status: string; seconds: number; scene?: string; camera?: { position: number[] }; result?: Record<string, number> };
          const seconds = a.int("seconds", 5, 1, 120);
          let p = await liveCall<Perf>(ctx, "perf", { action: "start", seconds }, 10000);
          const end = Date.now() + (seconds + 30) * 1000;
          while (p.status === "running" && Date.now() < end) {
            await new Promise((r) => setTimeout(r, 1000));
            try {
              p = await bridgeCall<Perf>("perf", { action: "status" }, 5000);
            } catch {
              /* busy frame */
            }
          }
          const r = p.result;
          if (!r) return `The frame-time sample did not finish within ${seconds + 30} s (the editor is busy); try editor_command action=perf again.`;
          return [
            `Frame times over ${r.seconds} s in '${p.scene ?? "?"}'${p.camera ? ` (camera at ${fmtV(p.camera.position)})` : ""}: ${r.frames} frames, average ${r.avgMs} ms (${r.fps} fps), median ${r.p50Ms} ms, 95% ${r.p95Ms} ms, 99% ${r.p99Ms} ms, worst ${r.maxMs} ms.`,
            r.engineFps !== undefined ? `Engine counters: fps ${r.engineFps}, main thread ${r.mainFps ?? "?"}, renderer ${r.rendererFps ?? "?"}.` : "",
            "Compare runs with the same camera, scene state and window focus: the editor can lower its frame rate while it is not the active window (editor_config.reduce_framerate_when_inactive).",
          ]
            .filter(Boolean)
            .join("\n");
        }
        case "ping": {
          const st = await liveCall<LiveStatus>(ctx, "ping", {}, 5000);
          return JSON.stringify(st, null, 1);
        }
        case "enter_editor":
          return String(await liveCall(ctx, "enter_editor", {}, 15000));
        case "quit": {
          const scene = await openSceneSummary(ctx);
          if (!a.bool("confirm", false)) throw new Error(`quit closes the game and discards unsaved editor changes. ${scene} Save in the editor first if needed, then call again with confirm=true.`);
          return `${String(await liveCall(ctx, "quit", { confirm: true }, 15000))}\n${scene}`;
        }
        case "console": {
          const st = readBridgeStatus();
          const mark = st ? logMark(st.pid) : null;
          const out = String(await liveCall(ctx, "console", { command: a.req("command") }, 30000)) || "(no output)";
          if (!st || !mark) return out;
          await new Promise((r) => setTimeout(r, 500)); // the game flushes its log asynchronously
          const added = logSince(st.pid, mark, 30);
          const hints = messageHints(added);
          return added.length
            ? [`${out}`, 'Engine log while it ran (a reply like "Done" does not prove the work happened — read this):', ...added.map((l) => `  ${l}`), ...hints.map((h) => `Note: ${h}`)].join("\n")
            : `${out}\n(nothing new in the engine log)`;
        }
        case "list_commands": {
          const list = await liveCall<string[]>(ctx, "commands", { prefix: a.str("prefix") ?? "" }, 30000);
          return list.length ? `${list.length} command(s):\n${list.join("\n")}` : "No commands with that prefix.";
        }
        case "check_scene":
          try {
            return String(await liveCall(ctx, "check", {}, 120000));
          } catch (e) {
            if (/still running on the main thread/.test((e as Error).message)) {
              return "check_scene is still running on the editor's main thread (large scenes take minutes). Its findings go to the editor's warning panel and the game log; editor_status shows when the editor answers again. Do not start it twice.";
            }
            throw e;
          }
        case "reimport_assets":
          return `${String(await liveCall(ctx, "reimport", {}, 60000))}
This re-converts changed sources of earlier imports only. New files need Resource Browser → Import new asset; material packages created in this session are registered at the next editor start.`;
        case "warning":
          await liveCall(ctx, "warning", { message: a.req("message") }, 10000);
          return "Shown in the editor.";
        case "raycast":
        case "ground_height": {
          const args: Record<string, unknown> = {};
          const from = vecArg(a, "from");
          if (from) {
            args.from = from;
            args.to = vecArg(a, "to") ?? [from[0], from[1], from[2] - 3000];
          } else args.position = vecArg(a, "position") ?? [0, 0, 0];
          const r = await liveCall<{ hit: boolean; distance?: number; point?: number[] }>(ctx, "raycast", args, 15000);
          return r.hit ? `hit at ${fmtV(r.point!)} (distance ${fmtNum(r.distance!)})` : "no hit";
        }
        case "screenshot": {
          const keep = a.str("path");
          if (ctx.config.readOnly && keep) throw new Error("Read-only mode: custom screenshot paths are disabled.");
          if (keep && !/\.png$/i.test(keep)) throw new Error("path must name a .png file.");
          // Without a path nothing is kept: the image goes to the client and the temporary file is deleted.
          const target = keep ? path.resolve(keep) : path.join(bridgeDir(), `screenshot-tmp-${process.pid}-${Date.now()}.png`);
          const kept = keep ? `saved: ${target}` : "not kept on disk (pass path=<file>.png to save a copy)";
          try {
            const maxW = a.int("max_width", 1280, 160, 4096);
            const source = a.str("source") ?? "window";
            if (source !== "window" && source !== "engine") throw new Error("source must be 'window' or 'engine'.");
            const notes: string[] = [];
            if (source === "window") {
              const st = readBridgeStatus();
              const { game, related } = gamePids();
              const live = st && pidAlive(st.pid) ? st : null;
              if (!live && !game.length) throw new Error("No Bannerlord process is running.");
              const pids = [...new Set([...(live ? [live.pid] : []), ...related])];
              const preview = target.replace(/\.[^.\\/]*$/, "") + ".preview.png";
              try {
                const cap = await captureGameWindow(ctx.config.dataDir, pids, target, preview, maxW);
                const png = fs.readFileSync(preview);
                fs.rmSync(preview, { force: true });
                if (!cap.dark || !live) {
                  const what = cap.source.startsWith("window")
                    ? `Screenshot of the game window '${cap.title}'${cap.mainHung ? " — NOT RESPONDING, this is its last frame" : ""}`
                    : `The game window is frozen, minimized or not shown yet; this is the ${cap.source.replace(" (screen copy)", "")} '${cap.title}' that blocks it`;
                  const copied = cap.source.includes("screen copy") ? `, copied from the screen${cap.masked ? `; ${cap.masked} window(s) of other programs over it blacked out` : ""}` : "";
                  return {
                    text: `${what} (${cap.width}×${cap.height}, shown at ${cap.smallWidth}×${cap.smallHeight}${copied}); ${kept}${cap.dark ? "\nThe image is almost black — the window may be minimized, covered by exclusive fullscreen, or still loading." : ""}`,
                    images: [{ data: png.toString("base64"), mimeType: "image/png" }],
                  };
                }
                notes.push("The window capture came out black (exclusive fullscreen?); this is the engine's own render.");
              } catch (e) {
                fs.rmSync(preview, { force: true });
                if (!live) throw e;
                notes.push(`Window capture failed (${(e as Error).message}); this is the engine's own render.`);
              }
            }
            const shot = await engineScreenshot(ctx, target, maxW, kept);
            return typeof shot === "string" ? [shot, ...notes].join("\n") : { ...shot, text: [shot.text, ...notes].join("\n") };
          } finally {
            if (!keep) fs.rmSync(target, { force: true });
          }
        }
        case "cleanup": {
          const dir = bridgeDir();
          const { files, bytes } = cleanupOwnFiles(dir);
          return files
            ? `Deleted ${files} file(s), ${(bytes / 1024 / 1024).toFixed(1)} MB, from ${dir} (screenshots, walk traces, dialog and bridge logs). Edit history and backups are kept — forget_history removes them.`
            : `Nothing to delete in ${dir}.`;
        }
        default:
          throw new Error(`Unknown action '${action}'.`);
      }
    },
  },
];
