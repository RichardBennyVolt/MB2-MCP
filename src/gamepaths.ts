import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { decodeUtf8Lenient } from "./util/text.js";

export const STEAM_APP_ID = "261550";
const GAME_FOLDER = "Mount & Blade II Bannerlord";

export interface GameLocation {
  gameDir: string | null;
  detectedBy: string;
  /** steamapps/workshop/content/261550 when the game is a Steam install. */
  workshopDir: string | null;
  candidatesTried: string[];
}

export function isGameDir(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, "Modules", "Native", "SubModule.xml"));
  } catch {
    return false;
  }
}

function regQuery(key: string, value: string): string | null {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync(regExe(), ["query", key, "/v", value], { windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const text = decodeUtf8Lenient(out);
    const m = new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`, "i").exec(text);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function regExe(): string {
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const p = path.join(root, "System32", "reg.exe");
  return fs.existsSync(p) ? p : "reg";
}

/** Parses Steam's libraryfolders.vdf and returns library roots. */
export function steamLibraries(): string[] {
  const roots = new Set<string>();
  const steamDirs: string[] = [];
  const reg1 = regQuery("HKCU\\Software\\Valve\\Steam", "SteamPath");
  if (reg1) steamDirs.push(reg1);
  const reg2 = regQuery("HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath");
  if (reg2) steamDirs.push(reg2);
  if (process.platform === "win32") {
    steamDirs.push("C:\\Program Files (x86)\\Steam", "C:\\Program Files\\Steam");
  } else {
    const home = os.homedir();
    steamDirs.push(path.join(home, ".steam", "steam"), path.join(home, ".local", "share", "Steam"), path.join(home, "Library", "Application Support", "Steam"));
  }
  for (const raw of steamDirs) {
    const dir = path.normalize(raw.replace(/\//g, path.sep));
    if (!fs.existsSync(dir)) continue;
    roots.add(dir);
    for (const vdf of [path.join(dir, "steamapps", "libraryfolders.vdf"), path.join(dir, "config", "libraryfolders.vdf")]) {
      try {
        const text = fs.readFileSync(vdf, "utf8");
        for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) roots.add(path.normalize(m[1].replace(/\\\\/g, "\\")));
        // Old format: "1"  "D:\\SteamLibrary"
        for (const m of text.matchAll(/^\s*"\d+"\s+"([^"]+)"\s*$/gm)) roots.add(path.normalize(m[1].replace(/\\\\/g, "\\")));
      } catch {
        /* missing vdf */
      }
    }
  }
  return [...roots];
}

function epicLocations(): string[] {
  const out: string[] = [];
  const programData = process.env.ProgramData || process.env.PROGRAMDATA || "C:\\ProgramData";
  const dir = path.join(programData, "Epic", "EpicGamesLauncher", "Data", "Manifests");
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".item")) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (/bannerlord/i.test(String(j.DisplayName ?? "")) && j.InstallLocation) out.push(String(j.InstallLocation));
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no Epic */
  }
  return out;
}

function driveCandidates(): string[] {
  if (process.platform !== "win32") return [];
  const out: string[] = [];
  for (let c = 67; c <= 90; c++) {
    const d = `${String.fromCharCode(c)}:\\`;
    if (!fs.existsSync(d)) continue;
    out.push(
      path.join(d, "SteamLibrary", "steamapps", "common", GAME_FOLDER),
      path.join(d, "Steam", "steamapps", "common", GAME_FOLDER),
      path.join(d, "Program Files (x86)", "Steam", "steamapps", "common", GAME_FOLDER),
      path.join(d, "Games", "SteamLibrary", "steamapps", "common", GAME_FOLDER),
      path.join(d, "XboxGames", "Mount & Blade II- Bannerlord", "Content"),
      path.join(d, "GOG Games", GAME_FOLDER),
      path.join(d, "Program Files (x86)", "GOG Galaxy", "Games", GAME_FOLDER),
      path.join(d, "Program Files", "Epic Games", "MountAndBlade2"),
    );
  }
  return out;
}

/** Derives the Steam workshop content folder from a game dir like <lib>/steamapps/common/<game>. */
export function workshopDirFor(gameDir: string): string | null {
  const common = path.dirname(gameDir);
  const steamapps = path.dirname(common);
  if (path.basename(common).toLowerCase() !== "common" || path.basename(steamapps).toLowerCase() !== "steamapps") return null;
  const ws = path.join(steamapps, "workshop", "content", STEAM_APP_ID);
  if (!fs.existsSync(ws)) return null;
  try {
    return fs.realpathSync.native(ws);
  } catch {
    return ws;
  }
}

export function detectGame(explicit?: string | null): GameLocation {
  const tried: string[] = [];
  const finish = (dir: string, by: string): GameLocation => {
    let real = dir;
    try {
      real = fs.realpathSync.native(dir); // restores the on-disk casing (Steam stores lowercase paths)
    } catch {
      /* keep */
    }
    return { gameDir: real, detectedBy: by, workshopDir: workshopDirFor(real), candidatesTried: tried };
  };
  if (explicit) {
    const dir = path.resolve(explicit);
    tried.push(dir);
    if (isGameDir(dir)) return finish(dir, "configured");
    return { gameDir: null, detectedBy: `configured path is not a Bannerlord install (no Modules/Native/SubModule.xml): ${dir}`, workshopDir: null, candidatesTried: tried };
  }
  for (const lib of steamLibraries()) {
    const dir = path.join(lib, "steamapps", "common", GAME_FOLDER);
    tried.push(dir);
    if (isGameDir(dir)) return finish(dir, "steam");
  }
  for (const dir of epicLocations()) {
    tried.push(dir);
    if (isGameDir(dir)) return finish(dir, "epic");
  }
  for (const dir of driveCandidates()) {
    tried.push(dir);
    if (isGameDir(dir)) return finish(dir, "common-path");
  }
  return { gameDir: null, detectedBy: "not found", workshopDir: null, candidatesTried: tried };
}

/** %ProgramData%/Mount and Blade II Bannerlord (logs, crash lists). */
export function programDataDir(): string {
  const pd = process.env.ProgramData || process.env.PROGRAMDATA || "C:\\ProgramData";
  return path.join(pd, "Mount and Blade II Bannerlord");
}

let docsCache: string | null | undefined;
/** The user's Documents folder (respects OneDrive / relocated Documents on Windows). */
export function documentsDir(): string {
  if (docsCache) return docsCache;
  let docs: string | null = null;
  if (process.platform === "win32") {
    const v = regQuery("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders", "Personal");
    if (v && fs.existsSync(v)) docs = v;
  }
  docsCache = docs ?? path.join(os.homedir(), "Documents");
  return docsCache;
}

/** Documents/Mount and Blade II Bannerlord (configs, LauncherData.xml, saves). */
export function userGameDocsDir(): string {
  return path.join(documentsDir(), "Mount and Blade II Bannerlord");
}
