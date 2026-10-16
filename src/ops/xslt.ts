import { applyEdits, insertChildEdit, reindent, setAttributesEdits } from "../xml/edit.js";
import { escapeAttr, escapeText, getAttr, parseTree, scanXml, xpathLiteral, type XElem } from "../xml/scanner.js";

/** Operations of one generated XSLT template (one target node). */
export interface PatchOps {
  remove: boolean;
  /** Replacement XML for the whole node. */
  replace: string | null;
  set: Array<[string, string]>;
  unset: string[];
  append: string[];
}

export function emptyOps(): PatchOps {
  return { remove: false, replace: null, set: [], unset: [], append: [] };
}

export const XSLT_SKELETON = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">',
  '\t<xsl:output omit-xml-declaration="no" indent="yes" />',
  '\t<xsl:template match="@*|node()">',
  "\t\t<xsl:copy>",
  '\t\t\t<xsl:apply-templates select="@*|node()" />',
  "\t\t</xsl:copy>",
  "\t</xsl:template>",
  "</xsl:stylesheet>",
  "",
].join("\n");

/**
 * Literal result elements in XSLT treat attribute values as attribute value templates, so the
 * Bannerlord text syntax {=id}Text must be written as {{=id}}Text inside a stylesheet.
 */
export function escapeAvt(xml: string): string {
  return transformAttrValues(xml, (raw) => raw.replace(/\{/g, "{{").replace(/\}/g, "}}"));
}

export function unescapeAvt(xml: string): string {
  return transformAttrValues(xml, (raw) => raw.replace(/\{\{/g, "{").replace(/\}\}/g, "}"));
}

function transformAttrValues(xml: string, fn: (raw: string) => string): string {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  // onOpen visits every element, including several top-level elements of a snippet.
  scanXml(xml, {
    maxErrors: 5,
    onOpen: (el) => {
      for (const a of el.attrs) {
        const raw = xml.slice(a.valueStart, a.valueEnd);
        const t = fn(raw);
        if (t !== raw) edits.push({ start: a.valueStart, end: a.valueEnd, text: t });
      }
    },
  });
  return applyEdits(xml, edits);
}

export function buildMatch(tag: string, id: string, depth: number, parentTag: string | undefined, subpath: string): string {
  const base = depth === 2 && parentTag ? `/*/${parentTag}/${tag}[@id=${xpathLiteral(id)}]` : `/*/${tag}[@id=${xpathLiteral(id)}]`;
  return subpath ? `${base}/${subpath}` : base;
}

export function renderTemplate(match: string, ops: PatchOps, unit: string, eol: string): string {
  const m = escapeAttr(match);
  if (ops.remove) return `<xsl:template match="${m}" />`;
  if (ops.replace !== null) {
    return [`<xsl:template match="${m}">`, reindent(escapeAvt(ops.replace), unit, unit, eol), "</xsl:template>"].join(eol);
  }
  const excluded = [...new Set([...ops.unset, ...ops.set.map(([k]) => k)])];
  const sel = excluded.length ? `@*[not(${excluded.map((n) => `name()=${xpathLiteral(n)}`).join(" or ")})]` : "@*";
  const lines = [`<xsl:template match="${m}">`, `${unit}<xsl:copy>`, `${unit}${unit}<xsl:apply-templates select="${escapeAttr(sel)}" />`];
  for (const [k, v] of ops.set) lines.push(`${unit}${unit}<xsl:attribute name="${escapeAttr(k)}">${escapeText(v)}</xsl:attribute>`);
  lines.push(`${unit}${unit}<xsl:apply-templates select="node()" />`);
  for (const a of ops.append) lines.push(reindent(escapeAvt(a), unit + unit, unit, eol));
  lines.push(`${unit}</xsl:copy>`, "</xsl:template>");
  return lines.join(eol);
}

/**
 * Reads back a template produced by renderTemplate. Returns null for hand-written templates whose
 * structure we do not understand (we never silently rewrite those).
 */
export function parseTemplate(text: string, tpl: XElem): PatchOps | null {
  const ops = emptyOps();
  const kids = tpl.children ?? [];
  const inner = text.slice(tpl.openEnd, tpl.closeStart < 0 ? tpl.openEnd : tpl.closeStart);
  if (kids.length === 0) {
    if (inner.trim() === "" || tpl.selfClosing) {
      ops.remove = true;
      return ops;
    }
    return null;
  }
  if (kids.length === 1 && !kids[0].name.startsWith("xsl:")) {
    ops.replace = unescapeAvt(text.slice(kids[0].start, kids[0].end));
    return ops;
  }
  if (kids.length !== 1 || kids[0].name !== "xsl:copy") return null;
  let excluded: string[] = [];
  let afterNodes = false;
  for (const c of kids[0].children ?? []) {
    if (c.name === "xsl:apply-templates") {
      const sel = getAttr(c, "select") ?? "";
      if (sel === "node()") {
        afterNodes = true;
        continue;
      }
      if (sel === "@*") continue;
      if (sel.startsWith("@*[not(")) {
        excluded = [...sel.matchAll(/name\(\)\s*=\s*(['"])(.*?)\1/g)].map((m) => m[2]);
        continue;
      }
      return null;
    }
    if (c.name === "xsl:attribute") {
      const name = getAttr(c, "name");
      if (!name || (c.children ?? []).length) return null;
      const raw = c.selfClosing ? "" : text.slice(c.openEnd, c.closeStart);
      ops.set.push([name, raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")]);
      continue;
    }
    if (!c.name.startsWith("xsl:") && afterNodes) {
      ops.append.push(unescapeAvt(text.slice(c.start, c.end)));
      continue;
    }
    return null;
  }
  const setNames = new Set(ops.set.map(([k]) => k));
  ops.unset = excluded.filter((n) => !setNames.has(n));
  return ops;
}

export interface PatchRequest {
  remove?: boolean;
  replace?: string | null;
  set?: Array<[string, string]>;
  unset?: string[];
  append?: string[];
}

/** Combines an existing template's operations with a new request. Returns notes about decisions. */
export function mergeOps(base: PatchOps | null, req: PatchRequest, unit: string, eol: string): { ops: PatchOps; notes: string[] } {
  const notes: string[] = [];
  if (req.remove) return { ops: { ...emptyOps(), remove: true }, notes };
  if (req.replace) return { ops: { ...emptyOps(), replace: req.replace }, notes };
  let ops: PatchOps = base ? { remove: base.remove, replace: base.replace, set: [...base.set], unset: [...base.unset], append: [...base.append] } : emptyOps();
  if (ops.remove) {
    notes.push("The node was previously removed by this patch; the removal is dropped in favor of the new modification.");
    ops = emptyOps();
  }
  if (ops.replace !== null) {
    // Apply the modification directly to the replacement XML.
    let xml = ops.replace;
    const { root } = parseTree(xml, 5);
    if (root) {
      const changes: Array<[string, string | null]> = [];
      for (const [k, v] of req.set ?? []) changes.push([k, v]);
      for (const k of req.unset ?? []) changes.push([k, null]);
      xml = applyEdits(xml, setAttributesEdits(xml, root, changes));
      if (req.append?.length) {
        for (const a of req.append) {
          const t = parseTree(xml, 5).root!;
          xml = applyEdits(xml, [insertChildEdit(xml, t, a, { eol, unit })]);
        }
      }
    }
    ops.replace = xml;
    return { ops, notes };
  }
  for (const [k, v] of req.set ?? []) {
    ops.unset = ops.unset.filter((x) => x !== k);
    const i = ops.set.findIndex(([n]) => n === k);
    if (i >= 0) ops.set[i] = [k, v];
    else ops.set.push([k, v]);
  }
  for (const k of req.unset ?? []) {
    ops.set = ops.set.filter(([n]) => n !== k);
    if (!ops.unset.includes(k)) ops.unset.push(k);
  }
  for (const a of req.append ?? []) ops.append.push(a);
  return { ops, notes };
}

export function isEmptyOps(ops: PatchOps): boolean {
  return !ops.remove && ops.replace === null && ops.set.length === 0 && ops.unset.length === 0 && ops.append.length === 0;
}
