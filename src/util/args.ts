/**
 * Lenient argument access. Different harnesses/models send slightly different shapes
 * (numbers as strings, arrays as JSON strings or comma lists, objects as "k=v" lists),
 * so tools coerce instead of rejecting.
 */
export class Args {
  constructor(private readonly raw: Record<string, unknown>) {}

  /** The raw, uncoerced value. */
  value(name: string): unknown {
    return this.raw[name];
  }

  has(name: string): boolean {
    const v = this.raw[name];
    return v !== undefined && v !== null && v !== "";
  }

  str(name: string, def?: string): string | undefined {
    const v = this.raw[name];
    if (v === undefined || v === null) return def;
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return JSON.stringify(v);
  }

  req(name: string): string {
    const v = this.str(name);
    if (v === undefined || v.trim() === "") throw new Error(`Missing required argument '${name}'.`);
    return v;
  }

  bool(name: string, def: boolean): boolean {
    const v = this.raw[name];
    if (v === undefined || v === null || v === "") return def;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    return /^(true|1|yes|y|on)$/i.test(String(v).trim());
  }

  int(name: string, def: number, min = -Infinity, max = Infinity): number {
    const v = this.raw[name];
    if (v === undefined || v === null || v === "") return def;
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  }

  list(name: string): string[] {
    const v = this.raw[name];
    if (v === undefined || v === null || v === "") return [];
    if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).map((s) => s.trim()).filter(Boolean);
    if (typeof v === "string") {
      const s = v.trim();
      if (s.startsWith("[")) {
        try {
          const parsed = JSON.parse(s);
          if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
        } catch {
          /* fall through */
        }
      }
      return s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
    }
    return [String(v)];
  }

  /** Raw array of objects (for structured list parameters). */
  objects(name: string): Array<Record<string, unknown>> {
    let v = this.raw[name];
    if (v === undefined || v === null || v === "") return [];
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch {
        throw new Error(`Argument '${name}' must be an array of objects.`);
      }
    }
    if (!Array.isArray(v)) v = [v];
    return (v as unknown[]).filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
  }

  /** Map of string → string. Accepts an object, a JSON string, or "k=v" pairs (list or ';'/newline separated). */
  map(name: string): Array<[string, string]> {
    const v = this.raw[name];
    if (v === undefined || v === null || v === "") return [];
    const fromObj = (o: Record<string, unknown>): Array<[string, string]> =>
      Object.entries(o).map(([k, x]) => [k, x === null || x === undefined ? "" : typeof x === "string" ? x : typeof x === "object" ? JSON.stringify(x) : String(x)]);
    if (typeof v === "object" && !Array.isArray(v)) return fromObj(v as Record<string, unknown>);
    const pairs = (items: string[]): Array<[string, string]> =>
      items
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const eq = s.indexOf("=");
          if (eq <= 0) throw new Error(`Argument '${name}': expected key=value, got '${s}'.`);
          return [s.slice(0, eq).trim(), s.slice(eq + 1).trim().replace(/^"(.*)"$/s, "$1")] as [string, string];
        });
    if (Array.isArray(v)) {
      if (v.every((x) => typeof x === "object" && x !== null && !Array.isArray(x))) {
        return (v as Array<Record<string, unknown>>).flatMap((o) => ("key" in o && "value" in o ? [[String(o.key), String(o.value)] as [string, string]] : fromObj(o)));
      }
      return pairs(v.map(String));
    }
    const s = String(v).trim();
    if (s.startsWith("{")) {
      try {
        return fromObj(JSON.parse(s));
      } catch {
        throw new Error(`Argument '${name}' is not valid JSON.`);
      }
    }
    return pairs(s.split(/[;\n]/));
  }
}
