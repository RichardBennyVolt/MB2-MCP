import fs from "node:fs";
import path from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { readTextFile } from "../util/text.js";
import { scanXml } from "../xml/scanner.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type El = any;

export interface AttrInfo {
  name: string;
  type: string;
  use: string;
  default?: string;
  enumValues?: string[];
}

export interface ChildInfo {
  name: string;
  min: string;
  max: string;
  inChoice: boolean;
  decl: El;
}

export interface ElementInfo {
  name: string;
  path: string;
  attributes: AttrInfo[];
  children: ChildInfo[];
  textType?: string;
}

function kids(el: El): El[] {
  const out: El[] = [];
  for (let c = el?.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c);
  return out;
}

function stripPrefix(t: string): string {
  return t.includes(":") ? t.slice(t.indexOf(":") + 1) : t;
}

/** A parsed XSD from <game>/XmlSchemas, able to describe any element declared in it. */
export class XsdSchema {
  private complexTypes = new Map<string, El>();
  private simpleTypes = new Map<string, El>();
  private groups = new Map<string, El>();
  private attrGroups = new Map<string, El>();
  private globalElements = new Map<string, El>();
  private declsCache: Array<{ name: string; path: string; decl: El }> | null = null;

  constructor(
    readonly file: string,
    readonly id: string,
  ) {
    const { text } = readTextFile(file);
    const doc = new DOMParser({ onError: () => undefined }).parseFromString(text, "text/xml");
    const root = doc.documentElement;
    for (const c of kids(root)) {
      const name = c.getAttribute?.("name");
      if (!name) continue;
      switch (c.localName) {
        case "complexType":
          this.complexTypes.set(name, c);
          break;
        case "simpleType":
          this.simpleTypes.set(name, c);
          break;
        case "group":
          this.groups.set(name, c);
          break;
        case "attributeGroup":
          this.attrGroups.set(name, c);
          break;
        case "element":
          this.globalElements.set(name, c);
          break;
      }
    }
  }

  rootElements(): string[] {
    return [...this.globalElements.keys()];
  }

  private resolveElement(decl: El): El {
    const ref = decl.getAttribute("ref");
    return ref ? (this.globalElements.get(stripPrefix(ref)) ?? decl) : decl;
  }

  private complexTypeOf(decl: El): El | null {
    const d = this.resolveElement(decl);
    const t = d.getAttribute("type");
    if (t) return this.complexTypes.get(stripPrefix(t)) ?? null;
    return kids(d).find((k) => k.localName === "complexType") ?? null;
  }

  private simpleTypeInfo(typeName: string | null, inline: El | null, depth = 0): { type: string; enumValues?: string[] } {
    let st = inline;
    if (!st && typeName) {
      st = this.simpleTypes.get(stripPrefix(typeName)) ?? null;
      if (!st) return { type: stripPrefix(typeName) };
    }
    if (!st || depth > 8) return { type: typeName ? stripPrefix(typeName) : "string" };
    const restr = kids(st).find((k) => k.localName === "restriction");
    if (restr) {
      const enums = kids(restr)
        .filter((k) => k.localName === "enumeration")
        .map((k) => k.getAttribute("value"));
      const base = restr.getAttribute("base");
      const inner = kids(restr).find((k) => k.localName === "simpleType") ?? null;
      const baseInfo = base || inner ? this.simpleTypeInfo(base, inner, depth + 1) : { type: "string" };
      const facets = kids(restr)
        .filter((k) => k.localName !== "enumeration" && k.localName !== "simpleType" && k.localName !== "annotation")
        .map((k) => `${k.localName}=${k.getAttribute("value")}`);
      return {
        type: `${baseInfo.type}${facets.length ? ` (${facets.join(", ")})` : ""}`,
        enumValues: enums.length ? enums : baseInfo.enumValues,
      };
    }
    const union = kids(st).find((k) => k.localName === "union");
    if (union) {
      const members = (union.getAttribute("memberTypes") ?? "").split(/\s+/).filter(Boolean);
      const vals: string[] = [];
      const types: string[] = [];
      for (const m of members) {
        const i = this.simpleTypeInfo(m, null, depth + 1);
        types.push(i.type);
        if (i.enumValues) vals.push(...i.enumValues);
      }
      for (const inl of kids(union).filter((k) => k.localName === "simpleType")) {
        const i = this.simpleTypeInfo(null, inl, depth + 1);
        types.push(i.type);
        if (i.enumValues) vals.push(...i.enumValues);
      }
      return { type: `union(${types.join("|")})`, enumValues: vals.length ? vals : undefined };
    }
    const list = kids(st).find((k) => k.localName === "list");
    if (list) return { type: `list of ${stripPrefix(list.getAttribute("itemType") || "string")}` };
    return { type: typeName ? stripPrefix(typeName) : "string" };
  }

  private attrInfo(a: El): AttrInfo {
    const ref = a.getAttribute("ref");
    const name = a.getAttribute("name") || (ref ? stripPrefix(ref) : "?");
    const inline = kids(a).find((k) => k.localName === "simpleType") ?? null;
    const t = this.simpleTypeInfo(a.getAttribute("type") || null, inline);
    const info: AttrInfo = { name, type: t.type, use: a.getAttribute("use") || "optional" };
    const def = a.getAttribute("default") || a.getAttribute("fixed");
    if (def) info.default = def;
    if (t.enumValues) info.enumValues = t.enumValues;
    return info;
  }

  /** Attributes, child elements and text type of a complexType (following extensions and groups). */
  private complexInfo(ct: El, depth = 0): { attributes: AttrInfo[]; children: ChildInfo[]; textType?: string } {
    const attributes: AttrInfo[] = [];
    const children: ChildInfo[] = [];
    let textType: string | undefined;
    if (!ct || depth > 10) return { attributes, children };
    if (ct.getAttribute("mixed") === "true") textType = "mixed text";
    const particles = (node: El, inChoice: boolean): void => {
      for (const c of kids(node)) {
        switch (c.localName) {
          case "element": {
            const name = c.getAttribute("name") || stripPrefix(c.getAttribute("ref") || "?");
            children.push({ name, min: c.getAttribute("minOccurs") ?? "1", max: c.getAttribute("maxOccurs") ?? "1", inChoice, decl: c });
            break;
          }
          case "sequence":
          case "all":
            particles(c, inChoice);
            break;
          case "choice":
            particles(c, true);
            break;
          case "group": {
            const g = this.groups.get(stripPrefix(c.getAttribute("ref") || ""));
            if (g) particles(g, inChoice);
            break;
          }
          case "any":
            children.push({ name: "(any element)", min: c.getAttribute("minOccurs") ?? "1", max: c.getAttribute("maxOccurs") ?? "1", inChoice, decl: c });
            break;
        }
      }
    };
    const attrs = (node: El): void => {
      for (const c of kids(node)) {
        if (c.localName === "attribute") attributes.push(this.attrInfo(c));
        else if (c.localName === "attributeGroup") {
          const g = this.attrGroups.get(stripPrefix(c.getAttribute("ref") || ""));
          if (g) attrs(g);
        } else if (c.localName === "anyAttribute") attributes.push({ name: "(any attribute)", type: "any", use: "optional" });
      }
    };
    const body = (node: El): void => {
      particles(node, false);
      attrs(node);
      for (const c of kids(node)) {
        if (c.localName !== "simpleContent" && c.localName !== "complexContent") continue;
        for (const d of kids(c)) {
          if (d.localName !== "extension" && d.localName !== "restriction") continue;
          const base = d.getAttribute("base");
          if (base) {
            const baseCt = this.complexTypes.get(stripPrefix(base));
            if (baseCt && d.localName === "extension") {
              const bi = this.complexInfo(baseCt, depth + 1);
              attributes.push(...bi.attributes);
              children.push(...bi.children);
              textType = textType ?? bi.textType;
            } else if (!baseCt && c.localName === "simpleContent") {
              textType = this.simpleTypeInfo(base, null).type;
            }
          }
          body(d);
        }
      }
    };
    body(ct);
    return { attributes, children, textType };
  }

  /** Every element declaration with its path from a root element. */
  declarations(): Array<{ name: string; path: string; decl: El }> {
    if (this.declsCache) return this.declsCache;
    const out: Array<{ name: string; path: string; decl: El }> = [];
    const walk = (decl: El, parentPath: string, typeStack: string[], depth: number): void => {
      const d = this.resolveElement(decl);
      const name = d.getAttribute("name") || "?";
      const p = parentPath ? `${parentPath}/${name}` : name;
      out.push({ name, path: p, decl: d });
      if (depth > 14) return;
      const typeName = d.getAttribute("type") || "";
      if (typeName && typeStack.includes(typeName)) return;
      const ct = this.complexTypeOf(d);
      if (!ct) return;
      for (const ch of this.complexInfo(ct).children) {
        if (ch.name === "(any element)") continue;
        walk(ch.decl, p, typeName ? [...typeStack, typeName] : typeStack, depth + 1);
      }
    };
    for (const g of this.globalElements.values()) walk(g, "", [], 0);
    this.declsCache = out;
    return out;
  }

  /** Finds declarations by element name; `pathHint` (e.g. "Item/ItemComponent/Weapon") narrows the match. */
  find(name: string, pathHint?: string): Array<{ name: string; path: string; decl: El }> {
    const all = this.declarations().filter((d) => d.name === name || d.name.toLowerCase() === name.toLowerCase());
    if (!pathHint) return all;
    const hint = pathHint.replace(/^\/+|\/+$/g, "").toLowerCase();
    const narrowed = all.filter((d) => d.path.toLowerCase().endsWith(hint) || d.path.toLowerCase().includes(`/${hint}`));
    return narrowed.length ? narrowed : all;
  }

  describe(decl: El, pathStr: string): ElementInfo {
    const d = this.resolveElement(decl);
    const name = d.getAttribute("name") || "?";
    const ct = this.complexTypeOf(d);
    if (!ct) {
      const st = kids(d).find((k) => k.localName === "simpleType") ?? null;
      const t = this.simpleTypeInfo(d.getAttribute("type") || null, st);
      return { name, path: pathStr, attributes: [], children: [], textType: t.type + (t.enumValues ? ` enum: ${t.enumValues.join("|")}` : "") };
    }
    const info = this.complexInfo(ct);
    // De-duplicate (extensions can repeat attributes).
    const seen = new Set<string>();
    const attributes = info.attributes.filter((a) => (seen.has(a.name) ? false : (seen.add(a.name), true)));
    const seenC = new Set<string>();
    const children = info.children.filter((c) => (seenC.has(c.name) ? false : (seenC.add(c.name), true)));
    return { name, path: pathStr, attributes, children, textType: info.textType };
  }
}

export class SchemaStore {
  private cache = new Map<string, XsdSchema>();
  constructor(private readonly gameDir: () => string | null) {}

  dir(): string | null {
    const g = this.gameDir();
    if (!g) return null;
    const d = path.join(g, "XmlSchemas");
    return fs.existsSync(d) ? d : null;
  }

  /** XmlName ids that have an XSD (file names without .xsd). */
  ids(): string[] {
    const d = this.dir();
    if (!d) return [];
    return fs
      .readdirSync(d)
      .filter((f) => f.toLowerCase().endsWith(".xsd"))
      .map((f) => f.slice(0, -4))
      .sort((a, b) => a.localeCompare(b));
  }

  /** Path of <game>/XmlSchemas/<xmlId>.xsd (case-insensitive), or null. */
  pathFor(xmlId: string): string | null {
    const d = this.dir();
    if (!d) return null;
    const exact = path.join(d, `${xmlId}.xsd`);
    if (fs.existsSync(exact)) {
      const real = fs.readdirSync(d).find((f) => f.toLowerCase() === `${xmlId}.xsd`.toLowerCase());
      return real ? path.join(d, real) : exact;
    }
    const f = fs.readdirSync(d).find((x) => x.toLowerCase() === `${xmlId}.xsd`.toLowerCase());
    return f ? path.join(d, f) : null;
  }

  get(xmlId: string): XsdSchema | null {
    const p = this.pathFor(xmlId);
    if (!p) return null;
    let s = this.cache.get(p);
    if (!s) {
      s = new XsdSchema(p, path.basename(p, ".xsd"));
      this.cache.set(p, s);
    }
    return s;
  }
}

export interface ObservedAttr {
  name: string;
  count: number;
  values: Array<[string, number]>;
  distinct: number;
}

/**
 * Aggregates attribute usage of elements named `element` (optionally only those whose path ends
 * with `pathSuffix`) across the given files — "what do real game files put here?".
 */
export function observeAttributes(files: string[], element: string, pathSuffix?: string, maxValues = 5): { occurrences: number; attrs: ObservedAttr[]; childTags: Array<[string, number]> } {
  const counts = new Map<string, { count: number; values: Map<string, number> }>();
  const childTags = new Map<string, number>();
  let occurrences = 0;
  const suffix = pathSuffix ? pathSuffix.replace(/^\/+|\/+$/g, "").split("/") : null;
  for (const f of files) {
    let text: string;
    try {
      text = readTextFile(f).text;
    } catch {
      continue;
    }
    const stack: string[] = [];
    const matchStack: boolean[] = [];
    scanXml(text, {
      maxErrors: 1,
      onOpen: (el) => {
        stack.length = el.depth;
        stack.push(el.name);
        const parentMatched = el.depth > 0 && matchStack[el.depth - 1];
        if (parentMatched) childTags.set(el.name, (childTags.get(el.name) ?? 0) + 1);
        let matched = el.name === element;
        if (matched && suffix) {
          const tail = stack.slice(-suffix.length);
          matched = tail.length === suffix.length && tail.every((s, i) => s === suffix[i] || suffix[i] === "*");
        }
        matchStack.length = el.depth;
        matchStack.push(matched);
        if (!matched) return;
        occurrences++;
        for (const a of el.attrs) {
          let c = counts.get(a.name);
          if (!c) counts.set(a.name, (c = { count: 0, values: new Map() }));
          c.count++;
          const v = a.value.length > 60 ? `${a.value.slice(0, 57)}...` : a.value;
          if (c.values.size < 400 || c.values.has(v)) c.values.set(v, (c.values.get(v) ?? 0) + 1);
        }
      },
    });
  }
  const attrs = [...counts.entries()]
    .map(([name, c]) => ({
      name,
      count: c.count,
      distinct: c.values.size,
      values: [...c.values.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxValues),
    }))
    .sort((a, b) => b.count - a.count);
  return { occurrences, attrs, childTags: [...childTags.entries()].sort((a, b) => b[1] - a[1]) };
}
