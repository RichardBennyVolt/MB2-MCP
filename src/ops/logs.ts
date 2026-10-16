import fs from "node:fs";
import path from "node:path";
import { programDataDir, userGameDocsDir } from "../gamepaths.js";
import { decodeBuffer } from "../util/text.js";

export interface LogFile {
  path: string;
  size: number;
  mtime: number;
}

export function logRoots(): string[] {
  const pd = programDataDir();
  const docs = userGameDocsDir();
  return [path.join(pd, "logs"), path.join(pd, "crashes"), path.join(docs, "Logs"), path.join(docs, "ModLogs"), path.join(docs, "crashes"), path.join(docs, "Crashes")].filter((d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

export function listLogs(limit = 30): LogFile[] {
  const out: LogFile[] = [];
  const visit = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      // Links and junctions are not followed: everything listed physically lies inside a log folder.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (depth < 2) visit(p, depth + 1);
      } else if (/\.(txt|log|html?|xml|json)$/i.test(e.name)) {
        try {
          const st = fs.statSync(p);
          out.push({ path: p, size: st.size, mtime: st.mtimeMs });
        } catch {
          /* skip */
        }
      }
    }
  };
  for (const r of logRoots()) visit(r, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/** True when `file` (a real path) lies inside `root` after resolving links: "..", look-alike sibling folders and links out fail. */
export function insideFolder(root: string, file: string): boolean {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return false;
  }
  const rel = path.relative(realRoot, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export const ERROR_PATTERN = /\b(error|exception|crash(ed)?|fatal|failed|failure|not found|cannot|can't|unable|invalid|missing)\b/i;

export function resolveLogFile(spec: string | undefined): string {
  const files = listLogs(500);
  if (!files.length) throw new Error(`No game logs found (looked in ${[path.join(programDataDir(), "logs"), path.join(userGameDocsDir(), "Logs")].join(", ")}). Start the game once.`);
  const s = (spec ?? "latest").trim();
  if (s === "latest" || s === "") {
    const f = files.find((x) => /rgl_log_\d+\.txt$/i.test(x.path)) ?? files[0];
    return f.path;
  }
  if (s === "latest-errors" || s === "errors") {
    const f = files.find((x) => /rgl_log_errors_\d+\.txt$/i.test(x.path));
    if (!f) throw new Error("No rgl_log_errors_*.txt found.");
    return f.path;
  }
  if (s === "launcher") {
    const f = files.find((x) => /launcher_log/i.test(x.path));
    if (!f) throw new Error("No launcher log found.");
    return f.path;
  }
  if (path.isAbsolute(s)) {
    let real: string;
    try {
      real = fs.realpathSync(path.resolve(s));
    } catch {
      throw new Error(`Log file '${s}' not found.`);
    }
    if (!fs.statSync(real).isFile() || !logRoots().some((r) => insideFolder(r, real))) throw new Error("Only files inside the game's log folders can be read.");
    return real;
  }
  const byName = files.find((x) => path.basename(x.path).toLowerCase() === s.toLowerCase()) ?? files.find((x) => x.path.toLowerCase().includes(s.toLowerCase()));
  if (!byName) throw new Error(`Log '${s}' not found. Use action=list to see available logs.`);
  return byName.path;
}

export function readLog(file: string, opts: { grep?: string; errorsOnly: boolean; tail: number; context: number }): string {
  const buf = fs.readFileSync(file);
  const text = decodeBuffer(buf).text;
  const lines = text.split(/\r?\n/);
  let re: RegExp | null = null;
  if (opts.grep) {
    try {
      re = new RegExp(opts.grep, "i");
    } catch {
      re = new RegExp(opts.grep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
  } else if (opts.errorsOnly) re = ERROR_PATTERN;
  const header = `${file} (${lines.length} lines, ${new Date(fs.statSync(file).mtimeMs).toLocaleString()})`;
  if (!re) {
    const start = Math.max(0, lines.length - opts.tail);
    return [header, `showing lines ${start + 1}-${lines.length}:`, ...lines.slice(start).map((l, i) => `${start + i + 1}: ${l}`)].join("\n");
  }
  const hits: number[] = [];
  lines.forEach((l, i) => {
    if (re!.test(l)) hits.push(i);
  });
  const chosen = hits.slice(-opts.tail);
  const show = new Set<number>();
  for (const h of chosen) for (let k = Math.max(0, h - opts.context); k <= Math.min(lines.length - 1, h + opts.context); k++) show.add(k);
  const out = [header, `${hits.length} matching line(s) for /${re.source}/i${hits.length > chosen.length ? `, showing the last ${chosen.length}` : ""}:`];
  let prev = -2;
  for (const k of [...show].sort((a, b) => a - b)) {
    if (k !== prev + 1 && out.length > 2) out.push("…");
    out.push(`${k + 1}: ${lines[k]}`);
    prev = k;
  }
  return out.join("\n");
}
