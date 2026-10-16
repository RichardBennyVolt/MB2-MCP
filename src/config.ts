import os from "node:os";
import path from "node:path";

export interface Config {
  /** Explicit game directory (env MB2_GAME_DIR / --game-dir); null = auto-detect. */
  gameDirOverride: string | null;
  /** Extra directories that contain module folders (your dev workspace). Modules there are writable. */
  extraModuleDirs: string[];
  /** Index Steam Workshop modules (read-only). */
  includeWorkshop: boolean;
  /** Refuse every write. */
  readOnly: boolean;
  /** Where edit history / backups are stored. */
  dataDir: string;
  /** Hard cap for a single tool result (characters). */
  maxOutputChars: number;
  /** Optional override of the Windows PowerShell executable used for XSD/XSLT. */
  powershell: string | null;
  /** Tool groups to expose (MB2_TOOLSETS); empty = all. */
  toolsets: string[];
  /** Replace the user's home folder, user name and computer name in tool output (MB2_REDACT, default on). */
  redact: boolean;
}

function envFirst(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

function truthy(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function splitDirs(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(/[;\n]|\|/)
    .map((s) => s.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
    .map((s) => path.resolve(s));
}

function defaultDataDir(): string {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "mb2-mcp");
  }
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(state, "mb2-mcp");
}

/** Parses `--key value` / `--key=value` options. Unknown options are ignored. */
export function parseArgs(argv: string[]): { positional: string[]; opts: Record<string, string | true> } {
  const positional: string[] = [];
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--") && !["readonly", "no-workshop", "no-redact", "help"].includes(a.slice(2))) opts[a.slice(2)] = argv[++i];
      else opts[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { positional, opts };
}

export function loadConfig(opts: Record<string, string | true> = {}): Config {
  const str = (k: string): string | undefined => (typeof opts[k] === "string" ? (opts[k] as string) : undefined);
  const gameDir = str("game-dir") ?? envFirst("MB2_GAME_DIR", "BANNERLORD_GAME_DIR", "BANNERLORD_DIR");
  const maxOut = parseInt(str("max-output") ?? envFirst("MB2_MAX_OUTPUT") ?? "", 10);
  return {
    gameDirOverride: gameDir ? path.resolve(gameDir) : null,
    extraModuleDirs: [...splitDirs(str("module-dirs")), ...splitDirs(envFirst("MB2_MODULE_DIRS"))],
    includeWorkshop: opts["no-workshop"] === true ? false : truthy(envFirst("MB2_WORKSHOP"), true),
    readOnly: opts["readonly"] === true || truthy(envFirst("MB2_READONLY"), false),
    dataDir: path.resolve(str("data-dir") ?? envFirst("MB2_DATA_DIR") ?? defaultDataDir()),
    maxOutputChars: Number.isFinite(maxOut) && maxOut > 2000 ? maxOut : 40000,
    powershell: str("powershell") ?? envFirst("MB2_POWERSHELL") ?? null,
    toolsets: (str("toolsets") ?? envFirst("MB2_TOOLSETS") ?? "")
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    redact: opts["no-redact"] === true ? false : truthy(envFirst("MB2_REDACT"), true),
  };
}
