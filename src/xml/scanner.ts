/**
 * A small, fast, error-tolerant XML tokenizer that keeps exact source offsets.
 *
 * It is used for indexing (streaming callbacks over ~30 MB of vanilla data) and for
 * surgical text edits: because every element/attribute knows its byte range, edits can
 * splice only the changed characters and leave the rest of a file untouched.
 * Strict well-formedness checking is done separately (see wellformed.ts).
 */

export interface XAttr {
  name: string;
  /** Decoded value (entities resolved, literal whitespace normalized like an XML parser does). */
  value: string;
  nameStart: number;
  /** Offset of the first character inside the quotes. */
  valueStart: number;
  /** Offset of the closing quote. */
  valueEnd: number;
  quote: '"' | "'";
}

export interface XElem {
  name: string;
  attrs: XAttr[];
  /** Offset of '<'. */
  start: number;
  /** Offset just after the tag name. */
  nameEnd: number;
  /** Offset just after the '>' (or '/>') of the start tag. */
  openEnd: number;
  /** Offset of '</' of the end tag, -1 for self-closing elements. */
  closeStart: number;
  /** Offset just after the element. */
  end: number;
  selfClosing: boolean;
  depth: number;
  /** 1-based line of '<'. */
  line: number;
  parent: XElem | null;
  /** Child elements; only populated when scanning with buildTree. */
  children: XElem[] | null;
}

export interface XmlIssue {
  message: string;
  line: number;
  col: number;
  offset: number;
}

export interface ScanOptions {
  buildTree?: boolean;
  onOpen?: (el: XElem) => void;
  onClose?: (el: XElem) => void;
  maxErrors?: number;
}

export interface ScanResult {
  root: XElem | null;
  errors: XmlIssue[];
}

class LineCounter {
  private line = 1;
  private pos = 0;
  constructor(private readonly text: string) {}

  /** Line number of `offset`. Cheap when called with non-decreasing offsets. */
  at(offset: number): number {
    if (offset < this.pos) {
      this.line = 1;
      this.pos = 0;
    }
    const t = this.text;
    let p = this.pos;
    let line = this.line;
    for (;;) {
      const k = t.indexOf("\n", p);
      if (k === -1 || k >= offset) break;
      line++;
      p = k + 1;
    }
    this.pos = p;
    this.line = line;
    return line;
  }
}

export function columnAt(text: string, offset: number): number {
  return offset - (text.lastIndexOf("\n", offset - 1) + 1) + 1;
}

export function lineAt(text: string, offset: number): number {
  let line = 1;
  let p = 0;
  for (;;) {
    const k = text.indexOf("\n", p);
    if (k === -1 || k >= offset) return line;
    line++;
    p = k + 1;
  }
}

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (s.indexOf("&") === -1) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return NAMED_ENTITIES[e] ?? m;
  });
}

/** Attribute value as an XML parser reports it: literal tabs/newlines become spaces, then entities are decoded. */
export function decodeAttr(raw: string): string {
  const normalized = /[\t\r\n]/.test(raw) ? raw.replace(/\r\n|[\t\r\n]/g, " ") : raw;
  return decodeEntities(normalized);
}

export function escapeAttr(value: string, quote: '"' | "'" = '"'): string {
  let s = value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  s = quote === '"' ? s.replace(/"/g, "&quot;") : s.replace(/'/g, "&apos;");
  return s.replace(/\n/g, "&#10;").replace(/\r/g, "&#13;").replace(/\t/g, "&#9;");
}

export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isNameStartCode(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58 || c > 127;
}

function hasNonWhitespace(text: string, from: number, to: number): boolean {
  for (let k = from; k < to; k++) {
    const c = text.charCodeAt(k);
    if (c > 32 && c !== 0xfeff) return true;
  }
  return false;
}

export function scanXml(text: string, opts: ScanOptions = {}): ScanResult {
  const n = text.length;
  const errors: XmlIssue[] = [];
  const maxErrors = opts.maxErrors ?? 50;
  const lc = new LineCounter(text);
  const stack: XElem[] = [];
  let root: XElem | null = null;
  const buildTree = !!opts.buildTree;
  const onOpen = opts.onOpen;
  const onClose = opts.onClose;

  const err = (message: string, offset: number): void => {
    if (errors.length >= maxErrors) return;
    const o = Math.min(Math.max(offset, 0), n);
    errors.push({ message, offset: o, line: lc.at(o), col: columnAt(text, o) });
  };

  const closeTag = (name: string, lt: number, after: number): void => {
    if (stack.length === 0) {
      err(`Unexpected end tag </${name}>`, lt);
      return;
    }
    const top = stack[stack.length - 1];
    if (top.name === name) {
      stack.pop();
      top.closeStart = lt;
      top.end = after;
      onClose?.(top);
      return;
    }
    let idx = -1;
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].name === name) {
        idx = k;
        break;
      }
    }
    if (idx === -1) {
      err(`End tag </${name}> does not match the open element <${top.name}> from line ${top.line}`, lt);
      return;
    }
    while (stack.length - 1 > idx) {
      const e = stack.pop()!;
      err(`Element <${e.name}> (line ${e.line}) is not closed before </${name}>`, lt);
      e.closeStart = lt;
      e.end = lt;
      onClose?.(e);
    }
    const e = stack.pop()!;
    e.closeStart = lt;
    e.end = after;
    onClose?.(e);
  };

  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt === -1) {
      if (stack.length === 0 && hasNonWhitespace(text, i, n)) err("Text outside of the root element", i);
      break;
    }
    if (stack.length === 0 && lt > i && hasNonWhitespace(text, i, lt)) err("Text outside of the root element", i);
    const c1 = text.charCodeAt(lt + 1);

    if (c1 === 33 /* ! */) {
      if (text.startsWith("!--", lt + 1)) {
        const e = text.indexOf("-->", lt + 4);
        if (e === -1) {
          err("Unterminated comment <!--", lt);
          i = n;
          break;
        }
        i = e + 3;
        continue;
      }
      if (text.startsWith("![CDATA[", lt + 1)) {
        const e = text.indexOf("]]>", lt + 9);
        if (e === -1) {
          err("Unterminated CDATA section", lt);
          i = n;
          break;
        }
        i = e + 3;
        continue;
      }
      let j = lt + 2;
      let brackets = 0;
      while (j < n) {
        const ch = text.charCodeAt(j);
        if (ch === 91) brackets++;
        else if (ch === 93) brackets--;
        else if (ch === 62 && brackets <= 0) break;
        j++;
      }
      i = j + 1;
      continue;
    }

    if (c1 === 63 /* ? */) {
      const e = text.indexOf("?>", lt + 2);
      if (e === -1) {
        err("Unterminated processing instruction <?", lt);
        i = n;
        break;
      }
      i = e + 2;
      continue;
    }

    if (c1 === 47 /* / */) {
      const gt = text.indexOf(">", lt + 2);
      if (gt === -1) {
        err("Unterminated end tag", lt);
        i = n;
        break;
      }
      closeTag(text.slice(lt + 2, gt).trim(), lt, gt + 1);
      i = gt + 1;
      continue;
    }

    // Start tag.
    let j = lt + 1;
    while (j < n) {
      const ch = text.charCodeAt(j);
      if (ch <= 32 || ch === 47 || ch === 62 || ch === 60) break;
      j++;
    }
    const name = text.slice(lt + 1, j);
    if (!name || !isNameStartCode(name.charCodeAt(0))) {
      err("Stray '<' that does not start a tag (escape it as &lt;)", lt);
      i = lt + 1;
      continue;
    }
    const nameEnd = j;
    const attrs: XAttr[] = [];
    let selfClosing = false;
    let closed = false;
    while (j < n) {
      let ch = text.charCodeAt(j);
      if (ch <= 32) {
        j++;
        continue;
      }
      if (ch === 62) {
        j++;
        closed = true;
        break;
      }
      if (ch === 47) {
        if (text.charCodeAt(j + 1) === 62) {
          j += 2;
          selfClosing = true;
          closed = true;
          break;
        }
        err(`Unexpected '/' inside <${name}>`, j);
        j++;
        continue;
      }
      if (ch === 60) {
        err(`Start tag <${name}> is not closed with '>'`, lt);
        break;
      }
      const ns = j;
      while (j < n) {
        ch = text.charCodeAt(j);
        if (ch <= 32 || ch === 61 || ch === 62 || ch === 47 || ch === 60) break;
        j++;
      }
      const an = text.slice(ns, j);
      if (!an) {
        err(`Malformed attribute in <${name}>`, ns);
        j++;
        continue;
      }
      while (j < n && text.charCodeAt(j) <= 32) j++;
      if (text.charCodeAt(j) !== 61) {
        err(`Attribute '${an}' of <${name}> has no value`, ns);
        continue;
      }
      j++;
      while (j < n && text.charCodeAt(j) <= 32) j++;
      const q = text.charCodeAt(j);
      if (q !== 34 && q !== 39) {
        err(`Value of attribute '${an}' of <${name}> must be quoted`, j);
        while (j < n && text.charCodeAt(j) > 32 && text.charCodeAt(j) !== 62) j++;
        continue;
      }
      const ve = text.indexOf(q === 34 ? '"' : "'", j + 1);
      if (ve === -1) {
        err(`Unterminated value of attribute '${an}'`, j);
        j = n;
        break;
      }
      const raw = text.slice(j + 1, ve);
      if (raw.indexOf("<") !== -1) err(`Attribute '${an}' of <${name}> contains a raw '<' (use &lt;)`, j + 1);
      for (const a of attrs) {
        if (a.name === an) {
          err(`Duplicate attribute '${an}' in <${name}>`, ns);
          break;
        }
      }
      attrs.push({ name: an, value: decodeAttr(raw), nameStart: ns, valueStart: j + 1, valueEnd: ve, quote: q === 34 ? '"' : "'" });
      j = ve + 1;
    }
    if (!closed && j >= n) err(`Unterminated start tag <${name}>`, lt);

    const parent = stack.length ? stack[stack.length - 1] : null;
    const el: XElem = {
      name,
      attrs,
      start: lt,
      nameEnd,
      openEnd: j,
      closeStart: -1,
      end: -1,
      selfClosing,
      depth: stack.length,
      line: lc.at(lt),
      parent,
      children: buildTree ? [] : null,
    };
    if (!parent) {
      if (root === null) root = el;
      else err(`More than one root element (<${root.name}> and <${name}>)`, lt);
    } else if (buildTree) {
      parent.children!.push(el);
    }
    onOpen?.(el);
    if (selfClosing) {
      el.end = j;
      onClose?.(el);
    } else {
      stack.push(el);
    }
    i = j;
  }

  while (stack.length) {
    const el = stack.pop()!;
    err(`Element <${el.name}> (line ${el.line}) is never closed`, n);
    el.closeStart = n;
    el.end = n;
    onClose?.(el);
  }
  return { root, errors };
}

/** Parses `text` into a tree (children populated). */
export function parseTree(text: string, maxErrors = 50): ScanResult {
  return scanXml(text, { buildTree: true, maxErrors });
}

export function getAttr(el: XElem | null | undefined, name: string): string | undefined {
  if (!el) return undefined;
  for (const a of el.attrs) if (a.name === name) return a.value;
  return undefined;
}

export function findAttr(el: XElem, name: string): XAttr | undefined {
  for (const a of el.attrs) if (a.name === name) return a;
  return undefined;
}

export function childElements(el: XElem | null | undefined, name?: string): XElem[] {
  if (!el || !el.children) return [];
  return name === undefined ? el.children : el.children.filter((c) => c.name === name);
}

export function firstChild(el: XElem | null | undefined, name: string, ignoreCase = false): XElem | undefined {
  if (!el || !el.children) return undefined;
  if (!ignoreCase) return el.children.find((c) => c.name === name);
  const lower = name.toLowerCase();
  return el.children.find((c) => c.name.toLowerCase() === lower);
}

export function* walk(el: XElem): Generator<XElem> {
  yield el;
  if (el.children) for (const c of el.children) yield* walk(c);
}

// ---------------------------------------------------------------------------------------------
// Mini path: a tiny XPath subset used to address elements inside an object, e.g.
//   ItemComponent/Weapon
//   skills/skill[@id='OneHanded']
//   Equipments/EquipmentRoster[2]/equipment[@slot='Item0']
// ---------------------------------------------------------------------------------------------

export type PathPred = { attr: string; value?: string } | { index: number };
export interface PathStep {
  name: string;
  preds: PathPred[];
}

export function parseMiniPath(path: string): PathStep[] {
  const steps: PathStep[] = [];
  const src = path.trim().replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  if (!src) return steps;
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  let quote = "";
  for (const ch of src) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "[") depth++;
    else if (ch === "]") depth--;
    if (ch === "/" && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  for (const raw of parts) {
    const part = raw.trim();
    const m = /^([A-Za-z_:*][\w.:-]*|\*)((?:\[[^\]]*\])*)$/.exec(part);
    if (!m) throw new Error(`Invalid path step '${part}'. Use e.g. ItemComponent/Weapon or skills/skill[@id='OneHanded']`);
    const preds: PathPred[] = [];
    const predRe = /\[([^\]]*)\]/g;
    let pm: RegExpExecArray | null;
    while ((pm = predRe.exec(m[2]))) {
      const body = pm[1].trim();
      let am: RegExpExecArray | null;
      if (/^\d+$/.test(body)) preds.push({ index: parseInt(body, 10) });
      else if ((am = /^@([\w.:-]+)\s*=\s*(['"])(.*)\2$/.exec(body))) preds.push({ attr: am[1], value: am[3] });
      else if ((am = /^@([\w.:-]+)$/.exec(body))) preds.push({ attr: am[1] });
      else throw new Error(`Unsupported predicate [${body}] in path step '${part}'. Supported: [@attr='value'], [@attr], [n]`);
    }
    steps.push({ name: m[1], preds });
  }
  return steps;
}

export function selectMiniPath(from: XElem, steps: PathStep[]): XElem[] {
  let current: XElem[] = [from];
  for (const step of steps) {
    const next: XElem[] = [];
    for (const el of current) {
      let matches = (el.children ?? []).filter((c) => step.name === "*" || c.name === step.name);
      for (const p of step.preds) {
        if ("index" in p) matches = matches.length >= p.index ? [matches[p.index - 1]] : [];
        else matches = matches.filter((c) => (p.value === undefined ? getAttr(c, p.attr) !== undefined : getAttr(c, p.attr) === p.value));
      }
      next.push(...matches);
    }
    current = next;
  }
  return current;
}

/** Renders steps back to an XPath fragment usable in XSLT match patterns. */
export function miniPathToXPath(steps: PathStep[]): string {
  return steps
    .map((s) => {
      let out = s.name;
      for (const p of s.preds) {
        if ("index" in p) out += `[${p.index}]`;
        else if (p.value === undefined) out += `[@${p.attr}]`;
        else out += `[@${p.attr}=${xpathLiteral(p.value)}]`;
      }
      return out;
    })
    .join("/");
}

export function xpathLiteral(v: string): string {
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('"')) return `"${v}"`;
  return `concat('${v.split("'").join(`', "'", '`)}')`;
}
