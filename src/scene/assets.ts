import fs from "node:fs";
import path from "node:path";
import type { ModuleInfo } from "../model/modules.js";
import type { Transaction } from "../ops/history.js";
import { readTpac, type TpacInfo } from "./tpac.js";
import { isDirEntry } from "../util/fsx.js";

export const MESH_EXT = new Set([".fbx"]);
export const TEXTURE_EXT = new Set([".png", ".tga", ".dds", ".tif", ".tiff", ".psd", ".bmp", ".jpg", ".jpeg", ".exr"]);
export const SUPPORTED_EXT = new Set([...MESH_EXT, ...TEXTURE_EXT]);

export interface SourceCheck {
  kind: "mesh" | "texture" | "other";
  width?: number;
  height?: number;
  format?: string;
  notes: string[];
}

function readHead(file: string, n: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** Inspects an asset source file (FBX version, image size) without loading it entirely. */
export function inspectSource(file: string): SourceCheck {
  const ext = path.extname(file).toLowerCase();
  const res: SourceCheck = { kind: MESH_EXT.has(ext) ? "mesh" : TEXTURE_EXT.has(ext) ? "texture" : "other", notes: [] };
  let head: Buffer;
  try {
    head = readHead(file, 64 * 1024);
  } catch (e) {
    res.notes.push(`cannot read: ${(e as Error).message}`);
    return res;
  }
  if (ext === ".fbx") {
    if (head.toString("latin1", 0, 18) === "Kaydara FBX Binary") {
      const ver = head.readUInt32LE(23);
      res.format = `binary FBX ${ver}`;
      if (ver < 7100) res.notes.push(`old FBX version ${ver}; export FBX 2014+ (7400/7500) if the import fails`);
    } else if (/^\s*;\s*FBX/.test(head.toString("latin1", 0, 64))) {
      res.format = "ASCII FBX";
      res.notes.push("ASCII FBX: prefer binary FBX for faster, more reliable import");
    } else res.notes.push("does not look like an FBX file");
  } else if (ext === ".png" && head.length >= 24 && head.readUInt32BE(0) === 0x89504e47) {
    res.width = head.readUInt32BE(16);
    res.height = head.readUInt32BE(20);
    res.format = "PNG";
  } else if (ext === ".dds" && head.length >= 20 && head.toString("latin1", 0, 4) === "DDS ") {
    res.height = head.readUInt32LE(12);
    res.width = head.readUInt32LE(16);
    res.format = `DDS ${head.toString("latin1", 84, 88).replace(/\0/g, "")}`.trim();
  } else if (ext === ".tga" && head.length >= 18) {
    res.width = head.readUInt16LE(12);
    res.height = head.readUInt16LE(14);
    res.format = "TGA";
  } else if (ext === ".bmp" && head.length >= 26 && head.toString("latin1", 0, 2) === "BM") {
    res.width = head.readInt32LE(18);
    res.height = Math.abs(head.readInt32LE(22));
    res.format = "BMP";
  } else if ((ext === ".jpg" || ext === ".jpeg") && head[0] === 0xff && head[1] === 0xd8) {
    res.format = "JPEG";
    for (let i = 2; i + 9 < head.length; ) {
      if (head[i] !== 0xff) break;
      const marker = head[i + 1];
      const size = head.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        res.height = head.readUInt16BE(i + 5);
        res.width = head.readUInt16BE(i + 7);
        break;
      }
      i += 2 + size;
    }
  }
  if (res.width && res.height) {
    if (res.width % 4 || res.height % 4) res.notes.push(`${res.width}x${res.height} is not a multiple of 4 (block compression needs it)`);
    else if (!isPow2(res.width) || !isPow2(res.height)) res.notes.push(`${res.width}x${res.height} is not a power of two (mip maps work best with 512/1024/2048…)`);
    if (res.width > 8192 || res.height > 8192) res.notes.push("larger than 8192px");
  }
  if (res.kind === "texture") {
    const base = path.basename(file, ext).toLowerCase();
    if (!/_(d|n|s|a|m|mask|sp|e|o|ao|h|r|rgb|alpha)$/.test(base)) res.notes.push("no type suffix: TaleWorlds names textures like name_d (diffuse), name_n (normal), name_s (specular)");
  }
  return res;
}

export function normalizeAssetName(name: string): string {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  const clean = base
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
  return `${clean || "asset"}${ext.toLowerCase()}`;
}

/** Name of the .tpac the editor creates for a source file (observed: x.fbx → x_geo, x.png → x_tex). */
export function expectedPackage(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file, path.extname(file));
  return MESH_EXT.has(ext) ? `${base}_geo.tpac` : TEXTURE_EXT.has(ext) ? `${base}_tex.tpac` : `${base}.tpac`;
}

export interface ImportResult {
  /** replaced: the file existed in AssetSources before (new files need the editor's "Import new asset"). */
  copied: Array<{ from: string; to: string; bytes: number; check: SourceCheck; replaced: boolean }>;
  skipped: string[];
  createdDirs: string[];
}

const BACKUP_LIMIT = 200 * 1024 * 1024;

/** Copies source files into <module>/AssetSources (the folder the editor imports from). */
export function importSources(
  tx: Transaction,
  mod: ModuleInfo,
  files: string[],
  opts: { subfolder?: string; normalize: boolean; overwrite: boolean },
): ImportResult {
  const res: ImportResult = { copied: [], skipped: [], createdDirs: [] };
  const sub = (opts.subfolder ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (sub.includes("..")) throw new Error("subfolder must stay inside AssetSources.");
  const destDir = path.join(mod.dir, "AssetSources", ...sub.split("/").filter(Boolean));
  for (const d of [path.join(mod.dir, "Assets"), destDir]) {
    if (!fs.existsSync(d)) {
      tx.mkdir(d);
      res.createdDirs.push(path.relative(mod.dir, d).split(path.sep).join("/"));
    }
  }
  const expanded: string[] = [];
  for (const f of files) {
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
    if (fs.statSync(abs).isDirectory()) {
      for (const e of fs.readdirSync(abs)) if (SUPPORTED_EXT.has(path.extname(e).toLowerCase())) expanded.push(path.join(abs, e));
    } else expanded.push(abs);
  }
  for (const src of expanded) {
    const ext = path.extname(src).toLowerCase();
    if (!SUPPORTED_EXT.has(ext)) {
      res.skipped.push(`${src} (unsupported type ${ext}; use .fbx for meshes and .png/.tga/.dds/.tif/.psd for textures)`);
      continue;
    }
    const name = opts.normalize ? normalizeAssetName(path.basename(src)) : path.basename(src);
    const dest = path.join(destDir, name);
    if (path.resolve(dest).toLowerCase() === path.resolve(src).toLowerCase()) {
      res.skipped.push(`${src} (already in AssetSources)`);
      continue;
    }
    const exists = fs.existsSync(dest);
    if (exists && !opts.overwrite) {
      res.skipped.push(`${name} (already exists; pass overwrite=true to replace it)`);
      continue;
    }
    const size = fs.statSync(src).size;
    tx.copyIn(src, dest, { backup: !exists || size <= BACKUP_LIMIT });
    res.copied.push({ from: src, to: path.relative(mod.dir, dest).split(path.sep).join("/"), bytes: size, check: inspectSource(src), replaced: exists });
  }
  return res;
}

export interface SourceState {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  state: "imported" | "stale" | "pending";
  packages: string[];
}

export interface AssetStatus {
  sources: SourceState[];
  packages: Array<TpacInfo & { rel: string }>;
  orphans: Array<TpacInfo & { rel: string }>;
}

function walk(dir: string, out: string[], filter: (n: string) => boolean, depth = 0): void {
  if (depth > 8) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (isDirEntry(e, p)) walk(p, out, filter, depth + 1);
    else if (filter(e.name)) out.push(p);
  }
}

/** Compares AssetSources with the editor's imported packages in Assets/. */
export function assetStatus(mod: ModuleInfo): AssetStatus {
  const srcFiles: string[] = [];
  walk(path.join(mod.dir, "AssetSources"), srcFiles, (n) => SUPPORTED_EXT.has(path.extname(n).toLowerCase()));
  const pkgFiles: string[] = [];
  walk(path.join(mod.dir, "Assets"), pkgFiles, (n) => n.toLowerCase().endsWith(".tpac"));
  const packages = pkgFiles.map((f) => ({ ...readTpac(f), rel: path.relative(mod.dir, f).split(path.sep).join("/") }));
  const bySource = new Map<string, Array<TpacInfo & { rel: string }>>();
  for (const p of packages) {
    for (const s of p.sources) {
      // "$BASE/Modules/<Mod>/AssetSources/x.png" → "AssetSources/x.png"
      const m = /\/Modules\/[^/]+\/(.+)$/.exec(s.replace(/\\/g, "/"));
      const key = (m ? m[1] : s).toLowerCase();
      const list = bySource.get(key) ?? [];
      list.push(p);
      bySource.set(key, list);
    }
  }
  const sources: SourceState[] = srcFiles.map((abs) => {
    const st = fs.statSync(abs);
    const rel = path.relative(mod.dir, abs).split(path.sep).join("/");
    let pk = bySource.get(rel.toLowerCase()) ?? [];
    if (!pk.length) {
      // Fall back to the naming convention when the package does not record its source.
      const exp = expectedPackage(abs).toLowerCase();
      pk = packages.filter((p) => path.basename(p.rel).toLowerCase() === exp);
    }
    const newest = Math.max(0, ...pk.map((p) => p.mtimeMs));
    const state: SourceState["state"] = !pk.length ? "pending" : st.mtimeMs > newest + 2000 ? "stale" : "imported";
    return { rel, abs, size: st.size, mtimeMs: st.mtimeMs, state, packages: pk.map((p) => p.rel) };
  });
  const used = new Set(sources.flatMap((s) => s.packages));
  const orphans = packages.filter((p) => {
    if (used.has(p.rel)) return false;
    if (!p.sources.length) return false;
    return p.sources.every((s) => {
      const m = /\/Modules\/([^/]+)\/(.+)$/.exec(s.replace(/\\/g, "/"));
      return !m || !fs.existsSync(path.join(mod.dir, ...m[2].split("/")));
    });
  });
  return { sources, packages, orphans };
}
