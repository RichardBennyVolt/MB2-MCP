import path from "node:path";
import { listLogs, readLog, resolveLogFile } from "../ops/logs.js";
import { bool, int, schema, str, strEnum, type ToolDef } from "./common.js";

export const miscTools: ToolDef[] = [
  {
    name: "read_logs",
    group: "logs",
    title: "Read game logs",
    description:
      "Reads Bannerlord's logs to debug a mod: rgl_log_*.txt (main log), rgl_log_errors_*.txt, launcher and crash files under ProgramData and Documents. action=list shows recent files; action=read (default) shows the tail of the latest log or matches of grep / errors_only.",
    inputSchema: schema({
      action: strEnum(["read", "list"], "read (default) or list."),
      file: str("latest (default), latest-errors, launcher, a file name from action=list, or a full path inside a log folder."),
      grep: str("Regex or text to filter lines (case-insensitive), e.g. your module id or 'xml'."),
      errors_only: bool("Only lines that look like errors/exceptions (default false)."),
      tail: int("Max lines/matches to return (default 120, max 1000)."),
      context: int("Context lines around matches (default 0, max 10)."),
    }),
    readOnly: true,
    handler: (a) => {
      if ((a.str("action") ?? "read") === "list") {
        const files = listLogs(40);
        if (!files.length) return "No log files found. Start the game once (logs: %ProgramData%\\Mount and Blade II Bannerlord\\logs).";
        return [
          "Recent log files (newest first):",
          ...files.map((f) => `${new Date(f.mtime).toLocaleString()}  ${(f.size / 1024).toFixed(0).padStart(6)} KB  ${path.basename(f.path)}  — ${f.path}`),
        ].join("\n");
      }
      const file = resolveLogFile(a.str("file"));
      return readLog(file, { grep: a.str("grep"), errorsOnly: a.bool("errors_only", false), tail: a.int("tail", 120, 1, 1000), context: a.int("context", 0, 0, 10) });
    },
  },
  {
    name: "edit_history",
    group: "logs",
    title: "List edits made by this server",
    description: "Lists recent changes made through this MCP server (every write is journaled with a backup), newest first.",
    inputSchema: schema({ limit: int("How many entries (default 20)."), module: str("Only entries of this module.") }),
    readOnly: true,
    handler: (a, ctx) => {
      const entries = ctx.history.entries(a.int("limit", 20, 1, 200), a.str("module"));
      if (!entries.length) return "No edits recorded yet.";
      return entries
        .map((e) => {
          const files = e.files.map((f) => `${f.existed ? (f.afterHash ? "M" : "D") : "A"} ${f.path}`);
          return `#${e.seq} ${e.time} ${e.tool} [${e.module}] ${e.summary}${e.undone ? " (UNDONE)" : ""}\n    ${files.join("\n    ")}`;
        })
        .join("\n");
    },
  },
  {
    name: "forget_history",
    group: "logs",
    title: "Delete the edit history",
    description:
      "Deletes this server's edit journal and the file backups it keeps for undo_edit (in MB2_DATA_DIR, default %LOCALAPPDATA%\\mb2-mcp\\history): all of it, or only edits older than older_than_days. Forgotten edits can no longer be undone. Needs confirm=true. (Screenshots and traces in the bridge folder: editor_command action=cleanup.)",
    inputSchema: schema({
      older_than_days: int("Only forget edits older than this many days (default: all)."),
      confirm: bool("Must be true: forgotten edits cannot be undone any more."),
    }),
    destructive: true,
    handler: (a, ctx) => {
      if (!a.bool("confirm", false)) throw new Error("forget_history deletes backups, so the forgotten edits cannot be undone; call again with confirm=true.");
      const days = a.has("older_than_days") ? a.int("older_than_days", 0, 0, 36500) : undefined;
      const r = ctx.history.forget(days);
      return r.removed
        ? `Forgot ${r.removed} edit(s)${days !== undefined ? ` older than ${days} day(s)` : ""} and freed ${(r.freedBytes / 1024 / 1024).toFixed(1)} MB of backups; ${r.kept} edit(s) remain undoable.`
        : "Nothing to forget.";
    },
  },
  {
    name: "undo_edit",
    group: "logs",
    title: "Undo an edit",
    description:
      "Reverts one change made through this server (default: the most recent not yet undone, optionally of one module), restoring backed-up files and deleting files it created. Refuses if the files changed afterwards unless force=true.",
    inputSchema: schema({
      seq: int("Edit number from edit_history (default: latest)."),
      module: str("Undo the latest edit of this module."),
      force: bool("Undo even if files were modified after the edit (those later changes are lost)."),
    }),
    destructive: true,
    handler: (a, ctx) => {
      const seq = a.has("seq") ? a.int("seq", 0) : undefined;
      const r = ctx.history.undo(seq, a.bool("force", false), a.str("module"));
      ctx.afterWrite(r.entry.module);
      const lines = [`Undid #${r.entry.seq} ${r.entry.tool} [${r.entry.module}] ${r.entry.summary}`];
      for (const f of r.restored) lines.push(`  restored ${f}`);
      for (const f of r.deleted) lines.push(`  deleted ${f}`);
      for (const f of r.skipped) lines.push(`  NOT restored (no backup of the overwritten file): ${f}`);
      return lines.join("\n");
    },
  },
];
