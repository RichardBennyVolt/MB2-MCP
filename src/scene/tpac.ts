import fs from "node:fs";
import path from "node:path";
import type { ModuleInfo } from "../model/modules.js";
import { isDirEntry } from "../util/fsx.js";

/**
 * Reader for the resource table of TaleWorlds asset packages (*.tpac), after the format notes of
 * TpacTool (https://github.com/szszss/TpacTool, MIT).
 *
 * Header (version 2): "TPAC" | u32 version | 16-byte package GUID | u32 resource count | u64 table size.
 * Each table record: [16-byte type GUID][16-byte resource GUID][u32 version][u32 length + name]
 * [u64 length + metadata][8 bytes][u32 count + 69-byte data segment headers][u32 count + 48-byte
 * dependencies]. Bulk data (vertices, pixels) follows the table, so reading the first
 * `36 + tableSize` bytes is enough — even for multi-GB vanilla packages. Packages whose table does
 * not parse are scanned for resource headers instead (names only).
 */

export type ResourceKind =
  | "mesh"
  | "physics_shape"
  | "texture"
  | "material"
  | "skeleton"
  | "animation"
  | "animation_clip"
  | "particle_system"
  | "shader"
  | "face_animation"
  | "source";

export const RESOURCE_KINDS: ResourceKind[] = ["mesh", "physics_shape", "texture", "material", "skeleton", "animation", "animation_clip", "particle_system", "shader", "face_animation", "source"];

const TYPE_GUIDS: Record<string, ResourceKind> = {
  "978b8fa07c19ea4bb95b53846cae834e": "mesh",
  "0e8e52e8b664614ebae07569c0452aea": "physics_shape",
  cbcb74c91c5ff6499a322b5b6c92c2e8: "texture",
  "9313b01d0269194f83bab37a39830717": "material",
  d5a335c6bbeadd45883eaa57e4196113: "skeleton",
  c809655063e5a44cb166a53b92e913a7: "animation",
  "07b0faba3f7e3f45bac6e7640043112b": "animation_clip",
  "674de16d9addbe4594630281c3d8dd51": "particle_system",
  df2865b44403f94f80f2e30cd6c4fcc3: "shader",
  "7bbab5ca8e8132448e3703e291d9b8c0": "face_animation",
  "7936ba3ebdde7a4c8634f121f6325e33": "source",
};

/** Data segment type of a mesh's editable geometry; its owner GUID marks a sub-mesh in the mesh metadata. */
const EDIT_SEGMENT = "5f98413dd224c14f82e46a6e0da3f4e2";
export const NULL_GUID = "0".repeat(32);
/** Engine materials that exist without a package. */
const BUILTIN_MATERIALS: Record<string, string> = { b4a4451041e9604daf2c5aa3d86b33f9: "water_default" };

export interface MaterialRef {
  submesh: string;
  /** Raw GUID (hex of the 16 stored bytes); NULL_GUID = no material. */
  guid: string;
}

export interface TpacResource {
  kind: ResourceKind;
  /** As stored — may contain control characters when the importer wrote a broken name (see displayName). */
  name: string;
  /** Raw resource GUID; absent when the table could only be scanned. */
  guid?: string;
  /** Sub-mesh material references (meshes, when read with meshMaterials). */
  materials?: MaterialRef[];
}

export interface TpacInfo {
  file: string;
  size: number;
  mtimeMs: number;
  count: number;
  resources: TpacResource[];
  /** "$BASE/Modules/<Mod>/AssetSources/…" paths recorded by the importer. */
  sources: string[];
  /** "table": records parsed; "scan": table layout not understood, names found by scanning. */
  parsed?: "table" | "scan";
  error?: string;
}

const MAX_TABLE = 256 * 1024 * 1024;

function hex(buf: Buffer, from: number, to: number): string {
  return buf.toString("hex", from, to);
}

/** "8-4-4-4-12" form of a raw (little-endian fields) GUID, as the editor and TpacTool print it. */
export function guidString(raw: string): string {
  const b = Buffer.from(raw, "hex");
  if (b.length !== 16) return raw;
  const h = (from: number, to: number, le: boolean): string => {
    const part = b.subarray(from, to);
    return (le ? Buffer.from(part).reverse() : part).toString("hex");
  };
  return `${h(0, 4, true)}-${h(4, 6, true)}-${h(6, 8, true)}-${h(8, 10, false)}-${h(10, 16, false)}`;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** True when an importer wrote a name with control characters (e.g. "bo_wall_0" + NUL). */
export function hasBrokenName(name: string): boolean {
  return CONTROL.test(name);
}

/** Printable form of a resource name: control characters as \xNN. */
export function displayName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/** Parses the record table; throws when the layout does not match (caller falls back to scanning). */
function parseTable(buf: Buffer, count: number, tableEnd: number, meshMaterials: boolean): TpacResource[] {
  let p = 36;
  const need = (n: number): void => {
    if (n < 0 || p + n > buf.length || p + n > tableEnd) throw new Error("record runs past the table");
  };
  const u32 = (): number => {
    need(4);
    const v = buf.readUInt32LE(p);
    p += 4;
    return v;
  };
  const u64 = (): number => {
    need(8);
    const v = buf.readBigUInt64LE(p);
    p += 8;
    if (v > BigInt(MAX_TABLE)) throw new Error("implausible length");
    return Number(v);
  };
  const out: TpacResource[] = [];
  for (let r = 0; r < count; r++) {
    need(32);
    const type = hex(buf, p, p + 16);
    const guid = hex(buf, p + 16, p + 32);
    p += 32;
    u32(); // resource version
    const nameLen = u32();
    if (nameLen > 4096) throw new Error("implausible name length");
    need(nameLen);
    const name = buf.toString("utf8", p, p + nameLen);
    p += nameLen;
    const metaLen = u64();
    need(metaLen);
    const meta = buf.subarray(p, p + metaLen);
    p += metaLen;
    need(8);
    p += 8;
    const segCount = u32();
    if (segCount > 1_000_000) throw new Error("implausible segment count");
    need(segCount * 69);
    const segments: { owner: Buffer; type: string }[] = [];
    for (let s = 0; s < segCount; s++) {
      segments.push({ owner: buf.subarray(p + 24, p + 40), type: hex(buf, p + 40, p + 56) });
      p += 69;
    }
    const deps = u32();
    if (deps > 1_000_000) throw new Error("implausible dependency count");
    need(deps * 48);
    p += deps * 48;
    const kind = TYPE_GUIDS[type];
    if (!kind) continue;
    const res: TpacResource = { kind, name, guid };
    if (meshMaterials && kind === "mesh") res.materials = meshMaterialRefs(meta, segments);
    out.push(res);
  }
  if (p !== tableEnd) throw new Error("table size mismatch");
  return out;
}

/**
 * Each editable sub-mesh has a data segment whose owner GUID appears in the mesh metadata, followed by
 * [u32 length + sub-mesh name][u32][u32 count + strings][16-byte material GUID].
 */
function meshMaterialRefs(meta: Buffer, segments: { owner: Buffer; type: string }[]): MaterialRef[] {
  const refs: MaterialRef[] = [];
  for (const seg of segments) {
    if (seg.type !== EDIT_SEGMENT) continue;
    const at = meta.indexOf(seg.owner);
    if (at < 0) continue;
    try {
      let q = at + 16;
      const str = (): string => {
        const n = meta.readUInt32LE(q);
        if (n > 4096 || q + 4 + n > meta.length) throw new Error("bad string");
        const s = meta.toString("utf8", q + 4, q + 4 + n);
        q += 4 + n;
        return s;
      };
      const submesh = str();
      q += 4;
      const n = meta.readUInt32LE(q);
      q += 4;
      if (n > 256) continue;
      for (let k = 0; k < n; k++) str();
      if (q + 16 > meta.length) continue;
      refs.push({ submesh, guid: hex(meta, q, q + 16) });
    } catch {
      /* layout not understood for this sub-mesh */
    }
  }
  return refs;
}

function isPrintable(buf: Buffer, from: number, len: number): boolean {
  for (let k = 0; k < len; k++) {
    const c = buf[from + k];
    if (c < 32 || c > 126) return false;
  }
  return true;
}

export function readTpac(file: string, opts: { meshMaterials?: boolean } = {}): TpacInfo {
  const st = fs.statSync(file);
  const info: TpacInfo = { file, size: st.size, mtimeMs: st.mtimeMs, count: 0, resources: [], sources: [] };
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(36);
    fs.readSync(fd, head, 0, 36, 0);
    if (head.toString("latin1", 0, 4) !== "TPAC") {
      info.error = "not a TPAC file";
      return info;
    }
    info.count = head.readUInt32LE(24);
    const table = head.readUInt32LE(28);
    const n = Math.min(st.size, 36 + Math.min(table, MAX_TABLE) + 64);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    try {
      if (head.readUInt32LE(4) !== 2 || head.readUInt32LE(32) !== 0 || 36 + table > n) throw new Error("unsupported header");
      info.resources = parseTable(buf, info.count, 36 + table, !!opts.meshMaterials);
      info.parsed = "table";
    } catch {
      info.resources = scanResources(buf, n);
      info.parsed = "scan";
    }
    // Source paths are length-prefixed strings starting with $BASE/.
    let at = buf.indexOf("$BASE/", 0, "latin1");
    while (at >= 4) {
      const len = buf.readUInt32LE(at - 4);
      if (len > 6 && len < 1024 && at + len <= n && isPrintable(buf, at, len)) {
        const s = buf.toString("latin1", at, at + len);
        if (!info.sources.includes(s)) info.sources.push(s);
      }
      at = buf.indexOf("$BASE/", at + 6, "latin1");
    }
  } catch (e) {
    info.error = (e as Error).message;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return info;
}

/** Fallback for tables that do not parse: find [type GUID][GUID][u32 0|1][u32 len][printable name] headers. */
function scanResources(buf: Buffer, n: number): TpacResource[] {
  const out: TpacResource[] = [];
  const seen = new Set<string>();
  for (let i = 68; i + 8 < n; i++) {
    const z = buf.readUInt32LE(i);
    if (z > 1) continue;
    const len = buf.readUInt32LE(i + 4);
    if (len < 1 || len > 200 || i + 8 + len > n) continue;
    const kind = TYPE_GUIDS[hex(buf, i - 32, i - 16)];
    if (!kind || !isPrintable(buf, i + 8, len)) continue;
    const name = buf.toString("latin1", i + 8, i + 8 + len);
    const key = `${kind}|${name}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ kind, name, guid: hex(buf, i - 16, i) });
    }
    i += 7 + len;
  }
  return out;
}

export interface CatalogEntry {
  kind: ResourceKind;
  name: string;
  module: string;
  /** Package file relative to the module folder. */
  file: string;
}

const PACKAGE_DIRS = ["AssetPackages", "Assets", "EmAssetPackages"];

function listTpacs(dir: string, out: string[], depth = 0): void {
  if (depth > 6) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (isDirEntry(e, p)) listTpacs(p, out, depth + 1);
    else if (e.name.toLowerCase().endsWith(".tpac")) out.push(p);
  }
}

/** Catalog of every resource name in every module's asset packages (cached by file mtime/size). */
export class AssetCatalog {
  private files = new Map<string, TpacInfo & { module: string; rel: string }>();
  private byName: Map<string, CatalogEntry[]> | null = null;
  private materials: Map<string, string> | null = null;
  private checked = new Map<string, number>();

  ensure(mods: ModuleInfo[], maxAgeMs = 60000): void {
    let changed = false;
    for (const mod of mods) {
      const last = this.checked.get(mod.dir) ?? 0;
      if (!mod.writable && Date.now() - last < maxAgeMs) continue;
      const found: string[] = [];
      for (const d of PACKAGE_DIRS) listTpacs(path.join(mod.dir, d), found);
      const keep = new Set(found.map((f) => f.toLowerCase()));
      for (const [k, v] of this.files) {
        if (v.module === mod.id && !keep.has(k)) {
          this.files.delete(k);
          changed = true;
        }
      }
      for (const f of found) {
        const key = f.toLowerCase();
        let st: fs.Stats;
        try {
          st = fs.statSync(f);
        } catch {
          continue;
        }
        const old = this.files.get(key);
        if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) continue;
        this.files.set(key, { ...readTpac(f), module: mod.id, rel: path.relative(mod.dir, f).split(path.sep).join("/") });
        changed = true;
      }
      this.checked.set(mod.dir, Date.now());
    }
    if (changed) {
      this.byName = null;
      this.materials = null;
    }
  }

  /** Material name for a raw GUID found in any scanned package (or an engine built-in). */
  materialName(guid: string): string | undefined {
    if (!this.materials) {
      const m = new Map<string, string>(Object.entries(BUILTIN_MATERIALS));
      for (const f of this.files.values()) for (const r of f.resources) if (r.kind === "material" && r.guid) m.set(r.guid, r.name);
      this.materials = m;
    }
    return this.materials.get(guid);
  }

  packages(moduleId?: string): Array<TpacInfo & { module: string; rel: string }> {
    return [...this.files.values()].filter((f) => !moduleId || f.module.toLowerCase() === moduleId.toLowerCase());
  }

  private index(): Map<string, CatalogEntry[]> {
    if (!this.byName) {
      const m = new Map<string, CatalogEntry[]>();
      for (const f of this.files.values()) {
        // Packages may hold many records with one name (e.g. 498 "bip01_notused" skeletons): list each once.
        const seen = new Set<string>();
        for (const r of f.resources) {
          if (seen.has(`${r.kind}|${r.name}`)) continue;
          seen.add(`${r.kind}|${r.name}`);
          const key = r.name.toLowerCase();
          const list = m.get(key);
          const entry = { kind: r.kind, name: r.name, module: f.module, file: f.rel };
          if (list) list.push(entry);
          else m.set(key, [entry]);
        }
      }
      this.byName = m;
    }
    return this.byName;
  }

  lookup(name: string, kind?: ResourceKind): CatalogEntry[] {
    const list = this.index().get(name.toLowerCase()) ?? [];
    return kind ? list.filter((e) => e.kind === kind) : list;
  }

  has(name: string, kinds: ResourceKind[]): boolean {
    return this.lookup(name).some((e) => kinds.includes(e.kind));
  }

  /** True once at least one package with resources of this kind was read (otherwise "unknown" ≠ "missing"). */
  knows(kind: ResourceKind): boolean {
    for (const list of this.index().values()) if (list.some((e) => e.kind === kind)) return true;
    return false;
  }

  search(query: string, opts: { kind?: ResourceKind; modules?: Set<string>; limit: number; offset: number }): { total: number; rows: CatalogEntry[] } {
    const q = query.toLowerCase();
    let re: RegExp | null = null;
    if (query.length > 2 && query.startsWith("/") && query.lastIndexOf("/") > 0) re = new RegExp(query.slice(1, query.lastIndexOf("/")), "i");
    const rows: CatalogEntry[] = [];
    for (const [key, list] of this.index()) {
      if (re ? !re.test(key) : !key.includes(q)) continue;
      for (const e of list) {
        if (opts.kind && e.kind !== opts.kind) continue;
        if (opts.modules && !opts.modules.has(e.module)) continue;
        rows.push(e);
      }
    }
    rows.sort((a, b) => (a.name.toLowerCase() === q ? -1 : 0) - (b.name.toLowerCase() === q ? -1 : 0) || a.name.localeCompare(b.name));
    return { total: rows.length, rows: rows.slice(opts.offset, opts.offset + opts.limit) };
  }

  counts(): Map<ResourceKind, number> {
    const m = new Map<ResourceKind, number>();
    for (const f of this.files.values()) {
      for (const k of new Set(f.resources.map((r) => `${r.kind}|${r.name}`))) {
        const kind = k.slice(0, k.indexOf("|")) as ResourceKind;
        m.set(kind, (m.get(kind) ?? 0) + 1);
      }
    }
    return m;
  }
}

export interface PackageProblems {
  /** Packages of the module that were checked (Assets/*.tpac). */
  packages: number;
  meshes: number;
  physicsShapes: number;
  /** Sub-meshes without a material (all-zero GUID): the editor logs "Unable to find material for mesh …". */
  nullMaterials: { mesh: string; submesh: string; package: string }[];
  /** Sub-meshes whose material GUID is in no scanned package. */
  unknownMaterials: { mesh: string; submesh: string; guid: string; package: string }[];
  /** Resource names containing control characters (e.g. a truncated "bo_x" + NUL). */
  brokenNames: { kind: ResourceKind; name: string; package: string }[];
  /** Physics shapes "bo_X" in packages that have meshes but no mesh "X". */
  shapesWithoutMesh: { name: string; package: string }[];
  /** Packages whose table could not be parsed (names only, no material check). */
  unparsed: string[];
}

/** Checks a module's imported packages for problems the editor reports only while loading them. */
export function checkModulePackages(mod: ModuleInfo, catalog: AssetCatalog): PackageProblems {
  const files: string[] = [];
  listTpacs(path.join(mod.dir, "Assets"), files);
  const out: PackageProblems = { packages: files.length, meshes: 0, physicsShapes: 0, nullMaterials: [], unknownMaterials: [], brokenNames: [], shapesWithoutMesh: [], unparsed: [] };
  for (const f of files) {
    const rel = path.relative(mod.dir, f).split(path.sep).join("/");
    const info = readTpac(f, { meshMaterials: true });
    if (info.parsed !== "table") {
      out.unparsed.push(rel);
      continue;
    }
    const meshes = new Set(info.resources.filter((r) => r.kind === "mesh").map((r) => r.name.toLowerCase()));
    for (const r of info.resources) {
      if (hasBrokenName(r.name)) out.brokenNames.push({ kind: r.kind, name: r.name, package: rel });
      if (r.kind === "mesh") {
        out.meshes++;
        for (const m of r.materials ?? []) {
          if (m.guid === NULL_GUID) out.nullMaterials.push({ mesh: r.name, submesh: m.submesh, package: rel });
          else if (!catalog.materialName(m.guid)) out.unknownMaterials.push({ mesh: r.name, submesh: m.submesh, guid: m.guid, package: rel });
        }
      } else if (r.kind === "physics_shape") {
        out.physicsShapes++;
        const base = r.name.replace(/^bo_/i, "").toLowerCase();
        if (meshes.size && /^bo_/i.test(r.name) && !meshes.has(base) && !hasBrokenName(r.name)) out.shapesWithoutMesh.push({ name: r.name, package: rel });
      }
    }
  }
  return out;
}

/** Short report lines for PackageProblems (empty when nothing is wrong). */
export function describePackageProblems(p: PackageProblems, limit = 12): string[] {
  const L: string[] = [];
  const pkgs = (rows: { package: string }[]): string => {
    const by = new Map<string, number>();
    for (const r of rows) by.set(r.package, (by.get(r.package) ?? 0) + 1);
    const list = [...by];
    return list.slice(0, limit).map(([k, n]) => `${k.replace(/^Assets\//, "")} (${n})`).join(", ") + (list.length > limit ? `, … (${list.length} packages)` : "");
  };
  if (p.nullMaterials.length) {
    const meshes = [...new Set(p.nullMaterials.map((x) => x.mesh))];
    L.push(
      `${p.nullMaterials.length} sub-mesh(es) of ${meshes.length} mesh(es) have NO material (null GUID): ${meshes.slice(0, limit).map(displayName).join(", ")}${meshes.length > limit ? ", …" : ""} — in ${pkgs(p.nullMaterials)}.`,
      "  The editor logs 'Unable to find material for mesh …' for each while loading, and its crash watchdog collects a dump every time — startup can stall for many minutes. Usually the FBX was converted before its new materials were registered: import textures/materials first, restart the editor, then re-import these FBX files (or move the packages out of Assets/ before starting the editor).",
    );
  }
  if (p.unknownMaterials.length) {
    L.push(`${p.unknownMaterials.length} sub-mesh(es) use a material that is in no package: ${p.unknownMaterials.slice(0, limit).map((x) => `${displayName(x.mesh)} → ${guidString(x.guid)}`).join(", ")}${p.unknownMaterials.length > limit ? ", …" : ""}.`);
  }
  if (p.brokenNames.length) {
    L.push(`${p.brokenNames.length} resource name(s) contain control characters (truncated by the importer): ${p.brokenNames.slice(0, limit).map((x) => `${x.kind} '${displayName(x.name)}' in ${x.package}`).join(", ")}. Re-import those FBX files; scenes cannot reference these names.`);
  }
  if (p.shapesWithoutMesh.length) {
    L.push(`${p.shapesWithoutMesh.length} physics shape(s) have no mesh of the same name in their package: ${p.shapesWithoutMesh.slice(0, limit).map((x) => `${displayName(x.name)} (${x.package})`).join(", ")}.`);
  }
  if (p.unparsed.length) L.push(`Not checked (table layout not understood): ${p.unparsed.slice(0, limit).join(", ")}.`);
  return L;
}
