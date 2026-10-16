import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { Ctx } from "./context.js";
import type { ToolOutput } from "./tools/common.js";
import { ALL_TOOLS, enabledTools, type ToolDef } from "./tools/index.js";
import { Args } from "./util/args.js";
import { makeRedactor, type Redactor } from "./util/redact.js";
import { INSTRUCTIONS, VERSION } from "./version.js";

const debug = /^(1|true|yes)$/i.test(process.env.MB2_DEBUG ?? "");

export function log(...parts: unknown[]): void {
  // stdout is reserved for the protocol.
  process.stderr.write(`[mb2-mcp] ${parts.map((p) => (p instanceof Error ? (p.stack ?? p.message) : String(p))).join(" ")}\n`);
}

function limitOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[output truncated at ${max} of ${text.length} characters — narrow the request (limit/offset, module filter, path) to see the rest]`;
}

export function toolList(tools: ToolDef[] = ALL_TOOLS): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.readOnly
      ? { title: t.title, readOnlyHint: true, openWorldHint: false }
      : { title: t.title, readOnlyHint: false, destructiveHint: !["create_module", "scene_create", "asset_import", "editor_launch", "editor_command"].includes(t.name), openWorldHint: false },
  }));
}

export interface CallResult {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
  isError: boolean;
}

const redactors = new Map<boolean, Redactor>();
function redactorFor(ctx: Ctx): Redactor {
  const on = ctx.config.redact !== false;
  if (!redactors.has(on)) redactors.set(on, makeRedactor(on));
  return redactors.get(on)!;
}

/** Executes one tool call; used by the MCP handler and by tests. Output passes the redactor (MB2_REDACT). */
export async function callTool(ctx: Ctx, name: string, args: Record<string, unknown>, tools: ToolDef[] = ALL_TOOLS): Promise<CallResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { text: `Unknown tool '${name}'. Available: ${tools.map((t) => t.name).join(", ")}`, images: [], isError: true };
  const t0 = Date.now();
  const redact = redactorFor(ctx);
  try {
    ctx.prepare();
    const out: string | ToolOutput = await tool.handler(new Args(redact.arg(args ?? {}) as Record<string, unknown>), ctx);
    const res = typeof out === "string" ? { text: out, images: [] } : { text: out.text, images: out.images ?? [] };
    if (debug) log(`${name} ok ${Date.now() - t0}ms`);
    return { text: limitOutput(redact.text(res.text), ctx.config.maxOutputChars), images: res.images, isError: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (debug) log(`${name} failed ${Date.now() - t0}ms`, e);
    return { text: redact.text(`Error: ${msg}`), images: [], isError: true };
  }
}

export async function startServer(config: Config): Promise<void> {
  const ctx = new Ctx(config);
  const tools = enabledTools(config.toolsets);
  const server = new Server(
    { name: "mb2-mcp", title: "Bannerlord Mod Editor", version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList(tools) as never }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const r = await callTool(ctx, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, tools);
    const content: Array<Record<string, unknown>> = [{ type: "text", text: r.text }];
    for (const img of r.images) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    return { content: content as never, isError: r.isError };
  });
  process.on("uncaughtException", (e) => log("uncaught exception", e));
  process.on("unhandledRejection", (e) => log("unhandled rejection", e));
  const exit = (): void => process.exit(0);
  process.stdin.on("close", exit);
  process.on("SIGINT", exit);
  process.on("SIGTERM", exit);
  await server.connect(new StdioServerTransport());
  if (debug) log(`started v${VERSION} (node ${process.version}), ${tools.length} tools`);
}
