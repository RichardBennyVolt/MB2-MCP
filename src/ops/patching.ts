import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "../context.js";
import { resolveXmlNode, type ModuleInfo } from "../model/modules.js";
import { refPrefixForTag, type ObjRec } from "../model/objects.js";
import { unifiedDiff } from "../util/diff.js";
import { detectEol, encodeText, fixXmlDeclarationEncoding, readTextFile } from "../util/text.js";
import { applyEdits, detectIndentUnit, elementSource, insertChildEdit, removeElementEdit, replaceElementEdit, setAttributesEdits, type Edit } from "../xml/edit.js";
import { getAttr, miniPathToXPath, parseMiniPath, parseTree, scanXml, selectMiniPath } from "../xml/scanner.js";
import { checkWellFormed } from "../xml/wellformed.js";
import type { Transaction } from "./history.js";
import { effectiveDefinition, locate, slug } from "./objects-edit.js";
import { ensureXmlNodeRegistered } from "./submodule.js";
import { buildMatch, isEmptyOps, mergeOps, parseTemplate, renderTemplate, XSLT_SKELETON, type PatchRequest } from "./xslt.js";

const XSLT_NS = "http://www.w3.org/1999/XSL/Transform";

export interface PatchTarget {
  tag: string;
  id: string;
  depth: number;
  parentTag?: string;
}

export interface XsltPatchResult {
  lines: string[];
  xmlId: string;
  target: PatchTarget;
  xsltAbs: string;
  definition: ObjRec;
}

/** The definition a patch from `mod` would modify: last definition among modules loaded before it. */
export function patchableDefinition(ctx: Ctx, mod: ModuleInfo, ref: string): ObjRec {
  ctx.indexAll();
  const res = ctx.index.lookup(ref);
  const others = res.matches.filter((o) => o.module !== mod.id);
  if (!others.length) {
    if (res.matches.length) throw new Error(`${ref} only exists in ${mod.id} itself; edit it directly with set_attributes / write_object instead of patching.`);
    throw new Error(`${ref} not found in any module. Use search_objects to find the exact id (references look like Item.xxx, NPCCharacter.xxx, Culture.xxx).`);
  }
  const context = new Set(ctx.registry.contextFor(mod).map((m) => m.id).filter((id) => id !== mod.id));
  const def = effectiveDefinition(ctx, others, context);
  if (!def) {
    const where = [...new Set(others.map((o) => o.module))].join(", ");
    throw new Error(`${ref} is defined in ${where}, which ${mod.id} does not depend on. Add the dependency first (edit_submodule add_dependencies), otherwise the patch never sees that object.`);
  }
  if (!def.file.registered || !def.file.xmlIds.length) throw new Error(`${ref} lives in ${def.module}/${def.file.rel}, which is not registered in that module's SubModule.xml, so it cannot be patched.`);
  return def;
}

function findModuleXslt(mod: ModuleInfo, xmlId: string): string | null {
  for (const node of mod.xmls) {
    if (node.id !== xmlId) continue;
    for (const s of resolveXmlNode(mod, node).steps) if (s.xslt) return s.xslt;
  }
  return null;
}

export function xsltPatch(
  ctx: Ctx,
  tx: Transaction,
  mod: ModuleInfo,
  ref: string,
  opts: { path: string; req: PatchRequest; clear: boolean; force: boolean },
): XsltPatchResult {
  const def = patchableDefinition(ctx, mod, ref);
  const xmlId = def.file.xmlIds[0];
  let subpath = "";
  if (opts.path.trim()) {
    const steps = parseMiniPath(opts.path);
    subpath = miniPathToXPath(steps);
    if (!opts.clear) {
      const text = readTextFile(def.file.abs).text;
      const el = locate(text, def);
      const hits = selectMiniPath(el, steps);
      if (!hits.length && !opts.req.remove) {
        const kids = [...new Set((el.children ?? []).map((c) => c.name))];
        throw new Error(`Path '${opts.path}' matches nothing in ${def.tag} '${def.id}' (${def.module}). Direct children: ${kids.join(", ") || "(none)"}.`);
      }
    }
  }
  const lines: string[] = [];
  let xsltAbs = findModuleXslt(mod, xmlId);
  let registerPath: string | null = null;
  if (!xsltAbs) {
    const name = `${slug(mod.id)}_${xmlId}`;
    xsltAbs = path.join(mod.dir, "ModuleData", "XSLT", `${name}.xslt`);
    registerPath = `XSLT/${name}`;
  }
  const exists = fs.existsSync(xsltAbs);
  const tf = exists ? readTextFile(xsltAbs) : { text: XSLT_SKELETON.replace(/\n/g, "\r\n"), encoding: "utf8" as const, eol: "\r\n" as const };
  let text = tf.text;
  let { root } = parseTree(text, 5);
  if (!root || !/(^|:)(stylesheet|transform)$/.test(root.name)) throw new Error(`${xsltAbs} is not an XSLT stylesheet.`);
  const eol = detectEol(text);
  // Our templates use the xsl: prefix; make sure it is declared.
  if (getAttr(root, "xmlns:xsl") !== XSLT_NS) {
    text = applyEdits(text, setAttributesEdits(text, root, [["xmlns:xsl", XSLT_NS]]));
    root = parseTree(text, 5).root!;
    lines.push("added xmlns:xsl declaration to the stylesheet");
  }
  const defaultNsIsXslt = getAttr(root, "xmlns") === XSLT_NS;
  const unit = detectIndentUnit(text, root);
  const match = buildMatch(def.tag, def.id, def.depth, def.parentTag, subpath);
  const existing = (root.children ?? []).find((c) => /(^|:)template$/.test(c.name) && getAttr(c, "match") === match);
  let edit: Edit;
  if (opts.clear) {
    if (!existing) throw new Error(`No rule with match="${match}" in ${path.relative(mod.dir, xsltAbs)}.`);
    edit = removeElementEdit(text, existing);
    lines.push(`removed rule ${match}`);
  } else {
    let base = null;
    if (existing) {
      base = parseTemplate(text, existing);
      if (!base && !opts.force) {
        throw new Error(`A hand-written template with match="${match}" already exists (line ${existing.line}). Edit it manually, or pass force=true to replace it.`);
      }
    }
    const req = { ...opts.req };
    if (defaultNsIsXslt) {
      const noNs = (x: string): string => {
        const r = parseTree(x, 3).root;
        return r ? applyEdits(x, setAttributesEdits(x, r, [["xmlns", ""]])) : x;
      };
      if (req.replace) req.replace = noNs(req.replace);
      if (req.append) req.append = req.append.map(noNs);
    }
    const { ops, notes } = mergeOps(base, req, unit, eol);
    lines.push(...notes);
    if (isEmptyOps(ops)) throw new Error("Nothing to patch: pass set, remove_attributes, remove, replace_xml or append_xml.");
    const tpl = renderTemplate(match, ops, unit, eol);
    edit = existing ? replaceElementEdit(text, existing, tpl, { eol, unit }) : insertChildEdit(text, root, tpl, { eol, unit });
    lines.push(`${existing ? "updated" : "added"} rule ${match}`);
  }
  const out = applyEdits(text, [edit]);
  const problems = checkWellFormed(out, 3);
  if (problems.length) throw new Error(`Internal error: XSLT would not be well-formed (line ${problems[0].line}: ${problems[0].message}); nothing written.`);
  tx.write(xsltAbs, encodeText(fixXmlDeclarationEncoding(out, tf.encoding), tf.encoding));
  lines.unshift(`${exists ? "updated" : "created"} ${path.relative(mod.dir, xsltAbs).split(path.sep).join("/")} (patches ${xmlId}: ${def.tag} '${def.id}' from ${def.module})`);
  if (registerPath && ensureXmlNodeRegistered(tx, mod, ctx.registry, xmlId, registerPath)) {
    lines.push(`registered <XmlName id="${xmlId}" path="${registerPath}"/> (XSLT-only node) in SubModule.xml`);
  }
  return { lines, xmlId, target: { tag: def.tag, id: def.id, depth: def.depth, parentTag: def.parentTag }, xsltAbs, definition: def };
}

/**
 * Normalizes pretty-printed XML for diffing: start tags with many attributes are split into one
 * attribute per line (id first, then alphabetical) and <x></x> becomes <x />, so a diff shows only
 * the attributes that really changed (XSLT moves added attributes to the end of the tag).
 */
export function normalizeForDiff(xml: string): string {
  const out: string[] = [];
  for (const line of xml.replace(/<([\w.:-]+)((?:\s+[\w.:-]+="[^"]*")*)\s*><\/\1>/g, "<$1$2 />").split("\n")) {
    const m = /^(\s*)<([\w.:-]+)((?:\s+[\w.:-]+="[^"]*")+)\s*(\/?)>\s*$/.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const attrs = [...m[3].matchAll(/([\w.:-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]] as [string, string]);
    if (attrs.length <= 3) {
      out.push(line);
      continue;
    }
    attrs.sort((a, b) => (a[0] === "id" ? -1 : b[0] === "id" ? 1 : a[0].localeCompare(b[0])));
    out.push(`${m[1]}<${m[2]}`);
    for (const [k, v] of attrs) out.push(`${m[1]}    ${k}="${v}"`);
    out.push(`${m[1]}${m[4] ? "/>" : ">"}`);
  }
  return out.join("\n");
}

/** Pulls objects (tag+id at depth 1 or 2) out of a merged document; `ranges` receives their line spans. */
function extractObjects(text: string, wanted: PatchTarget[], ranges?: Map<string, Array<[number, number]>>): Map<string, string[]> {
  const keys = new Set(wanted.map((w) => `${w.tag}|${w.id}`));
  const ids = new Set(wanted.map((w) => w.id));
  const out = new Map<string, string[]>();
  const open = new Map<number, string>();
  const startLines = new Map<number, number>();
  scanXml(text, {
    maxErrors: 3,
    onOpen: (el) => {
      if (el.depth < 1 || el.depth > 2) return;
      const id = getAttr(el, "id");
      if (id === undefined || !ids.has(id)) return;
      if (keys.has(`${el.name}|${id}`)) open.set(el.start, `${el.name}|${id}`);
      else {
        // Same id but a different tag of the same family (e.g. replaced Item ↔ CraftedItem).
        const fam = wanted.find((w) => w.id === id && refPrefixForTag(w.tag) === refPrefixForTag(el.name));
        if (fam) open.set(el.start, `${fam.tag}|${id}`);
      }
      if (open.has(el.start)) startLines.set(el.start, el.line);
    },
    onClose: (el) => {
      const k = open.get(el.start);
      if (!k) return;
      open.delete(el.start);
      const list = out.get(k) ?? [];
      list.push(elementSource(text, el));
      out.set(k, list);
      if (ranges) {
        const first = startLines.get(el.start) ?? 0;
        const span = text.slice(el.start, el.end).split("\n").length - 1;
        const r = ranges.get(k) ?? [];
        r.push([first, first + span]);
        ranges.set(k, r);
      }
    },
  });
  return out;
}

export interface PreviewResult {
  text: string;
  ok: boolean;
}

/**
 * Re-creates what the game does for one XmlName id: merges every module's files in load order and
 * applies .xslt patches (System.Xml, like the game), then diffs the targets before/after `mod`.
 */
export async function previewXslt(ctx: Ctx, mod: ModuleInfo, xmlId: string, targets: PatchTarget[], gameType = "Campaign"): Promise<PreviewResult> {
  if (!ctx.dotnet.available()) return { ok: false, text: `Preview unavailable: ${ctx.dotnet.unavailableReason()}` };
  const context = ctx.registry.contextFor(mod);
  const steps: Array<{ xml: string | null; xslt: string | null; snapshotBefore?: string; snapshotAfter?: string }> = [];
  let first = -1;
  let last = -1;
  for (const m of context) {
    for (const node of m.xmls) {
      if (node.id !== xmlId) continue;
      if (node.gameTypes.length && !node.gameTypes.includes(gameType)) continue;
      for (const s of resolveXmlNode(m, node).steps) {
        if (m.id === mod.id) {
          if (first < 0) first = steps.length;
          last = steps.length;
        }
        steps.push({ xml: s.xml, xslt: s.xslt });
      }
    }
  }
  if (first < 0) return { ok: false, text: `${mod.id} registers nothing for ${xmlId} in game type ${gameType}.` };
  if (first === 0) return { ok: false, text: `${mod.id} is the first module providing ${xmlId}; its XSLT would not be applied (the game skips XSLT of the first file).` };
  const before = ctx.dotnet.tempPath("before.xml");
  const after = ctx.dotnet.tempPath("after.xml");
  steps[first].snapshotBefore = before;
  steps[last].snapshotAfter = after;
  const t0 = Date.now();
  const xsd = ctx.schemas.pathFor(xmlId);
  try {
    const tasks: Parameters<typeof ctx.dotnet.run>[0] = [{ op: "chain", steps }];
    if (xsd) tasks.push({ op: "xsd", xml: after, xsd });
    const [res, xsdRes] = await ctx.dotnet.run(tasks);
    if (!res.ok) return { ok: false, text: `Merging ${xmlId} failed — the game would hit the same error:\n${res.error}${res.line ? ` (line ${res.line}, col ${res.col})` : ""}` };
    const beforeText = fs.existsSync(before) ? fs.readFileSync(before, "utf8").replace(/^﻿/, "") : "";
    const afterText = fs.existsSync(after) ? fs.readFileSync(after, "utf8").replace(/^﻿/, "") : "";
    const b = extractObjects(beforeText, targets);
    const afterRanges = new Map<string, Array<[number, number]>>();
    const a = extractObjects(afterText, targets, afterRanges);
    const xsdErrors = xsdRes?.ok ? (xsdRes.result?.errors ?? []) : [];
    const out: string[] = [`Preview of ${xmlId} (${gameType}) in load order ${context.map((m) => m.id).join(" > ")} — ${steps.length} file(s), ${Date.now() - t0} ms`];
    for (const t of targets) {
      const k = `${t.tag}|${t.id}`;
      const bl = b.get(k) ?? [];
      const al = a.get(k) ?? [];
      out.push("", `### ${t.tag} '${t.id}'`);
      if (!bl.length && !al.length) {
        out.push("(not present before or after this module)");
        continue;
      }
      if (bl.length && !al.length) {
        out.push("REMOVED by this module.");
        continue;
      }
      if (al.length > 1) out.push(`note: ${al.length} definitions after this module (the last one wins in the game).`);
      const diff = unifiedDiff(normalizeForDiff(bl.join("\n")), normalizeForDiff(al.join("\n")), 2, [`before ${mod.id}`, `after ${mod.id}`]);
      out.push(diff.length > 12000 ? `${diff.slice(0, 12000)}\n… (diff truncated)` : diff);
      const spans = afterRanges.get(k) ?? [];
      const mine = xsdErrors.filter((e) => spans.some(([s, eLine]) => e.line >= s && e.line <= eLine));
      if (mine.length) {
        out.push(`XSD problems in the patched result (${mine.length}) — the game may reject or misread it:`);
        for (const e of mine.slice(0, 10)) out.push(`  ${e.message}`);
      } else if (xsd && xsdRes?.ok) out.push("XSD check of the patched object: OK");
    }
    return { ok: true, text: out.join("\n") };
  } finally {
    for (const f of [before, after]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

/** Targets patched by a module's XSLT files (from [@id='...'] in match patterns). */
export function patchedTargets(ctx: Ctx, mod: ModuleInfo, xmlId?: string): Map<string, PatchTarget[]> {
  ctx.indexAll();
  const out = new Map<string, PatchTarget[]>();
  for (const f of ctx.index.moduleFiles(mod.id)) {
    if (f.kind !== "xslt" || !f.xsltRules) continue;
    for (const x of f.xmlIds) {
      if (xmlId && x !== xmlId) continue;
      const list = out.get(x) ?? [];
      for (const r of f.xsltRules) {
        // The first [@id='…'] predicate addresses the object; later ones are nested elements.
        const id = r.ids[0];
        const tag = r.tags[0];
        if (!id || !tag) continue;
        if (!list.some((t) => t.id === id && t.tag === tag)) {
          const defs = ctx.index.find(id).filter((o) => o.tag === tag);
          list.push({ tag, id, depth: defs[0]?.depth ?? 1, parentTag: defs[0]?.parentTag });
        }
      }
      out.set(x, list);
    }
  }
  return out;
}
