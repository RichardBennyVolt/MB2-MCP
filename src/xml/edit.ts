import { escapeAttr, type XElem } from "./scanner.js";

/** A text replacement on the original string (offsets refer to the unmodified text). */
export interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Applies non-overlapping edits. Insertions at the same offset keep their given order. */
export function applyEdits(text: string, edits: Edit[]): string {
  if (edits.length === 0) return text;
  const sorted = edits.map((e, i) => ({ e, i })).sort((a, b) => a.e.start - b.e.start || a.e.end - b.e.end || a.i - b.i);
  const parts: string[] = [];
  let pos = 0;
  for (const { e } of sorted) {
    if (e.start < pos) throw new Error(`Internal error: overlapping edits at offset ${e.start}`);
    parts.push(text.slice(pos, e.start), e.text);
    pos = e.end;
  }
  parts.push(text.slice(pos));
  return parts.join("");
}

export function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

/** Offset of the '\n' that ends the line containing `offset` (or text.length). */
export function lineEnd(text: string, offset: number): number {
  const k = text.indexOf("\n", offset);
  return k === -1 ? text.length : k;
}

/** Whitespace between the start of the line and `offset`, or null if something else precedes it. */
export function indentBefore(text: string, offset: number): string | null {
  const ls = lineStart(text, offset);
  const pre = text.slice(ls, offset);
  return /^[ \t]*$/.test(pre) ? pre : null;
}

/** Guesses the indentation unit of a document from the first indented child of the root. */
export function detectIndentUnit(text: string, root?: XElem | null): string {
  if (root?.children) {
    const rootIndent = indentBefore(text, root.start) ?? "";
    for (const c of root.children) {
      const ind = indentBefore(text, c.start);
      if (ind !== null && ind.length > rootIndent.length && ind.startsWith(rootIndent)) return ind.slice(rootIndent.length);
    }
  }
  const m = /\n([ \t]+)</.exec(text);
  if (m) {
    if (m[1].startsWith("\t")) return "\t";
    return m[1].length >= 4 ? "    " : m[1].length === 3 ? "   " : "  ";
  }
  return "\t";
}

function measureLevels(ws: string, unitSize: number): number {
  let cols = 0;
  for (const ch of ws) cols += ch === "\t" ? unitSize : 1;
  return Math.floor(cols / unitSize);
}

/**
 * Re-indents an XML snippet: strips its common indentation, converts its own indent unit to
 * `unit`, prefixes every line with `baseIndent` and joins lines with `eol`.
 */
export function reindent(snippet: string, baseIndent: string, unit: string, eol: string): string {
  const lines = snippet.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) return "";
  lines[0] = lines[0].replace(/^[ \t]+/, "");
  // Detect the snippet's own unit from lines 2..n.
  let snippetUnit = 0;
  let usesTabs = false;
  const leading = lines.map((l) => /^[ \t]*/.exec(l)![0]);
  for (let k = 1; k < lines.length; k++) {
    if (!lines[k].trim()) continue;
    if (leading[k].includes("\t")) usesTabs = true;
    const spaces = leading[k].replace(/\t/g, "").length;
    if (spaces > 0 && (snippetUnit === 0 || spaces < snippetUnit)) snippetUnit = spaces;
  }
  const unitSize = usesTabs && snippetUnit === 0 ? 4 : snippetUnit > 0 ? Math.min(snippetUnit, 8) : 4;
  const levels = leading.map((ws, k) => (k === 0 ? 0 : measureLevels(ws, usesTabs && snippetUnit === 0 ? 4 : unitSize)));
  let minLevel = Infinity;
  for (let k = 1; k < lines.length; k++) if (lines[k].trim()) minLevel = Math.min(minLevel, levels[k]);
  // If the first line is an opening tag and all following lines are indented, the minimum belongs to
  // the closing tag (level of the first line).
  if (!Number.isFinite(minLevel)) minLevel = 0;
  const out = lines.map((l, k) => {
    if (k === 0) return baseIndent + l;
    if (!l.trim()) return "";
    const rel = Math.max(0, levels[k] - minLevel);
    return baseIndent + unit.repeat(rel) + l.replace(/^[ \t]+/, "");
  });
  return out.join(eol);
}

/** Removes the indentation of the element's first line from all of its lines (for display). */
export function elementSource(text: string, el: XElem): string {
  const src = text.slice(el.start, el.end);
  const indent = indentBefore(text, el.start);
  if (!indent) return src.replace(/\r\n/g, "\n");
  return src
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l, k) => (k > 0 && l.startsWith(indent) ? l.slice(indent.length) : l))
    .join("\n");
}

export interface LayoutOptions {
  eol: string;
  unit: string;
}

/** Inserts `childXml` as the last child of `container`. Handles self-closing and inline containers. */
export function insertChildEdit(text: string, container: XElem, childXml: string, opts: LayoutOptions): Edit {
  const contIndent = indentBefore(text, container.start) ?? "";
  let childIndent = contIndent + opts.unit;
  const kids = container.children;
  if (kids && kids.length) {
    const ind = indentBefore(text, kids[kids.length - 1].start);
    if (ind !== null && ind.length > contIndent.length) childIndent = ind;
  }
  const block = reindent(childXml, childIndent, opts.unit, opts.eol);
  if (container.selfClosing) {
    const tagText = text.slice(container.start, container.openEnd);
    const m = /\s*\/>$/.exec(tagText);
    const cut = container.openEnd - (m ? m[0].length : 2);
    return { start: cut, end: container.openEnd, text: `>${opts.eol}${block}${opts.eol}${contIndent}</${container.name}>` };
  }
  const cs = container.closeStart;
  const ls = lineStart(text, cs);
  if (ls > container.openEnd && /^[ \t]*$/.test(text.slice(ls, cs))) {
    return { start: ls, end: ls, text: block + opts.eol };
  }
  return { start: cs, end: cs, text: `${opts.eol}${block}${opts.eol}${contIndent}` };
}

/** Inserts `xml` right before `sibling` (on its own line, same indentation). */
export function insertBeforeEdit(text: string, sibling: XElem, xml: string, opts: LayoutOptions): Edit {
  const indent = indentBefore(text, sibling.start);
  if (indent !== null) {
    const ls = lineStart(text, sibling.start);
    return { start: ls, end: ls, text: reindent(xml, indent, opts.unit, opts.eol) + opts.eol };
  }
  return { start: sibling.start, end: sibling.start, text: reindent(xml, "", opts.unit, opts.eol) };
}

/** Inserts `xml` right after `sibling` (on its own line, same indentation). */
export function insertAfterEdit(text: string, sibling: XElem, xml: string, opts: LayoutOptions): Edit {
  const indent = indentBefore(text, sibling.start) ?? "";
  const block = reindent(xml, indent, opts.unit, opts.eol);
  return { start: sibling.end, end: sibling.end, text: opts.eol + block };
}

/** Removes an element; whole lines are removed when the element sits on its own lines. */
export function removeElementEdit(text: string, el: XElem): Edit {
  const ls = lineStart(text, el.start);
  const before = text.slice(ls, el.start);
  const le = lineEnd(text, el.end);
  const after = text.slice(el.end, le).replace(/\r$/, "");
  if (/^[ \t]*$/.test(before) && /^[ \t]*$/.test(after)) {
    return { start: ls, end: Math.min(text.length, le + 1), text: "" };
  }
  return { start: el.start, end: el.end, text: "" };
}

/** Replaces an element with new XML, keeping its indentation. */
export function replaceElementEdit(text: string, el: XElem, xml: string, opts: LayoutOptions): Edit {
  const indent = indentBefore(text, el.start);
  if (indent !== null) {
    return { start: lineStart(text, el.start), end: el.end, text: reindent(xml, indent, opts.unit, opts.eol) };
  }
  return { start: el.start, end: el.end, text: reindent(xml, "", opts.unit, opts.eol) };
}

/**
 * Sets (value string) or removes (value null) attributes on an element's start tag, editing only
 * the affected characters. New attributes follow the layout of existing ones (same line or one per line).
 */
export function setAttributesEdits(text: string, el: XElem, changes: Array<[string, string | null]>): Edit[] {
  const edits: Edit[] = [];
  const final = new Map<string, string | null>();
  for (const [k, v] of changes) final.set(k, v);
  let sep = " ";
  if (el.attrs.length) {
    const last = el.attrs[el.attrs.length - 1];
    let k = last.nameStart;
    while (k > el.nameEnd && /\s/.test(text[k - 1])) k--;
    const ws = text.slice(k, last.nameStart);
    if (ws.includes("\n")) sep = ws;
  }
  const additions: string[] = [];
  for (const [name, value] of final) {
    const attr = el.attrs.find((a) => a.name === name);
    if (attr) {
      if (value === null) {
        let k = attr.nameStart;
        while (k > el.nameEnd && /\s/.test(text[k - 1])) k--;
        edits.push({ start: k, end: attr.valueEnd + 1, text: "" });
      } else if (attr.value !== value) {
        edits.push({ start: attr.valueStart, end: attr.valueEnd, text: escapeAttr(value, attr.quote) });
      }
    } else if (value !== null) {
      additions.push(`${sep}${name}="${escapeAttr(value)}"`);
    }
  }
  if (additions.length) {
    const pos = el.attrs.length ? el.attrs[el.attrs.length - 1].valueEnd + 1 : el.nameEnd;
    edits.push({ start: pos, end: pos, text: additions.join("") });
  }
  return edits;
}

/** Builds `<tag a="1" b="2"/>`-style start tags. */
export function buildTag(name: string, attrs: Array<[string, string]>, selfClose: boolean): string {
  const a = attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("");
  return `<${name}${a}${selfClose ? " />" : ">"}`;
}
