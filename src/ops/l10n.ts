import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ModuleInfo, ModuleRegistry } from "../model/modules.js";
import { isPlainLocalizableText, parseLocalized, type ObjectIndex } from "../model/objects.js";
import { encodeText, fixXmlDeclarationEncoding, readTextFile } from "../util/text.js";
import { applyEdits, detectIndentUnit, insertChildEdit, setAttributesEdits, type Edit } from "../xml/edit.js";
import { childElements, escapeAttr, firstChild, getAttr, parseTree, scanXml, type XElem } from "../xml/scanner.js";
import { checkWellFormed } from "../xml/wellformed.js";
import type { Transaction } from "./history.js";
import { isDirEntry, isFileEntry } from "../util/fsx.js";

export interface LanguageDef {
  id: string;
  name: string;
  /** Folder used for a mod's files of this language (e.g. CNs). */
  folder: string;
  subtitleExtension: string;
  supportedIso: string;
  textProcessor?: string;
}

const FALLBACK_LANGS: LanguageDef[] = [
  { id: "English", name: "English", folder: "EN", subtitleExtension: "en-GB", supportedIso: "en-GB,en-US,en,eng,en-us,en-gb", textProcessor: "TaleWorlds.Localization.TextProcessor.LanguageProcessors.EnglishTextProcessor" },
  { id: "简体中文", name: "简体中文", folder: "CNs", subtitleExtension: "zh-HANS", supportedIso: "zh-HANS,zh,zho,chi,zh-cn,zh-sg" },
  { id: "繁體中文", name: "繁體中文", folder: "CNt", subtitleExtension: "zh-HANT", supportedIso: "zh-HANT,zh-tw,zh-hk" },
  { id: "Deutsch", name: "Deutsch", folder: "DE", subtitleExtension: "de", supportedIso: "de,deu,ger,de-de,de-at,de-li,de-lu,de-ch", textProcessor: "TaleWorlds.Localization.TextProcessor.LanguageProcessors.GermanTextProcessor" },
  { id: "Français", name: "Français", folder: "FR", subtitleExtension: "fr", supportedIso: "fr,fra,fr-fr,fr-be,fr-ca,fr-ch", textProcessor: "TaleWorlds.Localization.TextProcessor.LanguageProcessors.FrenchTextProcessor" },
  { id: "Italiano", name: "Italiano", folder: "IT", subtitleExtension: "it", supportedIso: "it,ita,it-it,it-ch", textProcessor: "TaleWorlds.Localization.TextProcessor.LanguageProcessors.ItalianTextProcessor" },
  { id: "日本語", name: "日本語", folder: "JP", subtitleExtension: "jp", supportedIso: "ja,jpn,ja-ja,ja-jp,jp-jp" },
  { id: "한국어", name: "한국어", folder: "KO", subtitleExtension: "ko", supportedIso: "ko-kr,ko,kor,kr-kr" },
  { id: "Polski", name: "Polski", folder: "PL", subtitleExtension: "pl", supportedIso: "pl,pol,pl-pl", textProcessor: "TaleWorlds.Localization.TextProcessor.LanguageProcessors.PolishTextProcessor" },
  { id: "Português (BR)", name: "Português (BR)", folder: "BR", subtitleExtension: "pt", supportedIso: "pt,por,pt-pt,pt-br" },
  { id: "Русский", name: "Русский", folder: "RU", subtitleExtension: "ru", supportedIso: "ru,rus,ru-ru,ru-md", textProcessor: "TaleWorlds.Localization.TextProcessor.LanguageProcessors.RussianTextProcessor" },
  { id: "Español (LA)", name: "Español (LA)", folder: "SP", subtitleExtension: "es", supportedIso: "es,spa,es-es,es-mx", textProcessor: "TaleWorlds.Localization.TextProcessor.LanguageProcessors.SpanishTextProcessor" },
  { id: "Türkçe", name: "Türkçe", folder: "TR", subtitleExtension: "tr-TR", supportedIso: "tr,tur,tr-tr", textProcessor: "TaleWorlds.Localization.TextProcessor.LanguageProcessors.TurkishTextProcessor" },
];

const ALIASES: Record<string, string> = {
  zh: "CNs", "zh-cn": "CNs", "zh-hans": "CNs", "zh-sg": "CNs", chs: "CNs", cn: "CNs", cns: "CNs", chinese: "CNs", "simplified chinese": "CNs", schinese: "CNs", 简体中文: "CNs", 简中: "CNs", 中文: "CNs",
  "zh-tw": "CNt", "zh-hk": "CNt", "zh-hant": "CNt", cht: "CNt", cnt: "CNt", "traditional chinese": "CNt", tchinese: "CNt", 繁体中文: "CNt", 繁體中文: "CNt", 繁中: "CNt",
  en: "EN", english: "EN", eng: "EN", "en-us": "EN", "en-gb": "EN",
  de: "DE", german: "DE", deutsch: "DE", fr: "FR", french: "FR", it: "IT", italian: "IT",
  ja: "JP", jp: "JP", japanese: "JP", ko: "KO", kr: "KO", korean: "KO", pl: "PL", polish: "PL",
  ru: "RU", russian: "RU", es: "SP", sp: "SP", spanish: "SP", tr: "TR", turkish: "TR", pt: "BR", "pt-br": "BR", br: "BR", portuguese: "BR",
};

let langCache: { key: string; langs: LanguageDef[] } | null = null;

/** Languages known to the game, read from Native/ModuleData/Languages. */
export function knownLanguages(registry: ModuleRegistry): LanguageDef[] {
  const native = registry.get("Native");
  const key = native?.dir ?? "";
  if (langCache && langCache.key === key) return langCache.langs;
  const langs: LanguageDef[] = [];
  if (native) {
    const root = path.join(native.dir, "ModuleData", "Languages");
    const candidates: Array<[string, string]> = [["", path.join(root, "language_data.xml")]];
    try {
      for (const d of fs.readdirSync(root, { withFileTypes: true })) if (isDirEntry(d, path.join(root, d.name))) candidates.push([d.name, path.join(root, d.name, "language_data.xml")]);
    } catch {
      /* no languages */
    }
    for (const [folder, file] of candidates) {
      try {
        const { text } = readTextFile(file);
        const { root: el } = parseTree(text, 3);
        if (!el || el.name !== "LanguageData") continue;
        const id = getAttr(el, "id");
        if (!id) continue;
        langs.push({
          id,
          name: getAttr(el, "name") ?? id,
          folder: folder || "EN",
          subtitleExtension: getAttr(el, "subtitle_extension") ?? "",
          supportedIso: getAttr(el, "supported_iso") ?? "",
          textProcessor: getAttr(el, "text_processor"),
        });
      } catch {
        /* skip */
      }
    }
  }
  const result = langs.length ? langs : FALLBACK_LANGS;
  langCache = { key, langs: result };
  return result;
}

export function resolveLanguage(input: string, langs: LanguageDef[]): LanguageDef {
  const q = input.trim();
  const lower = q.toLowerCase();
  const byFolder = (f: string): LanguageDef | undefined => langs.find((l) => l.folder.toLowerCase() === f.toLowerCase());
  const direct =
    byFolder(q) ??
    langs.find((l) => l.id.toLowerCase() === lower || l.name.toLowerCase() === lower) ??
    langs.find((l) => l.supportedIso.toLowerCase().split(",").map((s) => s.trim()).includes(lower));
  if (direct) return direct;
  const alias = ALIASES[lower];
  if (alias) {
    const l = byFolder(alias);
    if (l) return l;
  }
  throw new Error(`Unknown language '${input}'. Known: ${langs.map((l) => `${l.folder} (${l.id})`).join(", ")}`);
}

// ---- module language files ----------------------------------------------------------------------

export interface LangEntry {
  text: string;
  line: number;
}

export interface LangFile {
  abs: string;
  /** Path relative to ModuleData/Languages (as used in xml_path). */
  xmlPath: string;
  exists: boolean;
  entries: Map<string, LangEntry>;
}

export interface ModuleLanguage {
  lang: LanguageDef;
  languagesDir: string;
  languageDataFiles: string[];
  files: LangFile[];
}

function findLanguageDataFiles(languagesDir: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (isDirEntry(e, p) && depth < 3) visit(p, depth + 1);
      else if (isFileEntry(e, p) && e.name.toLowerCase() === "language_data.xml") out.push(p);
    }
  };
  visit(languagesDir, 0);
  return out;
}

export function readStringsFile(file: string): Map<string, LangEntry> {
  const entries = new Map<string, LangEntry>();
  let text: string;
  try {
    text = readTextFile(file).text;
  } catch {
    return entries;
  }
  scanXml(text, {
    maxErrors: 5,
    onOpen: (el) => {
      if (el.name !== "string") return;
      const id = getAttr(el, "id");
      if (id === undefined) return;
      if (!entries.has(id)) entries.set(id, { text: getAttr(el, "text") ?? "", line: el.line });
    },
  });
  return entries;
}

export function loadModuleLanguage(mod: ModuleInfo, lang: LanguageDef): ModuleLanguage {
  const languagesDir = path.join(mod.dir, "ModuleData", "Languages");
  const ml: ModuleLanguage = { lang, languagesDir, languageDataFiles: [], files: [] };
  for (const ld of findLanguageDataFiles(languagesDir)) {
    try {
      const { text } = readTextFile(ld);
      const { root } = parseTree(text, 3);
      if (!root || root.name !== "LanguageData" || getAttr(root, "id") !== lang.id) continue;
      ml.languageDataFiles.push(ld);
      for (const lf of childElements(root, "LanguageFile")) {
        const xp = getAttr(lf, "xml_path");
        if (!xp) continue;
        const abs = path.join(languagesDir, ...xp.split(/[\\/]/));
        if (ml.files.some((f) => f.abs.toLowerCase() === abs.toLowerCase())) continue;
        const exists = fs.existsSync(abs);
        ml.files.push({ abs, xmlPath: xp.replace(/\\/g, "/"), exists, entries: exists ? readStringsFile(abs) : new Map() });
      }
    } catch {
      /* skip unreadable */
    }
  }
  return ml;
}

const langMapCache = new Map<string, { stamp: string; map: Map<string, string> }>();

/** id → translated text for a language, merged over all given modules (later modules win). */
export function languageMap(mods: ModuleInfo[], lang: LanguageDef): Map<string, string> {
  const stamp = mods.map((m) => m.dir).join("|");
  const cached = langMapCache.get(lang.id);
  if (cached && cached.stamp === stamp) return cached.map;
  const map = new Map<string, string>();
  for (const m of mods) {
    const ml = loadModuleLanguage(m, lang);
    for (const f of ml.files) for (const [id, e] of f.entries) map.set(id, e.text);
  }
  langMapCache.set(lang.id, { stamp, map });
  return map;
}

// ---- source strings -------------------------------------------------------------------------------

export interface SourceString {
  id: string;
  text: string;
  file: string;
  line: number;
  attr: string;
  tag: string;
  kind: "xml" | "gui" | "code";
  missingId?: boolean;
}

function walk(dir: string, filter: (name: string) => boolean, out: string[], skipDirs: Set<string>, depth = 0): void {
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
      if (!skipDirs.has(e.name.toLowerCase())) walk(p, filter, out, skipDirs, depth + 1);
    } else if (filter(e.name)) out.push(p);
  }
}

const CS_STRING_RE = /"\{=([A-Za-z0-9_.!\-]*)\}((?:[^"\\\r\n]|\\.)*)"/g;

export function collectModuleStrings(index: ObjectIndex, mod: ModuleInfo, opts: { code: boolean; codeDir?: string }): SourceString[] {
  const out: SourceString[] = [];
  for (const f of index.moduleFiles(mod.id)) {
    if (f.kind !== "data") continue;
    for (const s of f.strings) out.push({ ...s, file: f.rel, kind: "xml" });
  }
  const gui: string[] = [];
  walk(path.join(mod.dir, "GUI"), (n) => n.toLowerCase().endsWith(".xml"), gui, new Set());
  for (const g of gui) {
    let text: string;
    try {
      text = readTextFile(g).text;
    } catch {
      continue;
    }
    const rel = path.relative(mod.dir, g).split(path.sep).join("/");
    scanXml(text, {
      maxErrors: 1,
      onOpen: (el) => {
        for (const a of el.attrs) {
          const loc = a.value.startsWith("{=") ? parseLocalized(a.value) : null;
          if (loc) out.push({ id: loc.id, text: loc.text, file: rel, line: el.line, attr: a.name, tag: el.name, kind: "gui" });
        }
      },
    });
  }
  if (opts.code) {
    const roots = opts.codeDir ? [path.resolve(opts.codeDir)] : [mod.dir];
    const files: string[] = [];
    for (const r of roots) walk(r, (n) => n.toLowerCase().endsWith(".cs"), files, new Set(["bin", "obj", ".git", ".vs", "node_modules", "packages"]));
    for (const f of files.slice(0, 5000)) {
      let text: string;
      try {
        text = readTextFile(f).text;
      } catch {
        continue;
      }
      const rel = path.relative(mod.dir, f).split(path.sep).join("/");
      for (const m of text.matchAll(CS_STRING_RE)) {
        const line = text.slice(0, m.index).split("\n").length;
        const t = m[2].replace(/\\(["\\])/g, "$1").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
        out.push({ id: m[1], text: t, file: rel, line, attr: "", tag: "", kind: "code" });
      }
    }
  }
  return out;
}

export interface L10nSummary {
  sources: SourceString[];
  /** id → first source occurrence (ids other than "" and "!"). */
  unique: Map<string, SourceString>;
  /** ids used with different texts inside the module. */
  conflicts: Map<string, Set<string>>;
  missing: SourceString[];
  emptyIds: SourceString[];
  noLocalize: number;
}

export function summarize(sources: SourceString[]): L10nSummary {
  const unique = new Map<string, SourceString>();
  const texts = new Map<string, Set<string>>();
  const missing: SourceString[] = [];
  const emptyIds: SourceString[] = [];
  let noLocalize = 0;
  for (const s of sources) {
    if (s.missingId) {
      missing.push(s);
      continue;
    }
    if (s.id === "!" || s.id === "*") {
      // {=!} and {=*} mark text that is intentionally not localized.
      noLocalize++;
      continue;
    }
    if (s.id === "") {
      emptyIds.push(s);
      continue;
    }
    if (!unique.has(s.id)) unique.set(s.id, s);
    let t = texts.get(s.id);
    if (!t) texts.set(s.id, (t = new Set()));
    t.add(s.text);
  }
  const conflicts = new Map<string, Set<string>>();
  for (const [id, t] of texts) if (t.size > 1) conflicts.set(id, t);
  return { sources, unique, conflicts, missing, emptyIds, noLocalize };
}

/** Text variables like {PLAYER.NAME}, {?IS_FEMALE}…{\?} must survive translation. */
export function placeholders(text: string): string[] {
  return (text.match(/\{[^{}\s]*\}/g) ?? []).map((t) => t.toUpperCase()).sort();
}

export function placeholderMismatch(source: string, translation: string): string | null {
  const a = placeholders(source);
  const b = placeholders(translation);
  if (a.join("|") === b.join("|")) return null;
  return `placeholders differ: source ${a.join(" ") || "(none)"} vs translation ${b.join(" ") || "(none)"}`;
}

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function generateStringId(taken: Set<string>): string {
  for (;;) {
    const bytes = crypto.randomBytes(8);
    let id = "";
    for (const b of bytes) id += ID_CHARS[b % ID_CHARS.length];
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

/** All string ids known anywhere (data files + this module's language files), for collision-free generation. */
export function takenStringIds(index: ObjectIndex, sources: SourceString[]): Set<string> {
  const taken = new Set<string>(index.stringIds().keys());
  for (const s of sources) if (s.id) taken.add(s.id);
  return taken;
}

// ---- fixing ids in data files --------------------------------------------------------------------

export interface FixResult {
  file: string;
  assigned: number;
  regenerated: number;
  samples: string[];
}

/**
 * Adds {=id} to plain player-facing texts and re-generates ids for which `regenerate(id, text)`
 * returns a new id (callers share one new id per (old id, text) pair).
 */
export function fixDataFileIds(
  tx: Transaction,
  absFile: string,
  relFile: string,
  taken: Set<string>,
  regenerate: (id: string, text: string) => string | null,
  assignMissing = true,
): FixResult {
  const tf = readTextFile(absFile);
  const text = tf.text;
  const { root } = parseTree(text, 5);
  const res: FixResult = { file: relFile, assigned: 0, regenerated: 0, samples: [] };
  if (!root) return res;
  const edits: Edit[] = [];
  const visit = (el: XElem, isObjectEl: boolean): void => {
    const changes: Array<[string, string | null]> = [];
    for (const a of el.attrs) {
      const v = a.value;
      if (assignMissing && isPlainLocalizableText(el.name, a.name, v, isObjectEl)) {
        const id = generateStringId(taken);
        changes.push([a.name, `{=${id}}${v}`]);
        res.assigned++;
        if (res.samples.length < 8) res.samples.push(`line ${el.line} ${el.name}@${a.name}: {=${id}}${v.slice(0, 40)}`);
        continue;
      }
      const loc = v.startsWith("{=") ? parseLocalized(v) : null;
      if (!loc) continue;
      if (loc.id === "" && loc.text.trim()) {
        if (!assignMissing) continue;
        const id = generateStringId(taken);
        changes.push([a.name, `{=${id}}${loc.text}`]);
        res.assigned++;
        if (res.samples.length < 8) res.samples.push(`line ${el.line} ${el.name}@${a.name}: {=${id}}${loc.text.slice(0, 40)}`);
      } else if (loc.id && loc.id !== "!" && loc.id !== "*") {
        const id = regenerate(loc.id, loc.text);
        if (!id) continue;
        changes.push([a.name, `{=${id}}${loc.text}`]);
        res.regenerated++;
        if (res.samples.length < 8) res.samples.push(`line ${el.line} ${el.name}@${a.name}: {=${loc.id}} -> {=${id}}`);
      }
    }
    if (changes.length) edits.push(...setAttributesEdits(text, el, changes));
    for (const c of el.children ?? []) {
      const childIsObject = (c.depth === 1 && getAttr(c, "id") !== undefined) || (c.depth === 2 && getAttr(c, "id") !== undefined && getAttr(el, "id") === undefined);
      visit(c, childIsObject);
    }
  };
  visit(root, false);
  if (edits.length) {
    const out = applyEdits(text, edits);
    const problems = checkWellFormed(out, 1);
    if (problems.length) throw new Error(`Internal error while fixing ids in ${relFile}: ${problems[0].message}`);
    tx.write(absFile, encodeText(out, tf.encoding));
  }
  return res;
}

// ---- writing translations ------------------------------------------------------------------------

function newStringsFile(lang: LanguageDef, eol: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<base xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" type="string">',
    "\t<tags>",
    `\t\t<tag language="${escapeAttr(lang.id)}" />`,
    "\t</tags>",
    "\t<strings>",
    "\t</strings>",
    "</base>",
    "",
  ].join(eol);
}

function newLanguageData(lang: LanguageDef, xmlPath: string, eol: string): string {
  const attrs = [
    `id="${escapeAttr(lang.id)}"`,
    `name="${escapeAttr(lang.name)}"`,
    `subtitle_extension="${escapeAttr(lang.subtitleExtension)}"`,
    `supported_iso="${escapeAttr(lang.supportedIso)}"`,
  ];
  if (lang.textProcessor) attrs.push(`text_processor="${escapeAttr(lang.textProcessor)}"`);
  attrs.push('under_development="false"');
  return ['<?xml version="1.0" encoding="utf-8"?>', `<LanguageData ${attrs.join(" ")}>`, `\t<LanguageFile xml_path="${escapeAttr(xmlPath)}" />`, "</LanguageData>", ""].join(eol);
}

export interface SetTranslationsResult {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  files: string[];
  warnings: string[];
}

/**
 * Writes translations into the module's language files (creating language_data.xml and a strings
 * file when needed). `entries` maps string id → translated text.
 */
export function setTranslations(
  tx: Transaction,
  mod: ModuleInfo,
  lang: LanguageDef,
  entries: Array<[string, string]>,
  opts: { file?: string; remove?: string[] },
): SetTranslationsResult {
  const res: SetTranslationsResult = { added: 0, updated: 0, unchanged: 0, removed: 0, files: [], warnings: [] };
  const ml = loadModuleLanguage(mod, lang);
  const eol = "\r\n";
  const defaultXmlPath = (opts.file ?? ml.files.find((f) => f.exists)?.xmlPath ?? `${lang.folder}/${mod.id}_strings.xml`).replace(/\\/g, "/").replace(/^ModuleData\/Languages\//i, "");
  // Group by target file: existing ids stay where they are.
  const byFile = new Map<string, { xmlPath: string; set: Array<[string, string]>; remove: string[] }>();
  const target = (xmlPath: string): { xmlPath: string; set: Array<[string, string]>; remove: string[] } => {
    const key = xmlPath.toLowerCase();
    let t = byFile.get(key);
    if (!t) byFile.set(key, (t = { xmlPath, set: [], remove: [] }));
    return t;
  };
  for (const [id, text] of entries) {
    const holder = ml.files.find((f) => f.entries.has(id));
    target(holder ? holder.xmlPath : defaultXmlPath).set.push([id, text]);
  }
  for (const id of opts.remove ?? []) {
    for (const f of ml.files) if (f.entries.has(id)) target(f.xmlPath).remove.push(id);
  }
  for (const t of byFile.values()) {
    const abs = path.join(ml.languagesDir, ...t.xmlPath.split("/"));
    let text: string;
    let encoding: ReturnType<typeof readTextFile>["encoding"] = "utf8";
    let fileEol: "\r\n" | "\n" = eol;
    if (fs.existsSync(abs)) {
      const tf = readTextFile(abs);
      text = tf.text;
      encoding = tf.encoding;
      fileEol = tf.eol;
    } else text = newStringsFile(lang, eol);
    let { root } = parseTree(text, 5);
    if (!root) throw new Error(`Cannot parse language file ${abs}`);
    if (!firstChild(root, "strings")) {
      text = applyEdits(text, [insertChildEdit(text, root, `<strings>${fileEol}</strings>`, { eol: fileEol, unit: detectIndentUnit(text, root) })]);
      root = parseTree(text, 5).root!;
    }
    const strings = firstChild(root, "strings")!;
    const existing = new Map<string, XElem>();
    for (const s of childElements(strings, "string")) {
      const id = getAttr(s, "id");
      if (id !== undefined && !existing.has(id)) existing.set(id, s);
    }
    const edits: Edit[] = [];
    const newLines: string[] = [];
    const removeSet = new Set(t.remove);
    for (const [id, value] of t.set) {
      const el = existing.get(id);
      if (el) {
        if (getAttr(el, "text") === value) res.unchanged++;
        else {
          edits.push(...setAttributesEdits(text, el, [["text", value]]));
          res.updated++;
        }
      } else {
        newLines.push(`<string id="${escapeAttr(id)}" text="${escapeAttr(value)}" />`);
        existing.set(id, strings);
        res.added++;
      }
    }
    for (const id of removeSet) {
      const el = existing.get(id);
      if (el && el !== strings) {
        const ls = text.lastIndexOf("\n", el.start - 1) + 1;
        const le = text.indexOf("\n", el.end);
        const own = /^[ \t]*$/.test(text.slice(ls, el.start)) && /^[ \t\r]*$/.test(text.slice(el.end, le === -1 ? text.length : le));
        edits.push(own ? { start: ls, end: le === -1 ? text.length : le + 1, text: "" } : { start: el.start, end: el.end, text: "" });
        res.removed++;
      }
    }
    if (newLines.length) edits.push(insertChildEdit(text, strings, newLines.join("\n"), { eol: fileEol, unit: detectIndentUnit(text, root) }));
    if (!edits.length && fs.existsSync(abs)) continue;
    const out = applyEdits(text, edits);
    const problems = checkWellFormed(out, 1);
    if (problems.length) throw new Error(`Internal error: language file would not be well-formed (${problems[0].message}); nothing written.`);
    tx.write(abs, encodeText(fixXmlDeclarationEncoding(out, encoding), encoding));
    res.files.push(path.relative(mod.dir, abs).split(path.sep).join("/"));
  }
  // Make sure a language_data.xml references every file we wrote.
  const written = [...byFile.values()].map((t) => t.xmlPath);
  if (written.length) {
    const ldFile = ml.languageDataFiles[0] ?? path.join(ml.languagesDir, lang.folder, "language_data.xml");
    if (!fs.existsSync(ldFile)) {
      const [first, ...rest] = written;
      let text = newLanguageData(lang, first, eol);
      if (rest.length) {
        const root = parseTree(text, 3).root!;
        text = applyEdits(text, [insertChildEdit(text, root, rest.map((x) => `<LanguageFile xml_path="${escapeAttr(x)}" />`).join("\n"), { eol, unit: "\t" })]);
      }
      tx.write(ldFile, encodeText(text, "utf8"));
      res.files.push(path.relative(mod.dir, ldFile).split(path.sep).join("/"));
    } else {
      const tf = readTextFile(ldFile);
      const { root } = parseTree(tf.text, 3);
      if (root) {
        const have = new Set(childElements(root, "LanguageFile").map((l) => (getAttr(l, "xml_path") ?? "").replace(/\\/g, "/").toLowerCase()));
        const missing = written.filter((w) => !have.has(w.toLowerCase()));
        if (missing.length) {
          const out = applyEdits(tf.text, [
            insertChildEdit(tf.text, root, missing.map((x) => `<LanguageFile xml_path="${escapeAttr(x)}" />`).join("\n"), { eol: tf.eol, unit: detectIndentUnit(tf.text, root) }),
          ]);
          tx.write(ldFile, encodeText(fixXmlDeclarationEncoding(out, tf.encoding), tf.encoding));
          res.files.push(path.relative(mod.dir, ldFile).split(path.sep).join("/"));
        }
      }
    }
  }
  return res;
}
