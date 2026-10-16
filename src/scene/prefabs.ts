import fs from "node:fs";
import path from "node:path";
import type { ModuleInfo } from "../model/modules.js";
import { readTextFile } from "../util/text.js";
import { getAttr, scanXml } from "../xml/scanner.js";
import { isDirEntry } from "../util/fsx.js";

/** One prefab definition: a top-level <game_entity> inside Modules/<Mod>/Prefabs/*.xml. */
export interface PrefabRec {
  name: string;
  module: string;
  abs: string;
  rel: string;
  line: number;
  start: number;
  end: number;
  meshes: string[];
  physics: string[];
  scripts: string[];
  tags: string[];
  materials: string[];
  /** Nested game_entity count. */
  children: number;
}

interface PrefabFile {
  abs: string;
  mtimeMs: number;
  size: number;
  module: string;
  prefabs: PrefabRec[];
}

function walk(dir: string, out: string[], depth = 0): void {
  if (depth > 6) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (isDirEntry(e, p)) walk(p, out, depth + 1);
    else if (e.name.toLowerCase().endsWith(".xml")) out.push(p);
  }
}

function indexPrefabFile(abs: string, mod: ModuleInfo, st: fs.Stats): PrefabFile {
  const file: PrefabFile = { abs, mtimeMs: st.mtimeMs, size: st.size, module: mod.id, prefabs: [] };
  let text: string;
  try {
    text = readTextFile(abs).text;
  } catch {
    return file;
  }
  const rel = path.relative(mod.dir, abs).split(path.sep).join("/");
  let cur: PrefabRec | null = null;
  const add = (list: string[], v: string | undefined): void => {
    if (v && !list.includes(v) && list.length < 50) list.push(v);
  };
  scanXml(text, {
    maxErrors: 5,
    onOpen: (el) => {
      if (el.depth === 1 && el.name === "game_entity") {
        cur = { name: getAttr(el, "name") ?? "", module: mod.id, abs, rel, line: el.line, start: el.start, end: el.end, meshes: [], physics: [], scripts: [], tags: [], materials: [], children: 0 };
        return;
      }
      if (!cur) return;
      switch (el.name) {
        case "game_entity":
          cur.children++;
          break;
        case "meta_mesh_component":
          add(cur.meshes, getAttr(el, "name"));
          add(cur.materials, getAttr(el, "material"));
          break;
        case "mesh":
          add(cur.materials, getAttr(el, "material"));
          break;
        case "physics":
          add(cur.physics, getAttr(el, "shape"));
          break;
        case "script":
          add(cur.scripts, getAttr(el, "name"));
          break;
        case "tag":
          add(cur.tags, getAttr(el, "name"));
          break;
      }
    },
    onClose: (el) => {
      if (cur && el.depth === 1 && el.start === cur.start) {
        cur.end = el.end;
        if (cur.name) file.prefabs.push(cur);
        cur = null;
      }
    },
  });
  return file;
}

/** Index of all prefabs (Modules/*\/Prefabs/**\/*.xml), refreshed by file mtime. */
export class PrefabIndex {
  private files = new Map<string, PrefabFile>();
  private byName: Map<string, PrefabRec[]> | null = null;
  private checked = new Map<string, number>();

  ensure(mods: ModuleInfo[], maxAgeMs = 30000): void {
    let changed = false;
    for (const mod of mods) {
      const last = this.checked.get(mod.dir) ?? 0;
      if (!mod.writable && Date.now() - last < maxAgeMs) continue;
      const found: string[] = [];
      walk(path.join(mod.dir, "Prefabs"), found);
      const keep = new Set(found.map((f) => f.toLowerCase()));
      for (const [k, v] of this.files) {
        if (v.module === mod.id && !keep.has(k)) {
          this.files.delete(k);
          changed = true;
        }
      }
      for (const f of found) {
        let st: fs.Stats;
        try {
          st = fs.statSync(f);
        } catch {
          continue;
        }
        const key = f.toLowerCase();
        const old = this.files.get(key);
        if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) continue;
        this.files.set(key, indexPrefabFile(f, mod, st));
        changed = true;
      }
      this.checked.set(mod.dir, Date.now());
    }
    if (changed) this.byName = null;
  }

  touch(mod: ModuleInfo): void {
    this.checked.delete(mod.dir);
  }

  all(): PrefabRec[] {
    const out: PrefabRec[] = [];
    for (const f of this.files.values()) out.push(...f.prefabs);
    return out;
  }

  find(name: string): PrefabRec[] {
    if (!this.byName) {
      const m = new Map<string, PrefabRec[]>();
      for (const p of this.all()) {
        const list = m.get(p.name);
        if (list) list.push(p);
        else m.set(p.name, [p]);
      }
      this.byName = m;
    }
    return this.byName.get(name) ?? [];
  }

  count(): number {
    let n = 0;
    for (const f of this.files.values()) n += f.prefabs.length;
    return n;
  }
}
