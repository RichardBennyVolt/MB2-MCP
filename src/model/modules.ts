import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { detectGame, userGameDocsDir, type GameLocation } from "../gamepaths.js";
import { readTextFile } from "../util/text.js";
import { childElements, firstChild, getAttr, parseTree, type XElem } from "../xml/scanner.js";
import { isDirEntry } from "../util/fsx.js";

export type ModuleSource = "game" | "workshop" | "extra";

export interface ModuleDependency {
  id: string;
  version?: string;
  optional: boolean;
  /** "before": the dependency loads before this module. "after": it must load after. */
  order: "before" | "after";
  kind: "DependedModule" | "DependedModuleMetadata";
  incompatible?: boolean;
}

export interface XmlNodeEntry {
  id: string;
  path: string;
  gameTypes: string[];
  line: number;
}

export interface SubModuleEntry {
  name: string;
  dll: string;
  classType: string;
  assemblies: string[];
  tags: Array<[string, string]>;
}

export interface ModuleInfo {
  id: string;
  name: string;
  version: string;
  dir: string;
  folderName: string;
  source: ModuleSource;
  moduleType: string;
  category: string;
  defaultModule: boolean;
  official: boolean;
  writable: boolean;
  url?: string;
  requiredBaseVersion?: string;
  deps: ModuleDependency[];
  loadAfterThis: string[];
  incompatible: string[];
  subModules: SubModuleEntry[];
  xmls: XmlNodeEntry[];
  parseErrors: string[];
  /** Set on duplicates hidden behind a module with the same id. */
  shadowedBy?: string;
}

export const OFFICIAL_IDS = new Set(
  ["Native", "SandBoxCore", "Sandbox", "StoryMode", "CustomBattle", "Multiplayer", "BirthAndDeath", "FastMode", "NavalDLC", "DedicatedCustomServerHelper"].map((s) => s.toLowerCase()),
);

/** Official load order used as a tie-breaker. */
const OFFICIAL_RANK = ["native", "sandboxcore", "birthanddeath", "custombattle", "sandbox", "storymode", "fastmode", "navaldlc", "multiplayer"];

/** Modules every singleplayer mod effectively runs with. */
export const CORE_SP_MODULES = ["Native", "SandBoxCore", "Sandbox", "StoryMode", "CustomBattle"];

export interface ParsedVersion {
  prefix: string;
  nums: number[];
}

export function parseVersion(v: string | undefined): ParsedVersion | null {
  if (!v) return null;
  const m = /^\s*([a-zA-Z]?)(\d+(?:\.\d+)*)/.exec(v);
  if (!m) return null;
  return { prefix: m[1].toLowerCase(), nums: m[2].split(".").map((x) => parseInt(x, 10)) };
}

/** Compares numeric parts only (v1.2.3 vs e1.2.4). Missing parts count as 0. `parts` limits the depth (3 = ignore changeset numbers). */
export function compareVersions(a: string | undefined, b: string | undefined, parts = Infinity): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  const len = Math.min(parts, Math.max(pa.nums.length, pb.nums.length));
  for (let i = 0; i < len; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function bool(v: string | undefined): boolean {
  return /^true$/i.test((v ?? "").trim());
}

function value(parent: XElem | undefined, name: string): string | undefined {
  return getAttr(firstChild(parent, name, true), "value");
}

export function parseSubModuleXml(file: string, source: ModuleSource): Omit<ModuleInfo, "writable"> {
  const dir = path.dirname(file);
  const folderName = path.basename(dir);
  const parseErrors: string[] = [];
  let root: XElem | null = null;
  try {
    const { text } = readTextFile(file);
    const res = parseTree(text, 10);
    root = res.root;
    for (const e of res.errors) parseErrors.push(`SubModule.xml line ${e.line}: ${e.message}`);
  } catch (e) {
    parseErrors.push(`Cannot read SubModule.xml: ${(e as Error).message}`);
  }
  if (root && root.name !== "Module") parseErrors.push(`SubModule.xml root element is <${root.name}>, expected <Module>`);
  const r = root ?? undefined;
  const id = value(r, "Id") ?? folderName;
  const moduleType = value(r, "ModuleType") ?? "";
  const deps: ModuleDependency[] = [];
  for (const d of childElements(firstChild(r, "DependedModules", true), "DependedModule")) {
    const did = getAttr(d, "Id");
    if (!did) continue;
    deps.push({ id: did, version: getAttr(d, "DependentVersion"), optional: bool(getAttr(d, "Optional")), order: "before", kind: "DependedModule" });
  }
  for (const d of childElements(firstChild(r, "DependedModuleMetadatas", true), "DependedModuleMetadata")) {
    const did = getAttr(d, "id") ?? getAttr(d, "Id");
    if (!did) continue;
    const order = (getAttr(d, "order") ?? "LoadBeforeThis").toLowerCase() === "loadafterthis" ? "after" : "before";
    deps.push({
      id: did,
      version: getAttr(d, "version"),
      optional: bool(getAttr(d, "optional")),
      order,
      kind: "DependedModuleMetadata",
      incompatible: bool(getAttr(d, "incompatible")),
    });
  }
  const loadAfterThis = childElements(firstChild(r, "ModulesToLoadAfterThis", true), "Module")
    .map((m) => getAttr(m, "Id") ?? "")
    .filter(Boolean);
  const incompatible = childElements(firstChild(r, "IncompatibleModules", true), "Module")
    .map((m) => getAttr(m, "Id") ?? "")
    .filter(Boolean);
  const subModules: SubModuleEntry[] = childElements(firstChild(r, "SubModules", true), "SubModule").map((s) => ({
    name: value(s, "Name") ?? "",
    dll: value(s, "DLLName") ?? "",
    classType: value(s, "SubModuleClassType") ?? "",
    assemblies: childElements(firstChild(s, "Assemblies"), "Assembly").map((a) => getAttr(a, "value") ?? ""),
    tags: childElements(firstChild(s, "Tags"), "Tag").map((t) => [getAttr(t, "key") ?? "", getAttr(t, "value") ?? ""] as [string, string]),
  }));
  const xmls: XmlNodeEntry[] = [];
  for (const node of childElements(firstChild(r, "Xmls", true), "XmlNode")) {
    const xn = firstChild(node, "XmlName");
    const xid = getAttr(xn, "id");
    const xpath = getAttr(xn, "path");
    if (!xid || !xpath) {
      parseErrors.push(`SubModule.xml line ${node.line}: <XmlNode> without XmlName id/path`);
      continue;
    }
    const gameTypes = childElements(firstChild(node, "IncludedGameTypes"), "GameType")
      .map((g) => getAttr(g, "value") ?? "")
      .filter(Boolean);
    xmls.push({ id: xid, path: xpath, gameTypes, line: node.line });
  }
  const official =
    /^official/i.test(moduleType) || bool(value(r, "Official")) || (source === "game" && OFFICIAL_IDS.has(id.toLowerCase()));
  return {
    id,
    name: value(r, "Name") ?? id,
    version: value(r, "Version") ?? "",
    dir,
    folderName,
    source,
    moduleType,
    category: value(r, "ModuleCategory") ?? "",
    defaultModule: bool(value(r, "DefaultModule")),
    official,
    url: value(r, "Url"),
    requiredBaseVersion: value(r, "RequiredBaseVersion"),
    deps,
    loadAfterThis,
    incompatible,
    subModules,
    xmls,
    parseErrors,
  };
}

export interface LauncherState {
  file: string;
  order: string[];
  enabled: Set<string>;
}

export function readLauncherData(): LauncherState | null {
  const file = path.join(userGameDocsDir(), "Configs", "LauncherData.xml");
  try {
    const { text } = readTextFile(file);
    const { root } = parseTree(text, 5);
    const sp = firstChild(firstChild(root, "SingleplayerData"), "ModDatas");
    const order: string[] = [];
    const enabled = new Set<string>();
    for (const m of childElements(sp, "UserModData")) {
      const idEl = firstChild(m, "Id");
      const selEl = firstChild(m, "IsSelected");
      const id = idEl ? text.slice(idEl.openEnd, idEl.closeStart).trim() : "";
      const sel = selEl ? text.slice(selEl.openEnd, selEl.closeStart).trim() : "";
      if (!id) continue;
      order.push(id);
      if (/^true$/i.test(sel)) enabled.add(id.toLowerCase());
    }
    return { file, order, enabled };
  } catch {
    return null;
  }
}

export interface ResolvedXmlStep {
  /** Absolute path of a data XML file (or null for an XSLT-only node). */
  xml: string | null;
  /** Absolute path of the .xslt applied before this file is merged (or null). */
  xslt: string | null;
}

export interface ResolvedXmlNode {
  node: XmlNodeEntry;
  /** "outside": the path leaves the module's ModuleData folder (e.g. "../..") — never read. */
  kind: "file" | "dir" | "xslt-only" | "missing" | "outside";
  steps: ResolvedXmlStep[];
  /** A legacy .xsl file found next to the node (the game only looks for .xslt). */
  strayXsl?: string;
}

function existsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** True when `p` lies inside `dir` (lexically: junctions a modder made inside the module are fine; "..", other drives and look-alike folders are not). */
export function isInsideDir(dir: string, p: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Mirrors how the game resolves <XmlName path="..."> inside ModuleData. */
export function resolveXmlNode(mod: ModuleInfo, node: XmlNodeEntry): ResolvedXmlNode {
  const dataDir = path.join(mod.dir, "ModuleData");
  const base = path.resolve(dataDir, ...node.path.split(/[\\/]/).filter(Boolean));
  // A module (e.g. from the Workshop) must not make the server read files elsewhere on this computer.
  if (!isInsideDir(dataDir, base)) return { node, kind: "outside", steps: [] };
  const xslt = existsFile(`${base}.xslt`) ? `${base}.xslt` : null;
  const strayXsl = existsFile(`${base}.xsl`) ? `${base}.xsl` : undefined;
  if (existsFile(`${base}.xml`)) return { node, kind: "file", steps: [{ xml: `${base}.xml`, xslt }], strayXsl };
  if (xslt) return { node, kind: "xslt-only", steps: [{ xml: null, xslt }], strayXsl };
  if (existsDir(base)) {
    const files = fs
      .readdirSync(base)
      .filter((f) => f.toLowerCase().endsWith(".xml"))
      .sort((a, b) => a.localeCompare(b, "en"));
    return {
      node,
      kind: "dir",
      steps: files.map((f) => {
        const x = path.join(base, f);
        const xs = x.replace(/\.xml$/i, ".xslt");
        return { xml: x, xslt: existsFile(xs) ? xs : null };
      }),
    };
  }
  return { node, kind: "missing", steps: [], strayXsl };
}

export class ModuleRegistry {
  location!: GameLocation;
  /** Primary modules (duplicates removed). */
  modules: ModuleInfo[] = [];
  /** Every module found, including shadowed duplicates. */
  all: ModuleInfo[] = [];
  private byId = new Map<string, ModuleInfo>();
  private lastRefresh = 0;
  launcher: LauncherState | null = null;

  constructor(private readonly config: Config) {}

  get gameDir(): string | null {
    return this.location?.gameDir ?? null;
  }

  ensureFresh(maxAgeMs = 4000): void {
    if (Date.now() - this.lastRefresh > maxAgeMs) this.refresh();
  }

  private detectedAt = 0;

  refresh(): void {
    if (!this.location || (this.location.gameDir === null && Date.now() - this.detectedAt > 60000)) {
      this.location = detectGame(this.config.gameDirOverride);
      this.detectedAt = Date.now();
    }
    const found: ModuleInfo[] = [];
    const add = (subModuleXml: string, source: ModuleSource): void => {
      const info = parseSubModuleXml(subModuleXml, source);
      found.push({ ...info, writable: !info.official && source !== "workshop" && !this.config.readOnly });
    };
    const scanRoot = (root: string, source: ModuleSource): void => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!isDirEntry(e, path.join(root, e.name))) continue;
        const sm = path.join(root, e.name, "SubModule.xml");
        if (existsFile(sm)) add(sm, source);
      }
    };
    for (const dir of this.config.extraModuleDirs) {
      if (existsFile(path.join(dir, "SubModule.xml"))) add(path.join(dir, "SubModule.xml"), "extra");
      else scanRoot(dir, "extra");
    }
    if (this.location.gameDir) scanRoot(path.join(this.location.gameDir, "Modules"), "game");
    if (this.config.includeWorkshop && this.location.workshopDir) scanRoot(this.location.workshopDir, "workshop");

    const byId = new Map<string, ModuleInfo>();
    const primary: ModuleInfo[] = [];
    for (const m of found) {
      const key = m.id.toLowerCase();
      const existing = byId.get(key);
      if (existing) {
        m.shadowedBy = `${existing.source}:${existing.dir}`;
        continue;
      }
      byId.set(key, m);
      primary.push(m);
    }
    this.all = found;
    this.modules = primary;
    this.byId = byId;
    this.launcher = readLauncherData();
    this.lastRefresh = Date.now();
  }

  get(idOrFolder: string): ModuleInfo | undefined {
    if (!this.lastRefresh) this.refresh();
    const key = idOrFolder.trim().toLowerCase();
    if (!key) return undefined;
    const byKey = this.byId.get(key) ?? this.modules.find((m) => m.folderName.toLowerCase() === key);
    if (byKey) return byKey;
    if (/[\\/]/.test(idOrFolder)) {
      const abs = path.resolve(idOrFolder).toLowerCase();
      return this.modules.find((m) => path.resolve(m.dir).toLowerCase() === abs);
    }
    return undefined;
  }

  require(idOrFolder: string): ModuleInfo {
    const m = this.get(idOrFolder);
    if (m) return m;
    const key = idOrFolder.toLowerCase();
    const similar = this.modules
      .filter((x) => x.id.toLowerCase().includes(key) || key.includes(x.id.toLowerCase()))
      .map((x) => x.id)
      .slice(0, 8);
    throw new Error(
      `Module '${idOrFolder}' not found.${similar.length ? ` Did you mean: ${similar.join(", ")}?` : ""} Use list_modules to see installed modules${
        this.gameDir ? "" : " (game folder not detected: set MB2_GAME_DIR)"
      }.`,
    );
  }

  requireWritable(idOrFolder: string): ModuleInfo {
    const m = this.require(idOrFolder);
    if (this.config.readOnly) throw new Error("The server runs in read-only mode (MB2_READONLY). Writes are disabled.");
    if (m.official) throw new Error(`'${m.id}' is an official TaleWorlds module and is never modified. Create your own module (create_module) and override/patch from there (xslt_patch / clone_object).`);
    if (m.source === "workshop") throw new Error(`'${m.id}' is a Steam Workshop download (${m.dir}); edits would be overwritten by Steam. Copy it into Modules/ or a dev folder first.`);
    return m;
  }

  private rank(m: ModuleInfo): number {
    const r = OFFICIAL_RANK.indexOf(m.id.toLowerCase());
    if (r >= 0) return r;
    const li = this.launcher?.order.findIndex((x) => x.toLowerCase() === m.id.toLowerCase()) ?? -1;
    return li >= 0 ? 100 + li : 10000;
  }

  /** Topological load order over `mods` honoring DependedModules, metadata order and ModulesToLoadAfterThis. */
  loadOrder(mods: ModuleInfo[] = this.modules): ModuleInfo[] {
    const set = new Map(mods.map((m) => [m.id.toLowerCase(), m]));
    const edges = new Map<string, Set<string>>();
    const indeg = new Map<string, number>();
    for (const k of set.keys()) {
      edges.set(k, new Set());
      indeg.set(k, 0);
    }
    const addEdge = (from: string, to: string): void => {
      const f = from.toLowerCase();
      const t = to.toLowerCase();
      if (f === t || !set.has(f) || !set.has(t)) return;
      const s = edges.get(f)!;
      if (s.has(t)) return;
      s.add(t);
      indeg.set(t, (indeg.get(t) ?? 0) + 1);
    };
    for (const m of mods) {
      for (const d of m.deps) {
        if (d.incompatible) continue;
        if (d.order === "before") addEdge(d.id, m.id);
        else addEdge(m.id, d.id);
      }
      for (const a of m.loadAfterThis) addEdge(m.id, a);
    }
    const out: ModuleInfo[] = [];
    const ready = [...set.keys()].filter((k) => indeg.get(k) === 0);
    const byRank = (a: string, b: string): number => this.rank(set.get(a)!) - this.rank(set.get(b)!) || a.localeCompare(b);
    while (ready.length) {
      ready.sort(byRank);
      const k = ready.shift()!;
      out.push(set.get(k)!);
      for (const t of edges.get(k)!) {
        indeg.set(t, indeg.get(t)! - 1);
        if (indeg.get(t) === 0) ready.push(t);
      }
    }
    if (out.length < set.size) {
      const rest = [...set.keys()].filter((k) => !out.includes(set.get(k)!)).sort(byRank);
      for (const k of rest) out.push(set.get(k)!);
    }
    return out;
  }

  /** The module plus everything it (transitively) depends on that is installed. */
  dependencyClosure(mod: ModuleInfo): ModuleInfo[] {
    const seen = new Map<string, ModuleInfo>();
    const visit = (m: ModuleInfo): void => {
      const k = m.id.toLowerCase();
      if (seen.has(k)) return;
      seen.set(k, m);
      for (const d of m.deps) {
        if (d.incompatible || d.order !== "before") continue;
        const dep = this.get(d.id);
        if (dep) visit(dep);
      }
    };
    visit(mod);
    return [...seen.values()];
  }

  /** Modules whose data is visible to `mod` at runtime: its dependency closure + core singleplayer modules, in load order. */
  contextFor(mod: ModuleInfo): ModuleInfo[] {
    const set = new Map<string, ModuleInfo>();
    for (const id of CORE_SP_MODULES) {
      const m = this.get(id);
      if (m) set.set(m.id.toLowerCase(), m);
    }
    for (const m of this.dependencyClosure(mod)) set.set(m.id.toLowerCase(), m);
    return this.loadOrder([...set.values()]);
  }

  /** Version string of Native (the game version). */
  gameVersion(): string {
    return this.get("Native")?.version ?? "";
  }

  /** Union of game types official singleplayer modules use for an XmlName id. */
  defaultGameTypes(xmlId: string): string[] {
    const types = new Set<string>();
    for (const m of this.modules) {
      if (!m.official) continue;
      for (const n of m.xmls) {
        if (n.id !== xmlId) continue;
        for (const t of n.gameTypes) if (t !== "MultiplayerGame") types.add(t);
      }
    }
    const order = ["Campaign", "CampaignStoryMode", "CustomGame", "EditorGame"];
    const list = [...types].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    return list.length ? list : ["Campaign", "CampaignStoryMode", "CustomGame"];
  }
}
