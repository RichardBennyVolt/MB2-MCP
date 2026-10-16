import type { Ctx } from "../context.js";
import { displayName, type ObjRec } from "../model/objects.js";
import type { Args } from "../util/args.js";
import { clip } from "../util/text.js";

/** Tool output: plain text, or text plus images (e.g. an editor screenshot). */
export interface ToolOutput {
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
}

/** Tool groups that can be switched with MB2_TOOLSETS. */
export type ToolGroup = "core" | "edit" | "l10n" | "scene" | "assets" | "editor" | "logs";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  group: ToolGroup;
  readOnly?: boolean;
  destructive?: boolean;
  handler: (args: Args, ctx: Ctx) => Promise<string | ToolOutput> | string | ToolOutput;
}

// Plain JSON-Schema builders. Only "type/description/enum/items/properties/required" are used so that
// every client (Claude Code, Codex, DeepSeek Harness, OpenAI-style function calling) accepts them.
export const str = (description: string): Record<string, unknown> => ({ type: "string", description });
export const bool = (description: string): Record<string, unknown> => ({ type: "boolean", description });
export const int = (description: string): Record<string, unknown> => ({ type: "integer", description });
export const strEnum = (values: string[], description: string): Record<string, unknown> => ({ type: "string", enum: values, description });
export const strList = (description: string): Record<string, unknown> => ({ type: "array", items: { type: "string" }, description });
// Free-form map. No additionalProperties schema on purpose: some clients' schema converters reject it.
// Handlers also accept ["key=value", …] or "key=value; key2=value2".
export const strMap = (description: string): Record<string, unknown> => ({ type: "object", description: `${description} Values are strings.` });
export const objList = (description: string, properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "array",
  description,
  items: { type: "object", properties, ...(required.length ? { required } : {}) },
});

export function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

const KEY_ATTRS = [
  "culture",
  "Type",
  "crafting_template",
  "occupation",
  "default_group",
  "level",
  "tier",
  "is_hero",
  "is_female",
  "value",
  "weight",
  "owner",
  "super_faction",
  "clan",
  "faction",
  "kingdom",
  "text",
  "piece_type",
];

export function keyAttrs(o: ObjRec, max = 5): string {
  const parts: string[] = [];
  for (const k of KEY_ATTRS) {
    if (parts.length >= max) break;
    const a = o.attrs.find(([n]) => n === k);
    if (a && a[1] !== "" && k !== "text") parts.push(`${k}=${clip(a[1], 40)}`);
  }
  if (parts.length < 2) {
    for (const [k, v] of o.attrs) {
      if (parts.length >= max) break;
      if (k === "id" || k === "name" || KEY_ATTRS.includes(k) || !v) continue;
      parts.push(`${k}=${clip(v, 30)}`);
    }
  }
  return parts.join(" ");
}

export function objLabel(o: ObjRec, translated?: Map<string, string>): string {
  const dn = displayName(o.name);
  let label = `${o.tag}.${o.id}`;
  if (dn) label += ` "${clip(dn, 60)}"`;
  if (translated && o.name) {
    const m = /^\{=([^}]*)\}/.exec(o.name);
    const t = m && m[1] && m[1] !== "!" && m[1] !== "*" ? translated.get(m[1]) : undefined;
    if (t) label += ` 〔${clip(t, 40)}〕`;
  }
  return label;
}

export function objLine(o: ObjRec, translated?: Map<string, string>): string {
  const attrs = keyAttrs(o);
  return `${objLabel(o, translated)} — ${o.module} ${o.file.rel}:${o.line}${attrs ? ` | ${attrs}` : ""}`;
}

export function hasCjk(s: string): boolean {
  return /[぀-ヿ㐀-鿿가-힯]/.test(s);
}
