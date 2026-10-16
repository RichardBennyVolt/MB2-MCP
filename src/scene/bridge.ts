import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import type { Ctx } from "../context.js";
import { userGameDocsDir } from "../gamepaths.js";
import type { ModuleInfo } from "../model/modules.js";
import { decodeUtf8Lenient, encodeText } from "../util/text.js";
import type { Transaction } from "../ops/history.js";
import { BRIDGE_CS, BRIDGE_VERSION } from "./bridge-cs.js";

export const BRIDGE_MODULE_ID = "MB2MCP.EditorBridge";

export function bridgeDir(): string {
  return path.join(userGameDocsDir(), "MB2MCP");
}

export interface BridgeStatusFile {
  port: number;
  token: string;
  pid: number;
  bridge: string;
  started: string;
}

export class BridgeUnavailable extends Error {}

export function readBridgeStatus(): BridgeStatusFile | null {
  try {
    const raw = fs.readFileSync(path.join(bridgeDir(), "bridge.json"), "utf8").replace(/^\ufeff/, "");
    const j = JSON.parse(raw) as BridgeStatusFile;
    return j && j.port && j.token ? j : null;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

let reqCounter = 0;

/** Sends one command to the editor bridge and waits for the JSON reply. */
export function bridgeCall<T = unknown>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
  const st = readBridgeStatus();
  if (!st) {
    return Promise.reject(
      new BridgeUnavailable(
        "The editor bridge is not running. Install it (editor_bridge_install), then start the Modding Kit editor with the 'MB2-MCP Editor Bridge' module enabled (editor_launch does both).",
      ),
    );
  }
  if (!pidAlive(st.pid)) return Promise.reject(new BridgeUnavailable(`The editor process ${st.pid} that started the bridge has exited. Start the editor again (editor_launch).`));
  return new Promise<T>((resolve, reject) => {
    const id = ++reqCounter;
    const sock = net.connect({ host: "127.0.0.1", port: st.port });
    let buf = "";
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`The editor did not answer '${cmd}' within ${timeoutMs} ms. It may be busy or blocked by a message box — editor_status lists open game dialogs.`))),
      timeoutMs + 2000,
    );
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ id, token: st.token, cmd, args: { ...args, timeoutMs } }) + "\n"));
    sock.on("data", (d: string) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      finish(() => {
        try {
          const msg = JSON.parse(line) as { ok: boolean; result?: T; error?: string };
          if (msg.ok) resolve(msg.result as T);
          else reject(new Error(msg.error ?? "bridge error"));
        } catch (e) {
          reject(e);
        }
      });
    });
    sock.on("error", (e) => finish(() => reject(new BridgeUnavailable(`Cannot reach the editor bridge on 127.0.0.1:${st.port} (${e.message}). Is the editor still running?`))));
  });
}

// ---- processes ------------------------------------------------------------------------------------

export interface GameProcess {
  name: string;
  pid: number;
  memMb: number;
}

// Bannerlord itself, its launchers, and the crash watchdog / crash uploader it starts.
const GAME_EXES = ["bannerlord.exe", "bannerlord.native.exe", "taleworlds.mountandblade.launcher.exe", "launcher.native.exe", "watchdog.exe", "crashuploader.publish.exe", "twcrashuploader.exe"];

export function gameProcesses(): GameProcess[] {
  if (process.platform !== "win32") return [];
  try {
    const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    const exe = path.join(root, "System32", "tasklist.exe");
    const out = decodeUtf8Lenient(execFileSync(fs.existsSync(exe) ? exe : "tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true, timeout: 8000, stdio: ["ignore", "pipe", "ignore"] }));
    const procs: GameProcess[] = [];
    for (const line of out.split(/\r?\n/)) {
      const m = /^"([^"]+)","(\d+)","[^"]*","[^"]*","([^"]*)"/.exec(line);
      if (!m || !GAME_EXES.includes(m[1].toLowerCase())) continue;
      procs.push({ name: m[1], pid: parseInt(m[2], 10), memMb: Math.round(parseInt(m[3].replace(/[^\d]/g, ""), 10) / 1024) || 0 });
    }
    return procs;
  } catch {
    return [];
  }
}

// ---- Modding Kit / editor -----------------------------------------------------------------------

export function editorBinDir(gameDir: string): string {
  return path.join(gameDir, "bin", "Win64_Shipping_wEditor");
}

/** True when <game>/Modules contains `dir` itself or a junction/symlink to it (the game loads nothing else). */
export function linkedIntoGame(gameDir: string, dir: string): boolean {
  const modules = path.join(gameDir, "Modules");
  const real = (p: string): string | null => {
    try {
      return fs.realpathSync.native(p).toLowerCase();
    } catch {
      return null;
    }
  };
  const target = real(dir);
  const root = real(modules);
  if (!target || !root) return false;
  if (target.startsWith(root + path.sep)) return true;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(modules, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => real(path.join(modules, e.name)) === target);
}

export function editorExe(gameDir: string): string | null {
  const p = path.join(editorBinDir(gameDir), "Bannerlord.exe");
  return fs.existsSync(p) ? p : null;
}

export function findCsc(): string | null {
  if (process.platform !== "win32") return null;
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  for (const fw of ["Framework64", "Framework"]) {
    const p = path.join(root, "Microsoft.NET", fw, "v4.0.30319", "csc.exe");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export interface BridgeInstallState {
  dir: string;
  installed: boolean;
  version: string | null;
  dllEditor: boolean;
  dllClient: boolean;
}

export function bridgeInstallState(gameDir: string): BridgeInstallState {
  const dir = path.join(gameDir, "Modules", BRIDGE_MODULE_ID);
  let version: string | null = null;
  try {
    version = fs.readFileSync(path.join(dir, "bridge-version.txt"), "utf8").trim();
  } catch {
    /* not installed */
  }
  return {
    dir,
    installed: fs.existsSync(path.join(dir, "SubModule.xml")),
    version,
    dllEditor: fs.existsSync(path.join(dir, "bin", "Win64_Shipping_wEditor", `${BRIDGE_MODULE_ID}.dll`)),
    dllClient: fs.existsSync(path.join(dir, "bin", "Win64_Shipping_Client", `${BRIDGE_MODULE_ID}.dll`)),
  };
}

function bridgeSubModuleXml(nativeVersion: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<Module>",
    '\t<Name value="MB2-MCP Editor Bridge" />',
    `\t<Id value="${BRIDGE_MODULE_ID}" />`,
    `\t<Version value="v${BRIDGE_VERSION}" />`,
    '\t<DefaultModule value="false" />',
    '\t<ModuleCategory value="Singleplayer" />',
    '\t<ModuleType value="Community" />',
    "\t<DependedModules>",
    `\t\t<DependedModule Id="Native" DependentVersion="${nativeVersion || "v1.0.0"}" Optional="false" />`,
    "\t</DependedModules>",
    "\t<SubModules>",
    "\t\t<SubModule>",
    `\t\t\t<Name value="${BRIDGE_MODULE_ID}" />`,
    `\t\t\t<DLLName value="${BRIDGE_MODULE_ID}.dll" />`,
    `\t\t\t<SubModuleClassType value="${BRIDGE_MODULE_ID}.SubModule" />`,
    "\t\t\t<Tags>",
    '\t\t\t\t<Tag key="DedicatedServerType" value="none" />',
    '\t\t\t\t<Tag key="IsNoRenderModeElement" value="false" />',
    "\t\t\t</Tags>",
    "\t\t</SubModule>",
    "\t</SubModules>",
    "\t<Xmls />",
    "</Module>",
    "",
  ].join("\r\n");
}

const BRIDGE_README = [
  "MB2-MCP Editor Bridge",
  "=====================",
  "Generated and compiled on this machine by the mb2-mcp MCP server (editor_bridge_install).",
  "",
  "Only active in the Modding Kit build (bin\\Win64_Shipping_wEditor). It listens on 127.0.0.1 with a",
  "random token written to Documents\\Mount and Blade II Bannerlord\\MB2MCP\\bridge.json so an AI",
  "assistant can inspect and edit the scene that is open in the editor. In the normal game it does nothing.",
  "",
  "Remove: delete this folder (or run undo_edit on the install entry).",
  "",
].join("\r\n");

export async function runCsc(csc: string, rsp: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(csc, [`@${rsp}`], { windowsHide: true, timeout: 180000, encoding: "buffer", maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = decodeUtf8Lenient(Buffer.concat([Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0), Buffer.isBuffer(stderr) ? stderr : Buffer.alloc(0)])).trim();
      resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code as unknown as number) || 1 : 0, output });
    });
  });
}

/** Compiles the bridge against the installed editor assemblies and writes the module (inside `tx`). */
export async function installBridge(ctx: Ctx, tx: Transaction): Promise<{ dir: string; lines: string[] }> {
  const gameDir = ctx.registry.gameDir;
  if (!gameDir) throw new Error("Game folder not detected; set MB2_GAME_DIR.");
  const bin = editorBinDir(gameDir);
  if (!fs.existsSync(path.join(bin, "TaleWorlds.MountAndBlade.dll"))) {
    throw new Error(`The Modding Kit is not installed (${bin} missing). Install "Mount & Blade II: Bannerlord - Modding Kit" from Steam (Library → Tools).`);
  }
  const csc = findCsc();
  if (!csc) throw new Error("The .NET Framework C# compiler (csc.exe) was not found; it ships with Windows (.NET Framework 4.x).");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mb2mcp-bridge-"));
  try {
    const src = path.join(work, "Bridge.cs");
    const out = path.join(work, `${BRIDGE_MODULE_ID}.dll`);
    fs.writeFileSync(src, BRIDGE_CS, "utf8");
    const refs: string[] = [];
    for (const f of fs.readdirSync(bin)) {
      if (/^TaleWorlds\..*\.dll$/i.test(f) && f.toLowerCase() !== "taleworlds.native.dll") refs.push(path.join(bin, f));
    }
    const fwDir = path.dirname(csc);
    const lines = ["/nologo", "/target:library", "/platform:x64", "/optimize+", `/out:"${out}"`];
    for (const r of refs) lines.push(`/reference:"${r}"`);
    for (const r of ["System.Web.Extensions.dll", "System.Numerics.dll", "netstandard.dll"]) {
      if (fs.existsSync(path.join(fwDir, r))) lines.push(`/reference:"${path.join(fwDir, r)}"`);
    }
    lines.push(`"${src}"`);
    const rsp = path.join(work, "build.rsp");
    fs.writeFileSync(rsp, lines.join("\r\n"), "utf8");
    const res = await runCsc(csc, rsp);
    if (res.code !== 0 || !fs.existsSync(out)) {
      throw new Error(`Compiling the bridge against your game version failed:\n${res.output.split(/\r?\n/).slice(0, 30).join("\n")}`);
    }
    const dll = fs.readFileSync(out);
    const dir = path.join(gameDir, "Modules", BRIDGE_MODULE_ID);
    ctx.history.allowRoot(dir);
    tx.write(path.join(dir, "SubModule.xml"), encodeText(bridgeSubModuleXml(ctx.registry.gameVersion()), "utf8"));
    tx.write(path.join(dir, "bin", "Win64_Shipping_wEditor", `${BRIDGE_MODULE_ID}.dll`), dll);
    // Same DLL for the normal client so enabling the module there never fails; it stays idle outside the editor.
    tx.write(path.join(dir, "bin", "Win64_Shipping_Client", `${BRIDGE_MODULE_ID}.dll`), dll);
    tx.write(path.join(dir, "bridge-version.txt"), encodeText(BRIDGE_VERSION, "utf8"));
    tx.write(path.join(dir, "README.txt"), encodeText(BRIDGE_README, "utf8"));
    return {
      dir,
      lines: [
        `Compiled MB2MCP.EditorBridge ${BRIDGE_VERSION} against ${refs.length} assemblies of ${path.relative(gameDir, bin)} (${(dll.length / 1024).toFixed(0)} KB).`,
        `Installed module: ${dir}`,
      ],
    };
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export interface LaunchResult {
  pid: number | undefined;
  exe: string;
  args: string[];
  modules: string[];
}

/** Starts the Modding Kit build directly (no launcher) with the given module list. */
export function launchEditor(ctx: Ctx, modules: ModuleInfo[], openEditor: boolean): LaunchResult {
  const gameDir = ctx.registry.gameDir;
  if (!gameDir) throw new Error("Game folder not detected; set MB2_GAME_DIR.");
  const exe = editorExe(gameDir);
  if (!exe) throw new Error("The Modding Kit (bin\\Win64_Shipping_wEditor\\Bannerlord.exe) is not installed. Install it from Steam → Library → Tools.");
  const ids = modules.map((m) => m.id);
  const args = ["/singleplayer", `_MODULES_*${ids.join("*")}*_MODULES_`];
  if (openEditor) {
    fs.mkdirSync(bridgeDir(), { recursive: true });
    fs.writeFileSync(path.join(bridgeDir(), "autostart.json"), JSON.stringify({ enterEditor: true, requested: new Date().toISOString() }), "utf8");
  }
  const child = spawn(exe, args, { cwd: path.dirname(exe), detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  return { pid: child.pid, exe, args, modules: ids };
}
