import os from "node:os";

/**
 * Keeps this computer's identity out of what tools return to the MCP client (and so out of model context and chat
 * logs): the user's home folder becomes %USERPROFILE%, the user name in paths or after "User:" becomes <user>, the
 * computer name becomes <computer>. Placeholders the client sends back are expanded again, so redacted paths still work.
 * Plain numbers and words are never touched (a fictitious user called "67890" does not change an item price of 67890).
 */
export interface Redactor {
  text(s: string): string;
  arg(v: unknown): unknown;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEP = String.raw`(?:\\\\|[\\/])`; // \  /  or the \\ of JSON text

function currentUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? "";
  }
}

export function makeRedactor(enabled: boolean, home = os.homedir(), user = currentUser(), host = os.hostname()): Redactor {
  if (!enabled) return { text: (s) => s, arg: (v) => v };
  const homes = [...new Set([home, home.replace(/\\/g, "/"), home.replace(/\\/g, "\\\\")])].filter((h) => h.length > 3).sort((a, b) => b.length - a.length);
  const homeRe = homes.length ? new RegExp(homes.map(esc).join("|"), "gi") : null;
  const tail = "(?![A-Za-z0-9_.$-])";
  const userInPath = user ? new RegExp(`(${SEP}Users${SEP})${esc(user)}${tail}`, "gi") : null;
  const userLabel = user ? new RegExp(`(\\b(?:User|User ?name|Login)\\s*[:=]\\s*)${esc(user)}${tail}`, "gi") : null;
  const hostLabel = host ? new RegExp(`(\\b(?:Computer|Computer ?name|Machine|Host ?name|Host)\\s*[:=]\\s*)${esc(host)}${tail}`, "gi") : null;
  // A distinctive computer name is replaced anywhere (UNC paths, logs); short ones only after a label.
  const hostAnywhere = host && host.length >= 5 ? new RegExp(`(?<![A-Za-z0-9_-])${esc(host)}${tail}`, "gi") : null;

  const text = (s: string): string => {
    let t = s;
    if (homeRe) t = t.replace(homeRe, "%USERPROFILE%");
    if (userInPath) t = t.replace(userInPath, "$1<user>");
    if (userLabel) t = t.replace(userLabel, "$1<user>");
    if (hostLabel) t = t.replace(hostLabel, "$1<computer>");
    if (hostAnywhere) t = t.replace(hostAnywhere, "<computer>");
    return t;
  };
  const arg = (v: unknown): unknown => {
    if (typeof v === "string") {
      let s = v.replace(/%USERPROFILE%/gi, () => home);
      if (user) s = s.replace(new RegExp(`(${SEP}Users${SEP})<user>(?=${SEP}|$)`, "gi"), (_m, p: string) => `${p}${user}`);
      return s;
    }
    if (Array.isArray(v)) return v.map(arg);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, arg(x)]));
    return v;
  };
  return { text, arg };
}
