import fs from "node:fs";
import path from "node:path";
import { programDataDir } from "../gamepaths.js";
import { decodeBuffer } from "../util/text.js";

/**
 * What a game session wrote to C:\ProgramData\Mount and Blade II Bannerlord\logs: the module list it was
 * started with, the warnings and errors it raised (rgl_log_errors_<pid>.txt) and what its crash watchdog
 * is doing (watchdog_log_<pid>.txt). The Modding Kit build stops for every warning while the watchdog
 * collects a dump, so these explain a game that "hangs" while loading.
 */

export function gameLogFile(kind: "rgl" | "errors" | "watchdog", pid: number): string {
  const name = kind === "rgl" ? `rgl_log_${pid}.txt` : kind === "errors" ? `rgl_log_errors_${pid}.txt` : `watchdog_log_${pid}.txt`;
  return path.join(programDataDir(), "logs", name);
}

/** Pid of the newest session that wrote an error log (for a post-mortem when no game runs). */
export function latestSessionPid(): number | null {
  const dir = path.join(programDataDir(), "logs");
  let best: { pid: number; mtime: number } | null = null;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const f of entries) {
    const m = /^rgl_log_errors_(\d+)\.txt$/i.exec(f);
    if (!m) continue;
    try {
      const mtime = fs.statSync(path.join(dir, f)).mtimeMs;
      if (!best || mtime > best.mtime) best = { pid: Number(m[1]), mtime };
    } catch {
      /* gone */
    }
  }
  return best?.pid ?? null;
}

function readText(file: string, maxBytes = 8 * 1024 * 1024): string | null {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    try {
      const n = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, st.size - n);
      return decodeBuffer(buf).text;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Module ids from the "Command Args: … _MODULES_*A*B*_MODULES_" line of rgl_log_<pid>.txt. */
export function parseLaunchModules(text: string): string[] | null {
  const m = /Command Args:.*?_MODULES_\*(.*?)\*_MODULES_/.exec(text);
  return m ? m[1].split("*").filter(Boolean) : null;
}

export interface EngineMessageGroup {
  /** Message with its last word replaced by "*" when several differ only there. */
  key: string;
  count: number;
  /** The differing last words (e.g. mesh names), in order. */
  items: string[];
  firstTime?: string;
  lastTime?: string;
}

/** Origin assembly of a stack-only "WARNING: …dll@token@offset" entry (first frame outside the warning plumbing). */
function stackOrigin(lines: string[]): string | null {
  for (const l of lines) {
    const at = l.indexOf(".dll@");
    if (at < 0) continue;
    const name = l.slice(0, at + 4).split(/[\\/]/).pop()!.replace(/^\s*WARNING:\s*/, "");
    if (/^TaleWorlds\.(DotNet|Engine\.dll|Library\.dll)/i.test(name)) continue;
    return name;
  }
  return null;
}

/** Warnings and errors of rgl_log_errors_<pid>.txt, grouped. */
export function parseErrorLog(text: string): { total: number; groups: EngineMessageGroup[] } {
  const lines = text.split(/\r?\n/);
  const groups = new Map<string, EngineMessageGroup>();
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^<#{10,}>\s*$/.test(lines[i])) continue;
    // [time] / message / [time] #stack…
    let j = i + 1;
    let time: string | undefined;
    const block: string[] = [];
    for (; j < lines.length && block.length < 12; j++) {
      const l = lines[j];
      if (/^<#{10,}>\s*$/.test(l)) break;
      const t = /^\[(\d\d:\d\d:\d\d(?:\.\d+)?)\]\s*(.*)$/.exec(l);
      if (t) {
        time ??= t[1];
        if (t[2].trim()) block.push(t[2].trim());
        continue;
      }
      if (l.trim()) block.push(l.trim());
    }
    const first = block.find((l) => !l.startsWith("#")) ?? block[0];
    if (!first) continue;
    total++;
    let message = first;
    if (/^WARNING:.*\.dll@\d+@\d+/i.test(first)) {
      const origin = stackOrigin(block);
      message = `RGL WARNING (managed stack${origin ? ` from ${origin}` : ""})`;
    }
    const words = message.split(" ");
    const last = words.length > 2 && !message.startsWith("RGL WARNING (") ? words[words.length - 1] : "";
    const key = last ? `${words.slice(0, -1).join(" ")} *` : message;
    const g = groups.get(key) ?? groups.get(message);
    if (g) {
      g.count++;
      if (last) g.items.push(last);
      g.lastTime = time ?? g.lastTime;
    } else {
      groups.set(last ? key : message, { key: last ? key : message, count: 1, items: last ? [last] : [], firstTime: time, lastTime: time });
    }
  }
  // A group with a single item reads better as the plain message.
  const out = [...groups.values()].map((g) => (g.count === 1 && g.items.length === 1 ? { ...g, key: g.key.replace(/\*$/, g.items[0]), items: [] } : g));
  return { total, groups: out };
}

export interface WatchdogState {
  /** Dump requests the game sent for warnings/errors ("-td <thread>--<message>"). */
  requests: number;
  /** Message of the newest request, when it has not finished yet. */
  pending?: string;
  lastMessage?: string;
  canceled: number;
  /** "Crash occurred" lines: the game itself crashed (not just a warning dump). */
  crashes: number;
}

export function parseWatchdogLog(text: string): WatchdogState {
  const st: WatchdogState = { requests: 0, canceled: 0, crashes: 0 };
  let open = false;
  for (const line of text.split(/\r?\n/)) {
    if (/Crash occurred/i.test(line)) {
      st.crashes++;
      continue;
    }
    const td = /^\[DebuggerConfiguration\] -td \d+--(.*)$/.exec(line);
    if (td) {
      st.requests++;
      open = true;
      const msg = td[1].trim();
      st.lastMessage = /\.dll@\d+@/.test(msg) ? "RGL WARNING (managed stack)" : msg;
      continue;
    }
    if (/User canceled dump|Dump generation canceled|dump (and report )?(was )?(written|generated|created)|Skipping (dump|report) generation/i.test(line)) {
      if (/cancel/i.test(line)) st.canceled++;
      open = false;
    }
  }
  if (open) st.pending = st.lastMessage;
  return st;
}

/** Sizes of a session's logs, to read what a command added afterwards (logSince). */
export function logMark(pid: number): { rgl: number; errors: number } {
  const size = (f: string): number => {
    try {
      return fs.statSync(f).size;
    } catch {
      return 0;
    }
  };
  return { rgl: size(gameLogFile("rgl", pid)), errors: size(gameLogFile("errors", pid)) };
}

/** Lines the game logged since `mark` (timestamps stripped, blank lines dropped, at most `limit`). */
export function logSince(pid: number, mark: { rgl: number; errors: number }, limit = 30): string[] {
  const tail = (file: string, from: number): string => {
    try {
      const st = fs.statSync(file);
      if (st.size <= from) return "";
      const n = Math.min(st.size - from, 256 * 1024);
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, st.size - n);
        return decodeBuffer(buf).text;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return "";
    }
  };
  const lines = tail(gameLogFile("rgl", pid), mark.rgl)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\[\d\d:\d\d:\d\d(?:\.\d+)?\]\s*/, "").trim())
    .filter((l) => l && !l.startsWith("#"));
  const errors = parseErrorLog(tail(gameLogFile("errors", pid), mark.errors));
  const out = lines.slice(-limit);
  for (const g of errors.groups) out.push(`(error log) ${g.key}${g.count > 1 ? ` ×${g.count}` : ""}`);
  return out;
}

export interface SessionDiagnostics {
  pid: number;
  modules: string[] | null;
  errors: { total: number; groups: EngineMessageGroup[] } | null;
  watchdog: WatchdogState | null;
  errorLog: string;
}

export function sessionDiagnostics(pid: number): SessionDiagnostics {
  const rgl = readText(gameLogFile("rgl", pid), 2 * 1024 * 1024);
  const errors = readText(gameLogFile("errors", pid));
  const wd = readText(gameLogFile("watchdog", pid));
  return {
    pid,
    modules: rgl ? parseLaunchModules(rgl) : null,
    errors: errors ? parseErrorLog(errors) : null,
    watchdog: wd ? parseWatchdogLog(wd) : null,
    errorLog: gameLogFile("errors", pid),
  };
}

/** Engine messages that are easy to misread, with what they mean. */
const KNOWN_MESSAGES: { re: RegExp; hint: string }[] = [
  {
    re: /new_listener_frame\.o\.[xyz]\s*[<>]=?\s*scene_(min|max)_position/i,
    hint: "the audio listener (the editor camera) is outside the scene's bounds — typical when a scene opens with its saved editor camera far away or looking straight down; scene_info checks the saved editor camera, scene_settings editor_camera sets it.",
  },
  { re: /len_sq\s*>=\s*FLT_MIN/i, hint: "a zero-length vector reached the engine: degenerate geometry such as zero-area navigation mesh faces, a zero scale or a zero direction." },
  { re: /Only quads and triangles are supported|Triangulating body/i, hint: "importer note: collision polygons with more than four corners are triangulated automatically; not a failure." },
  {
    re: /No border probes can be found/i,
    hint: "PRT/GI baking needs prt_border_probe entities around the area to bake; without them it bakes no valid probes, and a 'Done' reply does not mean usable GI data exists (an empty bake saved with gi_data_exists=true has crashed scene loading).",
  },
  { re: /Unable to find material for mesh/i, hint: "meshes without materials: asset_status <module> lists the packages; re-import them after their materials are registered." },
];

/** Hints for known engine messages among `lines` (each hint once). */
export function messageHints(lines: string[]): string[] {
  const out: string[] = [];
  for (const k of KNOWN_MESSAGES) if (lines.some((l) => k.re.test(l))) out.push(k.hint);
  return out;
}

/** Report lines for editor_status. */
export function describeSession(d: SessionDiagnostics, running: boolean, limit = 5): string[] {
  const L: string[] = [];
  if (d.watchdog?.crashes) {
    L.push(`Crash watchdog recorded ${d.watchdog.crashes === 1 ? "a crash" : `${d.watchdog.crashes} crashes`} of this session ("Crash occurred"); a dump is written locally under ProgramData\\Mount and Blade II Bannerlord\\crashes.`);
  }
  if (d.watchdog?.pending && running) {
    L.push(
      `Crash watchdog: collecting a dump for "${d.watchdog.pending}" (request ${d.watchdog.requests}). The game is frozen until it finishes — seconds to minutes per warning, repeated for every warning.`,
    );
  }
  if (d.errors?.total) {
    L.push(`Engine warnings/errors in ${path.basename(d.errorLog)}: ${d.errors.total}`);
    for (const g of d.errors.groups.slice(-limit)) {
      L.push(`  - ${g.key}${g.count > 1 ? ` ×${g.count}` : ""}${g.items.length > 1 ? `: ${g.items.slice(0, 8).join(", ")}${g.items.length > 8 ? ", …" : ""}` : ""}${g.lastTime ? ` (last ${g.lastTime})` : ""}`);
    }
    for (const h of messageHints(d.errors.groups.map((g) => g.key))) L.push(`  Note: ${h}`);
  }
  return L;
}
