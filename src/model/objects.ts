import fs from "node:fs";
import path from "node:path";
import { readTextFile } from "../util/text.js";
import { getAttr, scanXml, type XElem, type XmlIssue } from "../xml/scanner.js";
import { resolveXmlNode, type ModuleInfo, type ModuleRegistry } from "./modules.js";
import { isDirEntry } from "../util/fsx.js";

/** A localizable string found in a data file: name="{=id}Text". */
export interface StringRec {
  id: string;
  text: string;
  attr: string;
  tag: string;
  line: number;
  /** Plain (non-{=..}) text in a user-facing attribute → missing localization id. */
  missingId?: boolean;
}

export interface ObjRec {
  tag: string;
  id: string;
  /** Raw name attribute (may contain {=xxxx}). */
  name?: string;
  module: string;
  file: FileRec;
  line: number;
  start: number;
  end: number;
  depth: number;
  parentTag?: string;
  attrs: Array<[string, string]>;
  /** Normalized references ("Item.foo", "NPCCharacter.bar", ...) found anywhere in the subtree. */
  refs: string[];
}

export interface XsltRuleRec {
  match: string;
  line: number;
  /** ids found in [@id='...'] predicates. */
  ids: string[];
  tags: string[];
}

export interface FileRec {
  abs: string;
  /** Path relative to the module folder, with forward slashes. */
  rel: string;
  module: string;
  kind: "data" | "xslt";
  /** XmlName ids this file is registered under (usually one). */
  xmlIds: string[];
  /** Engine file type when listed in ModuleData/project.mbproj (action_set, skin, …). */
  engineType?: string;
  /** Loaded by the game: registered in SubModule.xml <Xmls> or in project.mbproj. */
  registered: boolean;
  rootTag?: string;
  mtimeMs: number;
  size: number;
  objects: ObjRec[];
  strings: StringRec[];
  errors: XmlIssue[];
  xsltRules?: XsltRuleRec[];
}

interface ModuleIndex {
  module: ModuleInfo;
  files: Map<string, FileRec>;
  checkedAt: number;
}

const REF_RE = /^([A-Z][A-Za-z]+)\.([A-Za-z0-9_\-.]+)$/;
const STRING_RE = /^\{=([^}]*)\}([\s\S]*)$/;
/** Attributes whose plain text is shown to players (used to flag missing {=id}). */
const TEXT_ATTRS = new Set(["name", "text", "short_name", "title", "ruler_title", "informal_name", "description", "encyclopedia_text"]);

export function parseLocalized(v: string): { id: string; text: string } | null {
  const m = STRING_RE.exec(v);
  return m ? { id: m[1], text: m[2] } : null;
}

/**
 * Plain text (without {=id}) in a player-facing attribute of an object (or a GameText <string>).
 * Identifiers such as mesh names (underscores/dots, no spaces) are not considered text.
 */
export function isPlainLocalizableText(tag: string, attr: string, value: string, isObjectEl: boolean): boolean {
  return (
    TEXT_ATTRS.has(attr) &&
    (isObjectEl || tag === "string") &&
    !value.startsWith("{=") &&
    /[A-Za-zÀ-￿]/.test(value) &&
    !(/[_.]/.test(value) && !/\s/.test(value))
  );
}

/** Reference prefixes whose objects use a different XML tag. */
export const REF_PREFIX_TAGS: Record<string, string[]> = {
  Item: ["Item", "CraftedItem"],
  PartyTemplate: ["MBPartyTemplate", "PartyTemplate"],
  NPCCharacter: ["NPCCharacter"],
  Hero: ["Hero"],
  Faction: ["Faction"],
  Clan: ["Faction"],
  Kingdom: ["Kingdom"],
  Culture: ["Culture"],
  Settlement: ["Settlement"],
  CraftingPiece: ["CraftingPiece"],
  CraftingTemplate: ["CraftingTemplate"],
  BodyProperty: ["BodyProperty"],
  SkillSet: ["SkillSet"],
  EquipmentRoster: ["EquipmentRoster"],
  ItemModifier: ["ItemModifier"],
  ItemModifierGroup: ["ItemModifierGroup"],
  Monster: ["Monster"],
  WorkshopType: ["WorkshopType"],
  LocationComplexTemplate: ["LocationComplexTemplate"],
};

/** The reference prefix used in other files to point at an object with this tag. */
export function refPrefixForTag(tag: string): string {
  if (tag === "CraftedItem") return "Item";
  if (tag === "MBPartyTemplate") return "PartyTemplate";
  return tag;
}

export function tagsForPrefix(prefix: string): string[] {
  return REF_PREFIX_TAGS[prefix] ?? [prefix];
}

export function displayName(raw: string | undefined): string {
  if (!raw) return "";
  const m = STRING_RE.exec(raw);
  return m ? m[2] : raw;
}

function implicitRef(el: XElem, attr: string, value: string): string | null {
  if (!value || value.includes(".")) return null;
  if (el.name === "EquipmentSet" && attr === "id") return `EquipmentRoster.${value}`;
  if (el.name === "Piece" && attr === "id") return `CraftingPiece.${value}`;
  if (el.name === "CraftedItem" && attr === "crafting_template") return `CraftingTemplate.${value}`;
  return null;
}

/** References ("Item.x", implicit EquipmentSet/Piece ids...) used inside an XML snippet. */
export function collectRefsFromXml(xml: string, skipRootId = true): string[] {
  const refs = new Set<string>();
  scanXml(xml, {
    maxErrors: 5,
    onOpen: (el) => {
      for (const a of el.attrs) {
        if (skipRootId && el.depth === 0 && a.name === "id") continue;
        const v = a.value;
        const c0 = v.charCodeAt(0);
        if (c0 >= 65 && c0 <= 90 && REF_RE.test(v)) refs.add(v);
        const imp = implicitRef(el, a.name, v);
        if (imp) refs.add(imp);
      }
    },
  });
  return [...refs];
}

/** True when references with this prefix point at XML-defined objects we can check. */
export function isCheckablePrefix(prefix: string, knownTags: Set<string>): boolean {
  if (REF_PREFIX_TAGS[prefix]) return true;
  return knownTags.has(prefix);
}

/** Scans one XML data file. */
export function indexDataFile(abs: string, rel: string, module: string, xmlIds: string[], stat: fs.Stats): FileRec {
  const rec: FileRec = {
    abs,
    rel,
    module,
    kind: "data",
    xmlIds,
    registered: xmlIds.length > 0,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    objects: [],
    strings: [],
    errors: [],
  };
  let text: string;
  try {
    text = readTextFile(abs).text;
  } catch (e) {
    rec.errors.push({ message: `Cannot read file: ${(e as Error).message}`, line: 0, col: 0, offset: 0 });
    return rec;
  }
  let current: ObjRec | null = null;
  const refSet = new Set<string>();
  const res = scanXml(text, {
    maxErrors: 20,
    onOpen: (el) => {
      if (el.depth === 0) {
        rec.rootTag = el.name;
        return;
      }
      const id = el.depth <= 2 ? getAttr(el, "id") : undefined;
      if (!current && id !== undefined && (el.depth === 1 || (el.depth === 2 && el.parent && getAttr(el.parent, "id") === undefined))) {
        current = {
          tag: el.name,
          id,
          name: getAttr(el, "name"),
          module,
          file: rec,
          line: el.line,
          start: el.start,
          end: el.end,
          depth: el.depth,
          parentTag: el.depth === 2 ? el.parent!.name : undefined,
          attrs: el.attrs.map((a) => [a.name, a.value] as [string, string]),
          refs: [],
        };
        refSet.clear();
      }
      for (const a of el.attrs) {
        const v = a.value;
        if (!v) continue;
        if (v.charCodeAt(0) === 123 /* { */ && v.charCodeAt(1) === 61 /* = */) {
          const m = STRING_RE.exec(v);
          if (m) rec.strings.push({ id: m[1], text: m[2], attr: a.name, tag: el.name, line: el.line });
          continue;
        }
        const isObjectEl = current !== null && el.start === current.start;
        if (isPlainLocalizableText(el.name, a.name, v, isObjectEl)) {
          rec.strings.push({ id: "", text: v, attr: a.name, tag: el.name, line: el.line, missingId: true });
        }
        if (current) {
          if (a.name === "id" && isObjectEl) continue;
          const c0 = v.charCodeAt(0);
          if (c0 >= 65 && c0 <= 90) {
            const m = REF_RE.exec(v);
            if (m) refSet.add(v);
          }
          const imp = implicitRef(el, a.name, v);
          if (imp) refSet.add(imp);
        }
      }
    },
    onClose: (el) => {
      if (current && el.start === current.start) {
        current.end = el.end;
        current.refs = [...refSet];
        rec.objects.push(current);
        current = null;
      }
    },
  });
  rec.errors.push(...res.errors);
  return rec;
}

export function indexXsltFile(abs: string, rel: string, module: string, xmlIds: string[], stat: fs.Stats): FileRec {
  const rec: FileRec = {
    abs,
    rel,
    module,
    kind: "xslt",
    xmlIds,
    registered: xmlIds.length > 0,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    objects: [],
    strings: [],
    errors: [],
    xsltRules: [],
  };
  try {
    const { text } = readTextFile(abs);
    const res = scanXml(text, {
      maxErrors: 10,
      onOpen: (el) => {
        if (el.depth === 0) rec.rootTag = el.name;
        if (el.depth === 1 && /(^|:)template$/.test(el.name)) {
          const match = getAttr(el, "match");
          if (!match || match === "@*|node()" || match === "node()|@*") return;
          const ids = [...match.matchAll(/@id\s*=\s*(['"])(.*?)\1/g)].map((m) => m[2]);
          const tags = [...match.matchAll(/([A-Za-z_][\w.-]*)\s*\[\s*@id/g)].map((m) => m[1]);
          rec.xsltRules!.push({ match, line: el.line, ids, tags });
        }
      },
    });
    rec.errors.push(...res.errors);
  } catch (e) {
    rec.errors.push({ message: `Cannot read file: ${(e as Error).message}`, line: 0, col: 0, offset: 0 });
  }
  return rec;
}

function walkFiles(dir: string, out: string[], skipLanguages: boolean, depth = 0): void {
  if (depth > 12) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (isDirEntry(e, p)) {
      // Localization folders (at any depth) hold <string> tables, not game objects.
      if (skipLanguages && e.name.toLowerCase() === "languages") continue;
      walkFiles(p, out, skipLanguages, depth + 1);
    } else if (/\.(xml|xslt)$/i.test(e.name)) out.push(p);
  }
}

/** Files listed in ModuleData/project.mbproj (loaded by the engine itself): abs path (lowercase) → type. */
export function engineFiles(moduleDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const proj = path.join(moduleDir, "ModuleData", "project.mbproj");
  let text: string;
  try {
    text = readTextFile(proj).text;
  } catch {
    return out;
  }
  scanXml(text, {
    maxErrors: 3,
    onOpen: (el) => {
      if (el.depth !== 1) return;
      const name = getAttr(el, "name");
      if (!name) return;
      out.set(path.resolve(moduleDir, ...name.split(/[\\/]/)).toLowerCase(), getAttr(el, "type") ?? el.name);
    },
  });
  return out;
}

export interface IndexStats {
  modules: number;
  files: number;
  objects: number;
  builtMs: number;
}

/**
 * In-memory index of every object (top-level element with an id) in every module's ModuleData,
 * refreshed incrementally by file mtime/size.
 */
export class ObjectIndex {
  private perModule = new Map<string, ModuleIndex>();
  private byIdCache: Map<string, ObjRec[]> | null = null;
  private refsCache: Map<string, ObjRec[]> | null = null;
  private stringIdCache: Map<string, StringRec & { module: string; file: FileRec }> | null = null;
  lastBuildMs = 0;

  constructor(private readonly registry: ModuleRegistry) {}

  private invalidateCaches(): void {
    this.byIdCache = null;
    this.refsCache = null;
    this.stringIdCache = null;
  }

  /** Re-indexes changed files. Read-only modules are re-checked at most every `roMaxAgeMs`. */
  ensure(modules: ModuleInfo[] = this.registry.modules, roMaxAgeMs = 30000): void {
    const t0 = Date.now();
    let changed = false;
    for (const key of [...this.perModule.keys()]) {
      const live = this.registry.get(key);
      if (!live || live.dir !== this.perModule.get(key)!.module.dir) {
        this.perModule.delete(key);
        changed = true;
      }
    }
    for (const mod of modules) {
      const key = mod.id.toLowerCase();
      let mi = this.perModule.get(key);
      if (mi && !mod.writable && mi.module.dir === mod.dir && Date.now() - mi.checkedAt < roMaxAgeMs) {
        mi.module = mod;
        continue;
      }
      if (!mi) {
        mi = { module: mod, files: new Map(), checkedAt: 0 };
        this.perModule.set(key, mi);
      }
      mi.module = mod;
      if (this.refreshModule(mi)) changed = true;
      mi.checkedAt = Date.now();
    }
    if (changed) {
      this.invalidateCaches();
      this.lastBuildMs = Date.now() - t0;
    }
  }

  /** Returns true when anything changed. */
  private refreshModule(mi: ModuleIndex): boolean {
    const mod = mi.module;
    const dataDir = path.join(mod.dir, "ModuleData");
    const files: string[] = [];
    walkFiles(dataDir, files, true);
    // Map registered files to XmlName ids.
    const reg = new Map<string, string[]>();
    for (const node of mod.xmls) {
      const r = resolveXmlNode(mod, node);
      for (const s of r.steps) {
        for (const p of [s.xml, s.xslt]) {
          if (!p) continue;
          const k = path.resolve(p).toLowerCase();
          const list = reg.get(k) ?? [];
          if (!list.includes(node.id)) list.push(node.id);
          reg.set(k, list);
        }
      }
    }
    const engine = engineFiles(mod.dir);
    let changed = false;
    const seen = new Set<string>();
    for (const abs of files) {
      const key = abs.toLowerCase();
      seen.add(key);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      const xmlIds = reg.get(path.resolve(abs).toLowerCase()) ?? [];
      const engineType = engine.get(path.resolve(abs).toLowerCase());
      const old = mi.files.get(key);
      if (old && old.mtimeMs === st.mtimeMs && old.size === st.size && old.xmlIds.join("|") === xmlIds.join("|") && old.engineType === engineType) continue;
      const rel = path.relative(mod.dir, abs).split(path.sep).join("/");
      const rec = /\.xslt$/i.test(abs) ? indexXsltFile(abs, rel, mod.id, xmlIds, st) : indexDataFile(abs, rel, mod.id, xmlIds, st);
      if (engineType) {
        rec.engineType = engineType;
        rec.registered = true;
      }
      mi.files.set(key, rec);
      changed = true;
    }
    for (const key of [...mi.files.keys()]) {
      if (!seen.has(key)) {
        mi.files.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  /** Forces a re-check of one module on next access (after we wrote to it). */
  touch(moduleId: string): void {
    const mi = this.perModule.get(moduleId.toLowerCase());
    if (mi) mi.checkedAt = 0;
  }

  files(moduleIds?: Iterable<string>): FileRec[] {
    const out: FileRec[] = [];
    const filter = moduleIds ? new Set([...moduleIds].map((m) => m.toLowerCase())) : null;
    for (const [key, mi] of this.perModule) {
      if (filter && !filter.has(key)) continue;
      for (const f of mi.files.values()) out.push(f);
    }
    return out;
  }

  moduleFiles(moduleId: string): FileRec[] {
    return [...(this.perModule.get(moduleId.toLowerCase())?.files.values() ?? [])];
  }

  *objects(moduleIds?: Iterable<string>): Generator<ObjRec> {
    for (const f of this.files(moduleIds)) for (const o of f.objects) yield o;
  }

  private byId(): Map<string, ObjRec[]> {
    if (!this.byIdCache) {
      const m = new Map<string, ObjRec[]>();
      for (const mi of this.perModule.values()) {
        for (const f of mi.files.values()) {
          for (const o of f.objects) {
            const list = m.get(o.id);
            if (list) list.push(o);
            else m.set(o.id, [o]);
          }
        }
      }
      this.byIdCache = m;
    }
    return this.byIdCache;
  }

  /** All definitions with this id (optionally restricted to tags). */
  find(id: string, tags?: string[]): ObjRec[] {
    const list = this.byId().get(id) ?? [];
    return tags && tags.length ? list.filter((o) => tags.includes(o.tag)) : list;
  }

  /**
   * Resolves "Item.foo", "CraftedItem.foo", "foo" or "Culture.empire" to definitions.
   */
  lookup(ref: string): { prefix?: string; id: string; matches: ObjRec[] } {
    const r = ref.trim();
    const m = /^([A-Za-z][A-Za-z]*)\.(.+)$/.exec(r);
    if (m) {
      const tags = new Set([...tagsForPrefix(m[1]), m[1]]);
      const matches = this.find(m[2]).filter((o) => tags.has(o.tag) || refPrefixForTag(o.tag) === m[1]);
      if (matches.length) return { prefix: m[1], id: m[2], matches };
      // Maybe the id itself contains a dot.
      const whole = this.find(r);
      if (whole.length) return { id: r, matches: whole };
      return { prefix: m[1], id: m[2], matches: [] };
    }
    return { id: r, matches: this.find(r) };
  }

  /** Reverse reference map: "Item.foo" → objects referencing it. */
  referencesTo(refKey: string): ObjRec[] {
    if (!this.refsCache) {
      const m = new Map<string, ObjRec[]>();
      for (const mi of this.perModule.values()) {
        for (const f of mi.files.values()) {
          for (const o of f.objects) {
            for (const r of o.refs) {
              const list = m.get(r);
              if (list) list.push(o);
              else m.set(r, [o]);
            }
          }
        }
      }
      this.refsCache = m;
    }
    return this.refsCache.get(refKey) ?? [];
  }

  /** Known string ids (from data files of all indexed modules) → first occurrence. */
  stringIds(): Map<string, StringRec & { module: string; file: FileRec }> {
    if (!this.stringIdCache) {
      const m = new Map<string, StringRec & { module: string; file: FileRec }>();
      for (const mi of this.perModule.values()) {
        for (const f of mi.files.values()) {
          for (const s of f.strings) {
            if (!s.id || s.id === "!" || s.id === "*" || m.has(s.id)) continue;
            m.set(s.id, { ...s, module: f.module, file: f });
          }
        }
      }
      this.stringIdCache = m;
    }
    return this.stringIdCache;
  }

  /** tag → (XmlName id → count), learned from registered files of official modules. */
  tagXmlIds(): Map<string, Map<string, number>> {
    const out = new Map<string, Map<string, number>>();
    for (const mi of this.perModule.values()) {
      for (const f of mi.files.values()) {
        if (f.kind !== "data" || !f.registered) continue;
        for (const o of f.objects) {
          if (o.depth !== 1) continue;
          let m = out.get(o.tag);
          if (!m) out.set(o.tag, (m = new Map()));
          for (const x of f.xmlIds) m.set(x, (m.get(x) ?? 0) + (mi.module.official ? 10 : 1));
        }
      }
    }
    return out;
  }

  /** The most likely XmlName id for objects with this tag (e.g. CraftedItem → Items). */
  xmlIdForTag(tag: string): string | undefined {
    const m = this.tagXmlIds().get(tag);
    if (!m) return FALLBACK_XMLID[tag];
    let best: string | undefined;
    let bestN = -1;
    for (const [k, n] of m) if (n > bestN) [best, bestN] = [k, n];
    return best;
  }

  /** Root element name used by official files registered under an XmlName id (e.g. Items, NPCCharacters). */
  rootTagForXmlId(xmlId: string): string | undefined {
    const counts = new Map<string, number>();
    for (const mi of this.perModule.values()) {
      for (const f of mi.files.values()) {
        if (f.kind !== "data" || !f.rootTag || !f.xmlIds.includes(xmlId)) continue;
        counts.set(f.rootTag, (counts.get(f.rootTag) ?? 0) + (mi.module.official ? 10 : 1));
      }
    }
    let best: string | undefined;
    let bestN = -1;
    for (const [k, n] of counts) if (n > bestN) [best, bestN] = [k, n];
    return best ?? FALLBACK_ROOT[xmlId];
  }

  /** All known tags (object element names). */
  knownTags(): Set<string> {
    const s = new Set<string>();
    for (const mi of this.perModule.values()) for (const f of mi.files.values()) for (const o of f.objects) s.add(o.tag);
    return s;
  }

  stats(): IndexStats {
    let files = 0;
    let objects = 0;
    for (const mi of this.perModule.values()) {
      files += mi.files.size;
      for (const f of mi.files.values()) objects += f.objects.length;
    }
    return { modules: this.perModule.size, files, objects, builtMs: this.lastBuildMs };
  }

  /** XSLT rules (from any module) that target this object id. */
  xsltRulesFor(id: string, tag?: string): Array<{ file: FileRec; rule: XsltRuleRec }> {
    const out: Array<{ file: FileRec; rule: XsltRuleRec }> = [];
    for (const mi of this.perModule.values()) {
      for (const f of mi.files.values()) {
        if (f.kind !== "xslt" || !f.xsltRules) continue;
        for (const r of f.xsltRules) if (r.ids[0] === id && (!tag || !r.tags[0] || r.tags[0] === tag)) out.push({ file: f, rule: r });
      }
    }
    return out;
  }
}

/** Used only when no official data is indexed (game folder not found). */
const FALLBACK_XMLID: Record<string, string> = {
  Item: "Items",
  CraftedItem: "Items",
  NPCCharacter: "NPCCharacters",
  Hero: "Heroes",
  Faction: "Factions",
  Kingdom: "Kingdoms",
  Settlement: "Settlements",
  Culture: "SPCultures",
  CraftingPiece: "CraftingPieces",
  MBPartyTemplate: "partyTemplates",
  EquipmentRoster: "EquipmentRosters",
  BodyProperty: "BodyProperties",
  SkillSet: "SkillSets",
  string: "GameText",
  Concept: "Concepts",
  WorkshopType: "WorkshopTypes",
  ItemModifier: "ItemModifiers",
  ItemModifierGroup: "ItemModifierGroups",
};

const FALLBACK_ROOT: Record<string, string> = {
  Items: "Items",
  NPCCharacters: "NPCCharacters",
  Heroes: "Heroes",
  Factions: "Factions",
  Kingdoms: "Kingdoms",
  Settlements: "Settlements",
  SPCultures: "SPCultures",
  CraftingPieces: "CraftingPieces",
  partyTemplates: "partyTemplates",
  EquipmentRosters: "EquipmentRosters",
  BodyProperties: "BodyProperties",
  SkillSets: "SkillSets",
  GameText: "base",
};
