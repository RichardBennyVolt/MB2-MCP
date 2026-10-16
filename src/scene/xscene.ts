import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ModuleInfo, ModuleRegistry } from "../model/modules.js";
import { encodeText, readTextFile, type TextEncodingKind } from "../util/text.js";
import {
  applyEdits,
  detectIndentUnit,
  elementSource,
  insertAfterEdit,
  insertBeforeEdit,
  insertChildEdit,
  removeElementEdit,
  replaceElementEdit,
  setAttributesEdits,
  type Edit,
} from "../xml/edit.js";
import { childElements, escapeAttr, firstChild, getAttr, parseTree, type XElem } from "../xml/scanner.js";
import { checkWellFormed } from "../xml/wellformed.js";
import { isDirEntry } from "../util/fsx.js";

// ---------------------------------------------------------------------------------------------
// Scene discovery: Modules/<Mod>/SceneObj/<scene>/scene.xscene
// ---------------------------------------------------------------------------------------------

export interface SceneRef {
  name: string;
  module: ModuleInfo;
  dir: string;
  file: string;
  size: number;
  mtimeMs: number;
}

export function listScenes(mods: ModuleInfo[]): SceneRef[] {
  const out: SceneRef[] = [];
  for (const mod of mods) {
    const root = path.join(mod.dir, "SceneObj");
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!isDirEntry(e, path.join(root, e.name))) continue;
      const file = path.join(root, e.name, "scene.xscene");
      try {
        const st = fs.statSync(file);
        out.push({ name: e.name, module: mod, dir: path.join(root, e.name), file, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* not a scene folder (e.g. Backups) */
      }
    }
  }
  return out;
}

/** Resolves "scene", "Module/scene", "Module:scene" or a path to a scene folder / scene.xscene. */
export function resolveScene(registry: ModuleRegistry, spec: string, moduleHint?: string): SceneRef {
  const s = spec.trim();
  if (!s) throw new Error("Missing scene name.");
  if (/[\\/]/.test(s) && (s.toLowerCase().endsWith(".xscene") || fs.existsSync(path.join(s, "scene.xscene")))) {
    const file = s.toLowerCase().endsWith(".xscene") ? path.resolve(s) : path.resolve(s, "scene.xscene");
    const mod = registry.modules.find((m) => file.toLowerCase().startsWith(path.resolve(m.dir).toLowerCase() + path.sep));
    if (!mod) throw new Error(`${file} is not inside a known module.`);
    const st = fs.statSync(file);
    return { name: path.basename(path.dirname(file)), module: mod, dir: path.dirname(file), file, size: st.size, mtimeMs: st.mtimeMs };
  }
  let modSpec = moduleHint;
  let name = s;
  const m = /^([^\\/:]+)[\\/:]([^\\/:]+)$/.exec(s);
  if (m && registry.get(m[1])) {
    modSpec = m[1];
    name = m[2];
  }
  const mods = modSpec ? [registry.require(modSpec)] : registry.modules;
  const hits = listScenes(mods).filter((r) => r.name.toLowerCase() === name.toLowerCase());
  if (!hits.length) {
    const similar = listScenes(mods)
      .filter((r) => r.name.toLowerCase().includes(name.toLowerCase()))
      .slice(0, 10)
      .map((r) => `${r.module.id}/${r.name}`);
    throw new Error(`Scene '${name}' not found${modSpec ? ` in ${modSpec}` : ""}.${similar.length ? ` Similar: ${similar.join(", ")}` : " Use scene_list."}`);
  }
  if (hits.length === 1) return hits[0];
  const writable = hits.filter((h) => h.module.writable);
  if (writable.length === 1) return writable[0];
  throw new Error(`Scene '${name}' exists in several modules (${hits.map((h) => h.module.id).join(", ")}); write it as Module/${name}.`);
}

// ---------------------------------------------------------------------------------------------
// Vector / transform helpers (scene files store radians with three decimals)
// ---------------------------------------------------------------------------------------------

export type Vec3 = [number, number, number];

export function parseVec(v: string | undefined, n = 3): number[] | undefined {
  if (v === undefined) return undefined;
  const parts = v.split(",").map((x) => parseFloat(x.trim()));
  if (parts.length < n || parts.slice(0, n).some((x) => !Number.isFinite(x))) return undefined;
  return parts;
}

export function fmtNum(n: number): string {
  const s = (Math.abs(n) < 0.0005 ? 0 : n).toFixed(3);
  return s === "-0.000" ? "0.000" : s;
}

export function fmtVec(v: number[]): string {
  return v.map(fmtNum).join(", ");
}

export const DEG = Math.PI / 180;

interface Mat {
  s: Vec3;
  f: Vec3;
  u: Vec3;
}

const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

/** Same order as TaleWorlds.Library.Mat3.ApplyEulerAngles: up (z), then side (x), then forward (y). */
export function eulerToMat(e: number[]): Mat {
  let s: Vec3 = [1, 0, 0];
  let f: Vec3 = [0, 1, 0];
  let u: Vec3 = [0, 0, 1];
  const rot = (a: Vec3, b: Vec3, ang: number): [Vec3, Vec3] => {
    const c = Math.cos(ang);
    const sn = Math.sin(ang);
    return [add3(mul3(a, c), mul3(b, sn)), add3(mul3(b, c), mul3(a, -sn))];
  };
  [s, f] = rot(s, f, e[2] ?? 0);
  [f, u] = rot(f, u, e[0] ?? 0);
  [u, s] = rot(u, s, e[1] ?? 0);
  return { s, f, u };
}

export interface Frame {
  m: Mat;
  scale: Vec3;
  origin: Vec3;
}

export const IDENTITY_FRAME: Frame = { m: { s: [1, 0, 0], f: [0, 1, 0], u: [0, 0, 1] }, scale: [1, 1, 1], origin: [0, 0, 0] };

export function frameOf(position?: number[], rotation?: number[], scale?: number[]): Frame {
  return { m: eulerToMat(rotation ?? [0, 0, 0]), scale: [scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1], origin: [position?.[0] ?? 0, position?.[1] ?? 0, position?.[2] ?? 0] };
}

/** World position of a point given in the frame's local space. */
export function transformPoint(fr: Frame, p: number[]): Vec3 {
  const { s, f, u } = fr.m;
  const x = (p[0] ?? 0) * fr.scale[0];
  const y = (p[1] ?? 0) * fr.scale[1];
  const z = (p[2] ?? 0) * fr.scale[2];
  return [fr.origin[0] + s[0] * x + f[0] * y + u[0] * z, fr.origin[1] + s[1] * x + f[1] * y + u[1] * z, fr.origin[2] + s[2] * x + f[2] * y + u[2] * z];
}

// ---------------------------------------------------------------------------------------------
// Scene document
// ---------------------------------------------------------------------------------------------

export interface EntityNode {
  el: XElem;
  /** Positional handle: "12" for the 13th root entity, "12/0" for its first child entity. */
  handle: string;
  depth: number;
  parent?: EntityNode;
}

export interface EntitySummary {
  handle: string;
  name?: string;
  prefab?: string;
  oldPrefab?: string;
  childIndex?: string;
  position?: number[];
  rotation?: number[];
  scale?: number[];
  quaternion?: string;
  world?: Vec3;
  tags: string[];
  scripts: string[];
  meshes: string[];
  physics?: string;
  children: number;
  line: number;
  depth: number;
}

const BEFORE_TRANSFORM = new Set(["flags", "visibility_masks", "tags", "levels"]);

export class SceneDoc {
  text: string;
  encoding: TextEncodingKind;
  eol: "\r\n" | "\n";
  root!: XElem;
  unit = "\t";
  private flat: EntityNode[] | null = null;

  constructor(readonly file: string) {
    const tf = readTextFile(file);
    this.text = tf.text;
    this.encoding = tf.encoding;
    this.eol = tf.eol;
    this.parse();
  }

  private parse(): void {
    const { root, errors } = parseTree(this.text, 20);
    if (!root || root.name !== "scene") throw new Error(`${this.file} is not a scene file (${errors[0]?.message ?? `root <${root?.name}>`}).`);
    this.root = root;
    this.unit = detectIndentUnit(this.text, root);
    this.flat = null;
  }

  get name(): string {
    return getAttr(this.root, "name") ?? path.basename(path.dirname(this.file));
  }

  entitiesEl(): XElem | undefined {
    return firstChild(this.root, "entities");
  }

  /** Entities in document order. */
  entities(): EntityNode[] {
    if (this.flat) return this.flat;
    const out: EntityNode[] = [];
    const visit = (container: XElem | undefined, prefix: string, depth: number, parent?: EntityNode): void => {
      let i = 0;
      for (const c of childElements(container, "game_entity")) {
        const node: EntityNode = { el: c, handle: prefix ? `${prefix}/${i}` : String(i), depth, parent };
        out.push(node);
        visit(firstChild(c, "children"), node.handle, depth + 1, node);
        i++;
      }
    };
    visit(this.entitiesEl(), "", 0);
    this.flat = out;
    return out;
  }

  /** Finds an entity by handle ("12", "12/3", "#12") or exact name (first match). */
  find(ref: string): EntityNode {
    const r = ref.trim().replace(/^#/, "");
    const all = this.entities();
    if (/^\d+(\/\d+)*$/.test(r)) {
      const hit = all.find((n) => n.handle === r);
      if (hit) return hit;
      throw new Error(`No entity with handle ${r} (the scene has ${all.filter((n) => n.depth === 0).length} root entities).`);
    }
    const byName = all.filter((n) => getAttr(n.el, "name") === r);
    if (byName.length) return byName[0];
    const ci = all.filter((n) => (getAttr(n.el, "name") ?? "").toLowerCase() === r.toLowerCase());
    if (ci.length) return ci[0];
    throw new Error(`No entity named '${r}'. Use scene_entities to list handles and names.`);
  }

  summary(node: EntityNode): EntitySummary {
    const el = node.el;
    const t = firstChild(el, "transform");
    return {
      handle: node.handle,
      name: getAttr(el, "name"),
      prefab: getAttr(el, "prefab"),
      oldPrefab: getAttr(el, "old_prefab_name") || undefined,
      childIndex: getAttr(el, "_index_"),
      position: parseVec(getAttr(t, "position")),
      rotation: parseVec(getAttr(t, "rotation_euler")),
      scale: parseVec(getAttr(t, "scale")),
      quaternion: getAttr(t, "rotation"),
      tags: childElements(firstChild(el, "tags"), "tag").map((x) => getAttr(x, "name") ?? "").filter(Boolean),
      scripts: childElements(firstChild(el, "scripts"), "script").map((x) => getAttr(x, "name") ?? "").filter(Boolean),
      meshes: childElements(firstChild(el, "components"), "meta_mesh_component").map((x) => getAttr(x, "name") ?? "").filter(Boolean),
      physics: getAttr(firstChild(el, "physics"), "shape"),
      children: childElements(firstChild(el, "children"), "game_entity").length,
      line: el.line,
      depth: node.depth,
    };
  }

  /** World-space frame of an entity (composes parent transforms). */
  worldFrame(node: EntityNode): Frame {
    const chain: EntityNode[] = [];
    for (let n: EntityNode | undefined = node; n; n = n.parent) chain.unshift(n);
    let fr: Frame = IDENTITY_FRAME;
    for (const n of chain) {
      const t = firstChild(n.el, "transform");
      const local = frameOf(parseVec(getAttr(t, "position")), parseVec(getAttr(t, "rotation_euler")), parseVec(getAttr(t, "scale")));
      const origin = transformPoint(fr, local.origin);
      const m: Mat = {
        s: sub(transformPoint(fr, local.m.s), fr.origin),
        f: sub(transformPoint(fr, local.m.f), fr.origin),
        u: sub(transformPoint(fr, local.m.u), fr.origin),
      };
      fr = { m: normalizeMat(m), scale: [local.scale[0] * len(m.s), local.scale[1] * len(m.f), local.scale[2] * len(m.u)], origin };
    }
    return fr;
  }

  source(node: EntityNode): string {
    return elementSource(this.text, node.el);
  }

  layout(): { eol: string; unit: string } {
    return { eol: this.eol, unit: this.unit };
  }

  apply(edits: Edit[]): void {
    if (!edits.length) return;
    this.text = applyEdits(this.text, edits);
    this.parse();
  }

  serialize(): Buffer {
    const problems = checkWellFormed(this.text, 3);
    if (problems.length) throw new Error(`Internal error: scene would not be well-formed (line ${problems[0].line}: ${problems[0].message}); nothing was written.`);
    return encodeText(this.text, this.encoding);
  }

  // ---- edit builders (offsets refer to the current text) -----------------------------------

  /** Edits that set position / rotation_euler / scale on an entity's <transform>. */
  transformEdits(node: EntityNode, t: { position?: number[]; rotation?: number[]; scale?: number[] }): Edit[] {
    const el = node.el;
    const tr = firstChild(el, "transform");
    const attrs: Array<[string, string | null]> = [];
    if (t.position) attrs.push(["position", fmtVec(t.position)]);
    if (t.rotation) {
      attrs.push(["rotation_euler", fmtVec(t.rotation)]);
      // Quaternion / matrix forms would override the euler angles.
      for (const k of ["rotation", "rotation_mat", "non_orthogonal_rotation_mat"]) if (getAttr(tr, k) !== undefined) attrs.push([k, null]);
    }
    if (t.scale) attrs.push(["scale", fmtVec(t.scale)]);
    if (!attrs.length) return [];
    if (tr) return setAttributesEdits(this.text, tr, attrs);
    const xml = `<transform${attrs.filter(([, v]) => v !== null).map(([k, v]) => ` ${k}="${escapeAttr(v!)}"`).join("")}/>`;
    return [this.insertInEntity(el, xml, (name) => !BEFORE_TRANSFORM.has(name))];
  }

  /** Inserts `xml` into an entity before the first child accepted by `before`, else as last child. */
  insertInEntity(el: XElem, xml: string, before: (childName: string) => boolean): Edit {
    const anchor = (el.children ?? []).find((c) => before(c.name));
    return anchor ? insertBeforeEdit(this.text, anchor, xml, this.layout()) : insertChildEdit(this.text, el, xml, this.layout());
  }

  tagEdits(node: EntityNode, add: string[], remove: string[]): Edit[] {
    const el = node.el;
    const tagsEl = firstChild(el, "tags");
    const existing = childElements(tagsEl, "tag");
    const names = existing.map((t) => getAttr(t, "name") ?? "");
    const edits: Edit[] = [];
    const toRemove = existing.filter((t) => remove.includes(getAttr(t, "name") ?? ""));
    const toAdd = [...new Set(add)].filter((t) => t && !names.includes(t));
    if (tagsEl && toRemove.length === existing.length && toRemove.length > 0 && !toAdd.length) return [removeElementEdit(this.text, tagsEl)];
    for (const t of toRemove) edits.push(removeElementEdit(this.text, t));
    if (toAdd.length) {
      const lines = toAdd.map((t) => `<tag name="${escapeAttr(t)}"/>`);
      if (tagsEl) edits.push(insertChildEdit(this.text, tagsEl, lines.join("\n"), this.layout()));
      else edits.push(this.insertInEntity(el, `<tags>\n${lines.map((l) => `\t${l}`).join("\n")}\n</tags>`, (n) => n !== "flags" && n !== "visibility_masks"));
    }
    return edits;
  }

  /** Sets script variables: <scripts><script name=S><variables><variable name=V value=…/>. Creates missing pieces. */
  scriptEdits(node: EntityNode, script: string, vars: Array<[string, string]>): Edit[] {
    const el = node.el;
    const scripts = firstChild(el, "scripts");
    const sc = childElements(scripts, "script").find((s) => getAttr(s, "name") === script);
    const varLines = (list: Array<[string, string]>): string => list.map(([k, v]) => `<variable name="${escapeAttr(k)}" value="${escapeAttr(v)}"/>`).join("\n");
    if (!sc) {
      const block = `<script name="${escapeAttr(script)}">\n\t<variables>\n${varLines(vars)
        .split("\n")
        .map((l) => `\t\t${l}`)
        .join("\n")}\n\t</variables>\n</script>`;
      if (scripts) return [insertChildEdit(this.text, scripts, block, this.layout())];
      return [this.insertInEntity(el, `<scripts>\n${block.split("\n").map((l) => `\t${l}`).join("\n")}\n</scripts>`, (n) => n === "children")];
    }
    const varsEl = firstChild(sc, "variables");
    if (!varsEl) return [insertChildEdit(this.text, sc, `<variables>\n${varLines(vars).split("\n").map((l) => `\t${l}`).join("\n")}\n</variables>`, this.layout())];
    const edits: Edit[] = [];
    const missing: Array<[string, string]> = [];
    for (const [k, v] of vars) {
      const ve = childElements(varsEl, "variable").find((x) => getAttr(x, "name") === k);
      if (ve) edits.push(...setAttributesEdits(this.text, ve, [["value", v]]));
      else missing.push([k, v]);
    }
    if (missing.length) edits.push(insertChildEdit(this.text, varsEl, varLines(missing), this.layout()));
    return edits;
  }

  /** Inserts entity XML at the end of <entities> or of a parent's <children>. */
  insertEntityEdit(xml: string, parent?: EntityNode): Edit {
    if (parent) {
      const children = firstChild(parent.el, "children");
      if (children) return insertChildEdit(this.text, children, xml, this.layout());
      return insertChildEdit(this.text, parent.el, `<children>\n${xml.split("\n").map((l) => `\t${l}`).join("\n")}\n</children>`, this.layout());
    }
    const ents = this.entitiesEl();
    if (ents) return insertChildEdit(this.text, ents, xml, this.layout());
    const anchor = firstChild(this.root, "environment_properties") ?? firstChild(this.root, "levels");
    const block = `<entities>\n${xml.split("\n").map((l) => `\t${l}`).join("\n")}\n</entities>`;
    return anchor ? insertAfterEdit(this.text, anchor, block, this.layout()) : insertChildEdit(this.text, this.root, block, this.layout());
  }

  // ---- scene levels (<levels> in the root; entities list theirs in their own <levels>) --------------

  levelDefs(): Array<{ name: string; mask: number; el: XElem }> {
    return childElements(firstChild(this.root, "levels"), "level").map((el) => ({ name: getAttr(el, "name") ?? "", mask: Number(getAttr(el, "mask") ?? 0) || 0, el }));
  }

  /** Levels an entity belongs to (empty: no <levels>, i.e. every level). */
  entityLevels(node: EntityNode): string[] {
    return childElements(firstChild(node.el, "levels"), "level").map((l) => getAttr(l, "name") ?? "").filter(Boolean);
  }

  /** Adds/removes root level definitions; a new level gets the lowest free mask bit. */
  sceneLevelEdits(add: string[], remove: string[]): { edits: Edit[]; added: Array<[string, number]> } {
    const defs = this.levelDefs();
    const edits: Edit[] = [];
    for (const r of remove) {
      const d = defs.find((x) => x.name === r);
      if (!d) throw new Error(`Level '${r}' is not defined (defined: ${defs.map((x) => x.name).join(", ") || "none"}).`);
      const users = this.entities().filter((n) => this.entityLevels(n).includes(r)).length;
      if (users) throw new Error(`Level '${r}' is used by ${users} entit(ies); move them to other levels first (scene_edit action=update levels=[…]).`);
      edits.push(removeElementEdit(this.text, d.el));
    }
    let used = defs.filter((d) => !remove.includes(d.name)).reduce((m, d) => m | d.mask, 0);
    const added: Array<[string, number]> = [];
    for (const name of add) {
      if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Level names use letters, digits and '_' (got '${name}').`);
      if (defs.some((d) => d.name === name) && !remove.includes(name)) continue;
      let mask = 1;
      while (used & mask) mask *= 2;
      if (mask > 2 ** 30) throw new Error("No free level bit left.");
      used |= mask;
      added.push([name, mask]);
    }
    if (added.length) {
      const xml = added.map(([n, m]) => `<level name="${escapeAttr(n)}" mask="${m}"/>`).join("\n");
      const lv = firstChild(this.root, "levels");
      if (lv) edits.push(insertChildEdit(this.text, lv, xml, this.layout()));
      else {
        const block = `<levels>\n${xml.split("\n").map((l) => `\t${l}`).join("\n")}\n</levels>`;
        const after = firstChild(this.root, "flora_bounding_rect");
        const before = firstChild(this.root, "environment_properties") ?? firstChild(this.root, "entities");
        edits.push(after ? insertAfterEdit(this.text, after, block, this.layout()) : before ? insertBeforeEdit(this.text, before, block, this.layout()) : insertChildEdit(this.text, this.root, block, this.layout()));
      }
    }
    return { edits, added };
  }

  /** Sets the levels an entity belongs to; [] removes its <levels> (= every level). */
  entityLevelEdits(node: EntityNode, levels: string[]): Edit[] {
    const lv = firstChild(node.el, "levels");
    if (!levels.length) return lv ? [removeElementEdit(this.text, lv)] : [];
    const xml = `<levels>\n${levels.map((l) => `\t<level name="${escapeAttr(l)}"/>`).join("\n")}\n</levels>`;
    return lv ? [replaceElementEdit(this.text, lv, xml, this.layout())] : [insertChildEdit(this.text, node.el, xml, this.layout())];
  }

  // ---- <editor_data>: the editor's saved camera -----------------------------------------------------

  editorCamera(): { position?: number[]; forward?: number[]; attrs: Array<[string, string]> } {
    const ed = firstChild(this.root, "editor_data");
    const attrs = (["editor_camera_position", "editor_camera_forward", "editor_camera_elevation", "editor_camera_bearing"] as const)
      .map((k) => [k, getAttr(ed, k)] as [string, string | undefined])
      .filter((x): x is [string, string] => x[1] !== undefined);
    return { position: parseVec(getAttr(ed, "editor_camera_position")), forward: parseVec(getAttr(ed, "editor_camera_forward")), attrs };
  }

  editorDataEdits(attrs: Array<[string, string]>): Edit[] {
    const ed = firstChild(this.root, "editor_data");
    if (ed) return setAttributesEdits(this.text, ed, attrs);
    const xml = `<editor_data${attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("")}/>`;
    const after = firstChild(this.root, "terrain") ?? firstChild(this.root, "entities");
    return [after ? insertAfterEdit(this.text, after, xml, this.layout()) : insertChildEdit(this.text, this.root, xml, this.layout())];
  }

  /** Edits for <environment_properties><property name=… value=…/> (searched at any depth). */
  environmentEdits(props: Array<[string, string]>): { edits: Edit[]; missing: string[] } {
    const env = firstChild(this.root, "environment_properties");
    const edits: Edit[] = [];
    const missing: string[] = [];
    const all: XElem[] = [];
    const collect = (el: XElem | undefined): void => {
      for (const c of el?.children ?? []) {
        if (c.name === "property") all.push(c);
        else collect(c);
      }
    };
    collect(env);
    const add: string[] = [];
    for (const [k, v] of props) {
      const p = all.find((x) => getAttr(x, "name") === k);
      if (p) edits.push(...setAttributesEdits(this.text, p, [["value", v]]));
      else {
        missing.push(k);
        add.push(`<property name="${escapeAttr(k)}" value="${escapeAttr(v)}"/>`);
      }
    }
    if (add.length && env) {
      const firstGroup = (env.children ?? []).find((c) => c.name !== "property");
      edits.push(firstGroup ? insertBeforeEdit(this.text, firstGroup, add.join("\n"), this.layout()) : insertChildEdit(this.text, env, add.join("\n"), this.layout()));
    }
    return { edits, missing };
  }
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function len(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]) || 1;
}

function normalizeMat(m: Mat): Mat {
  return { s: mul3(m.s, 1 / len(m.s)), f: mul3(m.f, 1 / len(m.f)), u: mul3(m.u, 1 / len(m.u)) };
}

/** A saved editor camera looking (almost) straight up or down; the next open of the scene can show a black viewport. */
export function verticalCamera(forward: number[] | undefined): boolean {
  if (!forward || forward.length < 3) return false;
  const l = Math.hypot(forward[0], forward[1], forward[2]);
  return l > 0 && Math.abs(forward[2] / l) > 0.985;
}

/**
 * Siege spawner scripts. The editor builds a spawner's preview by instantiating the prefab named after the
 * entity minus its last "_part" (SpawnerEntityEditorHelper.GetPrefabName: "ballista_a_spawner" → "ballista_a");
 * any other name makes it instantiate a missing prefab and crash while loading the scene.
 */
export const SPAWNER_SCRIPT = /^(Multiplayer|Ship)?(Fire)?(Ballista|BatteringRam|Mangonel|SiegeLadder|SiegeTower|Trebuchet)Spawner$/;

/** Why `name` cannot name a siege spawner entity (null when fine). */
export function spawnerNameProblem(name: string, script: string, prefabExists: (p: string) => boolean): string | null {
  const us = name.lastIndexOf("_");
  const prefab = us > 0 ? name.slice(0, us) : "";
  if (prefab && us < name.length - 1 && prefabExists(prefab)) return null;
  return `'${name}' cannot name a ${script} entity: the editor instantiates the prefab named like the entity minus its last '_part' (${prefab ? `'${prefab}', which does not exist` : "nothing here"}) and crashes loading the scene. Keep '<prefab>_spawner' names (e.g. ballista_a_spawner) and label spawners with tags or a parent entity.`;
}

// ---------------------------------------------------------------------------------------------
// Building new entities
// ---------------------------------------------------------------------------------------------

export interface EntitySpec {
  name?: string;
  prefab?: string;
  mesh?: string;
  physics?: string;
  position?: number[];
  rotation?: number[];
  scale?: number[];
  tags?: string[];
  mobility?: "static" | "dynamic";
}

/** XML for a new entity, matching how the editor serializes prefab instances and mesh entities. */
export function buildEntityXml(spec: EntitySpec): string {
  const attrs: string[] = [];
  if (spec.name) attrs.push(`name="${escapeAttr(spec.name)}"`);
  if (spec.prefab) attrs.push(`prefab="${escapeAttr(spec.prefab)}"`);
  else attrs.push('old_prefab_name=""');
  if (spec.mobility === "dynamic") attrs.push('mobility="1"');
  const lines = [`<game_entity ${attrs.join(" ")}>`];
  if (spec.tags?.length) {
    lines.push("\t<tags>");
    for (const t of spec.tags) lines.push(`\t\t<tag name="${escapeAttr(t)}"/>`);
    lines.push("\t</tags>");
  }
  const t = [`position="${fmtVec(spec.position ?? [0, 0, 0])}"`, `rotation_euler="${fmtVec(spec.rotation ?? [0, 0, 0])}"`];
  if (spec.scale && spec.scale.some((x) => Math.abs(x - 1) > 1e-6)) t.push(`scale="${fmtVec(spec.scale)}"`);
  lines.push(`\t<transform ${t.join(" ")}/>`);
  if (!spec.prefab) {
    if (spec.physics) lines.push(`\t<physics shape="${escapeAttr(spec.physics)}"/>`);
    if (spec.mesh) lines.push("\t<components>", `\t\t<meta_mesh_component name="${escapeAttr(spec.mesh)}"/>`, "\t</components>");
  }
  lines.push("</game_entity>");
  return lines.join("\n");
}

export function newGuid(): string {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex").toUpperCase();
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}}`;
}

/** A new empty scene in the format the editor writes for "New Scene" (probe + ground plane, no terrain). */
export function minimalSceneXml(name: string): string {
  return [
    '<?xml version="1.0"?>',
    `<scene name="${escapeAttr(name)}" version="2" unique_token="${newGuid()}" revision="${Date.now()}" id_automatic="true">`,
    '\t<flora_bounding_rect min="0.000, 0.000" max="0.000, 0.000"/>',
    "\t<levels>",
    '\t\t<level name="base" mask="1"/>',
    "\t</levels>",
    "\t<environment_properties>",
    '\t\t<property name="nav_mesh_auto_generated_" value="false"/>',
    '\t\t<property name="physics_world_min" value="-256.000, -256.000"/>',
    '\t\t<property name="physics_world_max_" value="256.000, 256.000"/>',
    '\t\t<property name="north_angle" value="0.000"/>',
    '\t\t<property name="is_indoors" value="false"/>',
    '\t\t<property name="disable_flora_billboards" value="false"/>',
    '\t\t<property name="ground_color" value="0.000, 0.000, 0.000"/>',
    '\t\t<property name="prt_multiplier" value="1.000"/>',
    '\t\t<property name="prt_point_light_multiplier" value="1.000"/>',
    '\t\t<property name="fog_start_distance" value="50.000"/>',
    '\t\t<property name="prt_color_contrast" value="1.000"/>',
    '\t\t<property name="scene_scale_multiplier" value="1.000"/>',
    '\t\t<property name="prt_intensity_contrast" value="1.000"/>',
    '\t\t<property name="prt_fallback_probe_index" value="-1, -1, -1"/>',
    '\t\t<property name="enforced_color_grade" value=""/>',
    '\t\t<property name="gi_data_exists" value="false"/>',
    "\t\t<atmosphere_properties>",
    '\t\t\t<property name="atmosphere_name" value="editor_default"/>',
    '\t\t\t<property name="wind_meters" value="7.714, 0.000"/>',
    '\t\t\t<property name="scene_fog_falloff_offset" value="0.000"/>',
    "\t\t</atmosphere_properties>",
    "\t</environment_properties>",
    "\t<entities>",
    '\t\t<game_entity name="envmap_probe" old_prefab_name="" mobility="1">',
    "\t\t\t<visibility_masks>",
    '\t\t\t\t<visibility_mask name="no_shadow" value="true"/>',
    '\t\t\t\t<visibility_mask name="visible_only_when_editing" value="true"/>',
    "\t\t\t</visibility_masks>",
    '\t\t\t<transform position="20.000, 0.000, 5.000" rotation_euler="0.000, 0.000, 0.000"/>',
    "\t\t\t<scripts>",
    '\t\t\t\t<script name="ReflectionCapturer">',
    "\t\t\t\t\t<variables>",
    '\t\t\t\t\t\t<variable name="IsGlobal" value="true"/>',
    '\t\t\t\t\t\t<variable name="IsParallaxCorrected" value="false"/>',
    '\t\t\t\t\t\t<variable name="AmbientMultiplier" value="1.000"/>',
    '\t\t\t\t\t\t<variable name="AttenuationCoef" value="20.000"/>',
    '\t\t\t\t\t\t<variable name="BoxOffset" value="0.000, 0.000, 0.000, 0.000"/>',
    "\t\t\t\t\t</variables>",
    "\t\t\t\t</script>",
    "\t\t\t</scripts>",
    "\t\t</game_entity>",
    '\t\t<game_entity name="ground_plane" old_prefab_name="">',
    '\t\t\t<transform position="10.000, 10.000, 1.000" rotation_euler="0.000, 0.000, 0.000" scale="20.000, 20.000, 20.000"/>',
    '\t\t\t<physics shape="bo_editor_plane"/>',
    "\t\t\t<components>",
    '\t\t\t\t<meta_mesh_component name="editor_plane_low"/>',
    "\t\t\t</components>",
    "\t\t</game_entity>",
    "\t</entities>",
    '\t<terrain enabled="false"/>',
    '\t<editor_data editor_camera_position="0.000, 0.000, 30.000" editor_camera_elevation="-0.432" editor_camera_bearing="0.073" editor_camera_forward="0.413, 0.487, -0.769" author="" comment=""/>',
    '\t<camera_data near_plane="0.100" far_plane="100000.000"/>',
    "\t<Paths/>",
    "</scene>",
    "",
  ].join("\r\n");
}

/** Rewrites name / unique_token of a copied scene so the engine treats it as a new scene. */
export function renameSceneText(text: string, name: string): string {
  const { root } = parseTree(text, 5);
  if (!root || root.name !== "scene") throw new Error("Template is not a scene file.");
  const changes: Array<[string, string | null]> = [["name", name]];
  if (getAttr(root, "unique_token") !== undefined) changes.push(["unique_token", newGuid()]);
  return applyEdits(text, setAttributesEdits(text, root, changes));
}

// ---------------------------------------------------------------------------------------------
// Atmosphere files: <atmosphere><values><value name=… value=…/></values><fog>…</fog>…
// ---------------------------------------------------------------------------------------------

export function atmosphereEdits(text: string, values: Array<[string, string]>): { edits: Edit[]; missing: string[] } {
  const { root } = parseTree(text, 5);
  if (!root || root.name !== "atmosphere") throw new Error("atmosphere.xml has no <atmosphere> root.");
  const all: XElem[] = [];
  const collect = (el: XElem): void => {
    for (const c of el.children ?? []) {
      if (c.name === "value") all.push(c);
      collect(c);
    }
  };
  collect(root);
  const edits: Edit[] = [];
  const missing: string[] = [];
  const add: string[] = [];
  for (const [k, v] of values) {
    const el = all.find((x) => getAttr(x, "name") === k);
    if (el) edits.push(...setAttributesEdits(text, el, [["value", v]]));
    else {
      missing.push(k);
      add.push(`<value name="${escapeAttr(k)}" value="${escapeAttr(v)}"/>`);
    }
  }
  const valuesEl = firstChild(root, "values");
  if (add.length && valuesEl) edits.push(insertChildEdit(text, valuesEl, add.join("\n"), { eol: text.includes("\r\n") ? "\r\n" : "\n", unit: detectIndentUnit(text, root) }));
  return { edits, missing };
}

export function readAtmosphereValues(file: string): Array<[string, string]> {
  try {
    const { text } = readTextFile(file);
    const { root } = parseTree(text, 5);
    const out: Array<[string, string]> = [];
    const visit = (el: XElem | null | undefined): void => {
      for (const c of el?.children ?? []) {
        if (c.name === "value") out.push([getAttr(c, "name") ?? "", getAttr(c, "value") ?? ""]);
        visit(c);
      }
    };
    visit(root);
    return out;
  } catch {
    return [];
  }
}
