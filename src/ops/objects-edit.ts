import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "../context.js";
import { resolveXmlNode, type ModuleInfo } from "../model/modules.js";
import { collectRefsFromXml, isCheckablePrefix, refPrefixForTag, type ObjRec } from "../model/objects.js";
import { detectEol, encodeText, fixXmlDeclarationEncoding, readTextFile, type TextEncodingKind } from "../util/text.js";
import { applyEdits, detectIndentUnit, elementSource, insertChildEdit, removeElementEdit, replaceElementEdit, setAttributesEdits, type Edit } from "../xml/edit.js";
import { getAttr, parseMiniPath, parseTree, selectMiniPath, type XElem } from "../xml/scanner.js";
import { checkWellFormed } from "../xml/wellformed.js";
import type { Transaction } from "./history.js";
import { generateStringId } from "./l10n.js";
import { ensureXmlNodeRegistered } from "./submodule.js";

export interface SnippetObject {
  tag: string;
  id: string;
  xml: string;
}

const XML_HINT =
  "Hints: escape '&' as &amp; and '<' as &lt; inside attribute values; every element needs a closing tag or '/>'; attribute values must be quoted.";

/** Checks an XML fragment (one or more elements) and returns it wrapped in a synthetic root. */
export function wrapFragment(xml: string): string {
  const src = xml.replace(/^﻿/, "").trim().replace(/^<\?xml[^>]*\?>\s*/, "");
  if (!src.startsWith("<")) throw new Error("Expected XML starting with '<'.");
  const wrapped = `<__mb2>${src}</__mb2>`;
  const issues = checkWellFormed(wrapped, 5);
  if (issues.length) {
    throw new Error(`The XML is not well-formed:\n${issues.map((i) => `  line ${i.line}, col ${i.line === 1 ? Math.max(1, i.col - 7) : i.col}: ${i.message}`).join("\n")}\n${XML_HINT}`);
  }
  return wrapped;
}

/** Parses one or more objects from XML text. A container (e.g. <Items>…</Items>) is unwrapped. */
export function parseSnippet(xml: string): SnippetObject[] {
  const wrapped = wrapFragment(xml);
  const { root } = parseTree(wrapped, 5);
  let els = root?.children ?? [];
  if (els.length === 1 && getAttr(els[0], "id") === undefined && (els[0].children ?? []).length > 0) {
    const kids = els[0].children!;
    if (kids.every((c) => getAttr(c, "id") !== undefined)) els = kids;
  }
  if (!els.length) throw new Error("No XML elements found.");
  return els.map((el) => {
    const id = getAttr(el, "id");
    if (id === undefined || id === "") throw new Error(`<${el.name}> (line ${el.line}) has no id attribute; every game object needs a unique id.`);
    return { tag: el.name, id, xml: elementSource(wrapped, el) };
  });
}

/** Elements that are objects in a data file: root children with id, or grandchildren under an id-less container. */
export function objectElements(root: XElem): XElem[] {
  const out: XElem[] = [];
  for (const c of root.children ?? []) {
    if (getAttr(c, "id") !== undefined) out.push(c);
    else for (const g of c.children ?? []) if (getAttr(g, "id") !== undefined) out.push(g);
  }
  return out;
}

function sameFamily(tagA: string, tagB: string): boolean {
  return tagA === tagB || refPrefixForTag(tagA) === refPrefixForTag(tagB);
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "mod";
}

interface FileTarget {
  abs: string;
  rel: string;
  xmlId: string;
  /** Path to register in SubModule.xml (relative to ModuleData, no extension) when not registered yet. */
  register?: string;
}

function registeredXmlIdOf(mod: ModuleInfo, abs: string): string | undefined {
  for (const node of mod.xmls) {
    const r = resolveXmlNode(mod, node);
    if (r.steps.some((s) => s.xml && path.resolve(s.xml).toLowerCase() === path.resolve(abs).toLowerCase())) return node.id;
  }
  return undefined;
}

function normalizeDataPath(file: string): string {
  let f = file.replace(/\\/g, "/").replace(/^\/+/, "");
  if (/^moduledata\//i.test(f)) f = f.slice("ModuleData/".length);
  if (!/\.xml$/i.test(f)) f += ".xml";
  if (f.includes("..")) throw new Error("file must stay inside the module's ModuleData folder.");
  return f;
}

function chooseTarget(ctx: Ctx, mod: ModuleInfo, tag: string, file?: string, xmlIdOpt?: string): FileTarget {
  if (file) {
    const f = normalizeDataPath(file);
    const abs = path.join(mod.dir, "ModuleData", ...f.split("/"));
    const registered = registeredXmlIdOf(mod, abs);
    const xmlId = xmlIdOpt ?? registered ?? ctx.index.xmlIdForTag(tag);
    if (!xmlId) throw new Error(`Cannot tell which XmlName id <${tag}> belongs to; pass xml_id (e.g. Items, NPCCharacters).`);
    return { abs, rel: `ModuleData/${f}`, xmlId, register: registered ? undefined : f.replace(/\.xml$/i, "") };
  }
  const xmlId = xmlIdOpt ?? ctx.index.xmlIdForTag(tag);
  if (!xmlId) throw new Error(`Cannot tell which XmlName id <${tag}> belongs to; pass xml_id (see describe_schema for the list).`);
  const rootTag = ctx.index.rootTagForXmlId(xmlId);
  for (const node of mod.xmls) {
    if (node.id !== xmlId) continue;
    const r = resolveXmlNode(mod, node);
    if (r.kind !== "file" || !r.steps[0].xml) continue;
    const abs = r.steps[0].xml;
    try {
      const { text } = readTextFile(abs);
      const { root } = parseTree(text, 2);
      if (rootTag && root && root.name !== rootTag) continue;
    } catch {
      continue;
    }
    return { abs, rel: path.relative(mod.dir, abs).split(path.sep).join("/"), xmlId };
  }
  const name = `${slug(mod.id)}_${slug(xmlId)}`;
  return { abs: path.join(mod.dir, "ModuleData", `${name}.xml`), rel: `ModuleData/${name}.xml`, xmlId, register: name };
}

interface LoadedFile {
  abs: string;
  text: string;
  encoding: TextEncodingKind;
  isNew: boolean;
}

function loadOrCreate(abs: string, rootTag: string): LoadedFile {
  if (fs.existsSync(abs)) {
    const tf = readTextFile(abs);
    return { abs, text: tf.text, encoding: tf.encoding, isNew: false };
  }
  const eol = process.platform === "win32" ? "\r\n" : "\n";
  return { abs, text: `<?xml version="1.0" encoding="utf-8"?>${eol}<${rootTag}>${eol}</${rootTag}>${eol}`, encoding: "utf8", isNew: true };
}

function findObjectEl(root: XElem, tag: string, id: string): XElem | undefined {
  return objectElements(root).find((e) => getAttr(e, "id") === id && sameFamily(e.name, tag));
}

/** Inserts or replaces one object in file text. */
function upsertInText(text: string, obj: SnippetObject): { text: string; action: "inserted" | "replaced" } {
  const { root, errors } = parseTree(text, 5);
  if (!root) throw new Error(`Cannot parse target file: ${errors[0]?.message ?? "no root element"}`);
  const layout = { eol: detectEol(text), unit: detectIndentUnit(text, root) };
  const existing = findObjectEl(root, obj.tag, obj.id);
  if (existing) return { text: applyEdits(text, [replaceElementEdit(text, existing, obj.xml, layout)]), action: "replaced" };
  // Insert next to objects of the same tag if they live in a sub-container.
  const sibling = objectElements(root).find((e) => e.name === obj.tag);
  const container = sibling?.parent ?? root;
  return { text: applyEdits(text, [insertChildEdit(text, container, obj.xml, layout)]), action: "inserted" };
}

function finalize(file: LoadedFile, text: string): Buffer {
  const problems = checkWellFormed(text, 3);
  if (problems.length) throw new Error(`Internal error: result for ${file.abs} would not be well-formed (line ${problems[0].line}: ${problems[0].message}). Nothing was written.`);
  return encodeText(fixXmlDeclarationEncoding(text, file.encoding), file.encoding);
}

export interface WriteReport {
  lines: string[];
  changedFiles: string[];
  xmlIds: Map<string, string>;
}

/**
 * Upserts objects into a writable module. mode: upsert | create (fail if it exists) | replace (fail if missing).
 */
export function writeObjects(
  ctx: Ctx,
  tx: Transaction,
  mod: ModuleInfo,
  objects: SnippetObject[],
  opts: { mode: "upsert" | "create" | "replace"; file?: string; xmlId?: string },
): WriteReport {
  ctx.index.ensure([mod]);
  const report: WriteReport = { lines: [], changedFiles: [], xmlIds: new Map() };
  const seen = new Set<string>();
  const plan = new Map<string, { target: FileTarget; objs: SnippetObject[] }>();
  for (const obj of objects) {
    const key = `${refPrefixForTag(obj.tag)}.${obj.id}`;
    if (seen.has(key)) throw new Error(`The XML contains ${key} twice.`);
    seen.add(key);
    const mine = ctx.index.find(obj.id).filter((o) => o.module === mod.id && sameFamily(o.tag, obj.tag));
    let target: FileTarget;
    if (mine.length) {
      if (opts.mode === "create") throw new Error(`${key} already exists in ${mod.id} (${mine[0].file.rel}:${mine[0].line}). Use mode=upsert to replace it.`);
      const f = mine[0].file;
      target = { abs: f.abs, rel: f.rel, xmlId: f.xmlIds[0] ?? opts.xmlId ?? ctx.index.xmlIdForTag(obj.tag) ?? "" };
      if (opts.file && normalizeDataPath(opts.file).toLowerCase() !== f.rel.replace(/^ModuleData\//i, "").toLowerCase()) {
        report.lines.push(`note: ${key} already lives in ${f.rel}; it was updated there (file argument ignored).`);
      }
    } else {
      if (opts.mode === "replace") throw new Error(`${key} does not exist in ${mod.id}; use mode=upsert or create.`);
      target = chooseTarget(ctx, mod, obj.tag, opts.file, opts.xmlId);
    }
    const k = target.abs.toLowerCase();
    let p = plan.get(k);
    if (!p) plan.set(k, (p = { target, objs: [] }));
    p.objs.push(obj);
  }
  for (const { target, objs } of plan.values()) {
    const rootTag = ctx.index.rootTagForXmlId(target.xmlId) ?? target.xmlId;
    const file = loadOrCreate(target.abs, rootTag);
    let text = file.text;
    for (const obj of objs) {
      const r = upsertInText(text, obj);
      text = r.text;
      report.lines.push(`${r.action} ${obj.tag} '${obj.id}' in ${target.rel}`);
      report.xmlIds.set(target.abs, target.xmlId);
    }
    tx.write(target.abs, finalize(file, text));
    report.changedFiles.push(target.abs);
    if (target.register) {
      if (ensureXmlNodeRegistered(tx, mod, ctx.registry, target.xmlId, target.register)) {
        report.lines.push(`registered <XmlName id="${target.xmlId}" path="${target.register}"/> in SubModule.xml`);
      }
    }
  }
  return report;
}

/** Notes about overrides, unresolved references and missing localization ids for written objects. */
export function analyzeWritten(ctx: Ctx, mod: ModuleInfo, objects: SnippetObject[]): string[] {
  const notes: string[] = [];
  ctx.indexAll();
  const context = ctx.registry.contextFor(mod);
  const contextIds = new Set(context.map((m) => m.id));
  const order = new Map(context.map((m, i) => [m.id, i]));
  const known = ctx.index.knownTags();
  for (const obj of objects) {
    const others = ctx.index.find(obj.id).filter((o) => o.module !== mod.id && sameFamily(o.tag, obj.tag) && contextIds.has(o.module));
    if (others.length) {
      const o = others.sort((a, b) => (order.get(a.module) ?? 0) - (order.get(b.module) ?? 0))[others.length - 1];
      notes.push(
        `${obj.tag} '${obj.id}' overrides the definition in ${o.module} (${o.file.rel}:${o.line}). The game re-reads the whole object from your file, so attributes you omit fall back to defaults, not to ${o.module}'s values. For small changes prefer xslt_patch.`,
      );
    }
    const unresolved: string[] = [];
    for (const ref of collectRefsFromXml(obj.xml)) {
      const prefix = ref.slice(0, ref.indexOf("."));
      if (!isCheckablePrefix(prefix, known)) continue;
      const res = ctx.index.lookup(ref);
      const visible = res.matches.filter((m) => contextIds.has(m.module) || m.module === mod.id);
      if (!visible.length && !objects.some((x) => `${refPrefixForTag(x.tag)}.${x.id}` === ref)) {
        unresolved.push(res.matches.length ? `${ref} (only in ${[...new Set(res.matches.map((m) => m.module))].join(", ")}, not a dependency)` : ref);
      }
    }
    if (unresolved.length) notes.push(`${obj.tag} '${obj.id}': unresolved references: ${unresolved.slice(0, 12).join(", ")}${unresolved.length > 12 ? ", …" : ""}`);
    const plainName = /\bname="(?!\{=)[^"]*[A-Za-zÀ-￿][^"]*"/.exec(obj.xml.split(">")[0]);
    if (plainName) notes.push(`${obj.tag} '${obj.id}': name has no {=id} localization prefix; run l10n_scan with fix_missing_ids=true to add ids.`);
  }
  return notes;
}

/** Runs XSD validation (game's own schemas) for the given data files. */
export async function xsdCheck(ctx: Ctx, files: Map<string, string>, modDir: string): Promise<string[]> {
  const tasks: Array<{ op: "xsd"; xml: string; xsd: string }> = [];
  for (const [abs, xmlId] of files) {
    const xsd = ctx.schemas.pathFor(xmlId);
    if (xsd && fs.existsSync(abs)) tasks.push({ op: "xsd", xml: abs, xsd });
  }
  if (!tasks.length) return [];
  if (!ctx.dotnet.available()) return [`(XSD check skipped: ${ctx.dotnet.unavailableReason()})`];
  const out: string[] = [];
  const res = await ctx.dotnet.run(tasks);
  res.forEach((r, i) => {
    const rel = path.relative(modDir, tasks[i].xml).split(path.sep).join("/");
    if (!r.ok) out.push(`XSD check of ${rel} failed: ${r.error}`);
    for (const e of r.result?.errors ?? []) out.push(`XSD ${e.severity} ${rel}:${e.line}:${e.col} ${e.message}`);
  });
  return out;
}

/** Definitions of `ref` inside one module. */
export function findInModule(ctx: Ctx, mod: ModuleInfo, ref: string): ObjRec[] {
  ctx.index.ensure([mod]);
  const res = ctx.index.lookup(ref);
  return res.matches.filter((o) => o.module === mod.id);
}

export function notInModuleError(ctx: Ctx, mod: ModuleInfo, ref: string): Error {
  const res = ctx.index.lookup(ref);
  if (res.matches.length) {
    const where = [...new Set(res.matches.map((m) => m.module))].join(", ");
    return new Error(
      `${ref} is not defined in ${mod.id} (it is defined in ${where}). To change it from ${mod.id} use xslt_patch (partial, keeps other mods compatible) or clone_object with the same id (full override).`,
    );
  }
  return new Error(`${ref} was not found in ${mod.id} or any other module. Use search_objects to find the right id.`);
}

/** Locates the element of an indexed object in fresh file text. */
export function locate(text: string, rec: ObjRec): XElem {
  const { root } = parseTree(text, 5);
  if (!root) throw new Error(`Cannot parse ${rec.file.abs}`);
  const els = objectElements(root);
  const byPos = els.find((e) => e.start === rec.start && e.name === rec.tag);
  const el = byPos ?? els.find((e) => e.name === rec.tag && getAttr(e, "id") === rec.id);
  if (!el) throw new Error(`${rec.tag} '${rec.id}' not found in ${rec.file.rel} (file changed?). Try again.`);
  return el;
}

export function setAttributes(
  ctx: Ctx,
  tx: Transaction,
  mod: ModuleInfo,
  ref: string,
  subpath: string,
  set: Array<[string, string]>,
  unset: string[],
  all: boolean,
): { lines: string[]; file: string; xmlId: string | undefined; xml: string } {
  const recs = findInModule(ctx, mod, ref);
  if (!recs.length) throw notInModuleError(ctx, mod, ref);
  if (recs.length > 1) throw new Error(`${ref} is defined ${recs.length} times in ${mod.id}: ${recs.map((r) => `${r.file.rel}:${r.line}`).join(", ")}. Remove the duplicates first.`);
  const rec = recs[0];
  const tf = readTextFile(rec.file.abs);
  const el = locate(tf.text, rec);
  let targets = [el];
  if (subpath) {
    targets = selectMiniPath(el, parseMiniPath(subpath));
    if (!targets.length) {
      const kids = [...new Set((el.children ?? []).map((c) => c.name))];
      throw new Error(`Path '${subpath}' matches nothing inside ${rec.tag} '${rec.id}'. Direct children: ${kids.join(", ") || "(none)"}`);
    }
    if (targets.length > 1 && !all) throw new Error(`Path '${subpath}' matches ${targets.length} elements; add a predicate like [@id='...'] or [2], or pass all=true.`);
  }
  const changes: Array<[string, string | null]> = [...set.map(([k, v]) => [k, v] as [string, string | null]), ...unset.map((k) => [k, null] as [string, string | null])];
  const edits: Edit[] = [];
  for (const t of targets) edits.push(...setAttributesEdits(tf.text, t, changes));
  const lines: string[] = [];
  if (!edits.length) {
    lines.push("No changes (values already set).");
    return { lines, file: rec.file.abs, xmlId: rec.file.xmlIds[0], xml: elementSource(tf.text, el) };
  }
  const out = applyEdits(tf.text, edits);
  tx.write(rec.file.abs, finalize({ abs: rec.file.abs, text: tf.text, encoding: tf.encoding, isNew: false }, out));
  const newEl = locate(out, { ...rec, start: el.start });
  lines.push(`updated ${targets.length} element(s) of ${rec.tag} '${rec.id}' in ${rec.file.rel}: ${changes.map(([k, v]) => (v === null ? `-${k}` : `${k}="${v}"`)).join(", ")}`);
  return { lines, file: rec.file.abs, xmlId: rec.file.xmlIds[0], xml: elementSource(out, newEl) };
}

export function deleteObject(ctx: Ctx, tx: Transaction, mod: ModuleInfo, ref: string): string[] {
  const recs = findInModule(ctx, mod, ref);
  if (!recs.length) throw notInModuleError(ctx, mod, ref);
  const lines: string[] = [];
  // Delete from the end of each file so offsets stay valid.
  const byFile = new Map<string, ObjRec[]>();
  for (const r of recs) {
    const list = byFile.get(r.file.abs) ?? [];
    list.push(r);
    byFile.set(r.file.abs, list);
  }
  for (const [abs, list] of byFile) {
    const tf = readTextFile(abs);
    const edits = list.map((r) => removeElementEdit(tf.text, locate(tf.text, r)));
    const out = applyEdits(tf.text, edits);
    tx.write(abs, finalize({ abs, text: tf.text, encoding: tf.encoding, isNew: false }, out));
    for (const r of list) lines.push(`deleted ${r.tag} '${r.id}' from ${r.file.rel} (was line ${r.line})`);
  }
  return lines;
}

/** Picks the definition the game ends up using (last in load order). */
export function effectiveDefinition(ctx: Ctx, matches: ObjRec[], restrictTo?: Set<string>): ObjRec | undefined {
  const mods = [...new Set(matches.map((m) => m.module))].map((id) => ctx.registry.get(id)).filter((m): m is ModuleInfo => !!m);
  const order = ctx.registry.loadOrder(mods);
  const rank = new Map(order.map((m, i) => [m.id, i]));
  const pool = restrictTo ? matches.filter((m) => restrictTo.has(m.module)) : matches;
  return [...pool].sort((a, b) => (rank.get(a.module) ?? 0) - (rank.get(b.module) ?? 0)).pop();
}

export function prepareClone(
  ctx: Ctx,
  source: ObjRec,
  newId: string | undefined,
  set: Array<[string, string]>,
): { xml: string; notes: string[] } {
  const tf = readTextFile(source.file.abs);
  const el = locate(tf.text, source);
  let xml = elementSource(tf.text, el);
  const { root } = parseTree(xml, 5);
  if (!root) throw new Error("Cannot parse source object.");
  const notes: string[] = [];
  const changes: Array<[string, string | null]> = [];
  if (newId) changes.push(["id", newId]);
  const taken = new Set(ctx.index.stringIds().keys());
  for (const [k, v] of set) {
    if (k === "id") continue;
    if ((k === "name" || k === "text" || k === "short_name") && v && !v.startsWith("{=")) {
      const sid = generateStringId(taken);
      changes.push([k, `{=${sid}}${v}`]);
      notes.push(`${k}: assigned localization id {=${sid}}`);
    } else changes.push([k, v]);
  }
  xml = applyEdits(xml, setAttributesEdits(xml, root, changes));
  return { xml, notes };
}
