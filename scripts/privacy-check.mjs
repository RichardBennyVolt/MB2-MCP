#!/usr/bin/env node
// npm run privacy — fails when a file that would be published contains personal or private data.
//
// Scans the files git would publish (or, without a repository, the files .gitignore keeps) and the files `npm pack`
// would ship, for: this computer's home folder, user name (in paths or after "User:"), computer name, e-mail addresses
// (GitHub noreply addresses are fine), private keys and tokens, and your own private terms — one literal or /regex/flags
// per line in %USERPROFILE%\.mb2-mcp\privacy-terms.txt (or MB2_PRIVACY_TERMS_FILE). That list lives outside the
// repository so it is never published itself. Local-only files that a zip of the whole folder would include are listed
// as warnings.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => path.relative(root, p).split(path.sep).join("/");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---- what would be published -----------------------------------------------------------------------------

function gitFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\0").filter(Boolean);
  } catch {
    return null; // no repository (or no git): fall back to .gitignore below
  }
}

/** Minimal .gitignore matcher: comments, !negation, trailing / for folders, leading / or inner / anchors, * ? **. */
function gitignoreRules() {
  const file = path.join(root, ".gitignore");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const negate = l.startsWith("!");
      let p = negate ? l.slice(1) : l;
      const dirOnly = p.endsWith("/");
      if (dirOnly) p = p.slice(0, -1);
      const anchored = p.startsWith("/") || p.includes("/");
      p = p.replace(/^\//, "");
      const glob = p
        .split("**")
        .map((part) => part.split("").map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : esc(c))).join(""))
        .join(".*");
      return { negate, dirOnly, re: new RegExp(anchored ? `^${glob}$` : `(^|/)${glob}$`, "i") };
    });
}

function ignored(relPath, rules) {
  const parts = relPath.split("/");
  let result = false;
  for (const r of rules) {
    // a rule matches the path itself or one of its folders
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join("/");
      const isDir = i < parts.length;
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(sub)) result = !r.negate;
    }
  }
  return result;
}

function treeFiles() {
  const rules = gitignoreRules();
  const out = [];
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const r = rel(p);
      if (e.name === ".git" || ignored(r + (e.isDirectory() ? "/x" : ""), rules) && e.isDirectory()) continue;
      if (e.isDirectory()) visit(p);
      else if (!ignored(r, rules)) out.push(r);
    }
  };
  visit(root);
  return out;
}

function npmFiles() {
  try {
    const out = execSync("npm pack --dry-run --json --ignore-scripts", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(out)[0].files.map((f) => f.path);
  } catch {
    return [];
  }
}

// ---- what counts as private ---------------------------------------------------------------------------------

function user() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? "";
  }
}

function patterns() {
  const home = os.homedir();
  const host = os.hostname();
  const u = user();
  const sep = String.raw`(?:\\\\|[\\/])`;
  const list = [
    ["home folder", new RegExp([home, home.replace(/\\/g, "/"), home.replace(/\\/g, "\\\\")].map(esc).join("|"), "i")],
    ["Windows user folder", /[A-Z]:(?:\\\\|[\\/])+Users(?:\\\\|[\\/])+(?!Public\b|Default\b|<|%|\$|\{)[^\\/\s"'`]+/i],
    ["e-mail address", /[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com\b|example\.(?:com|org)\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
    ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["access token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{30,})\b/],
    ["credentials in a URL", /\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/i],
    ["secret assignment", /\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"'\s]{8,}["']/i],
  ];
  // Before publishing, the user and computer names count anywhere — also bare, e.g. in a comment or as test data.
  // (The runtime redactor is stricter about context; here a false alarm only asks for a look.)
  if (u) list.push(["user name", new RegExp(`(?<![A-Za-z0-9])${esc(u)}(?![A-Za-z0-9])`, "i")]);
  if (host && host.length >= 3) list.push(["computer name", new RegExp(`(?<![A-Za-z0-9])${esc(host)}(?![A-Za-z0-9])`, "i")]);
  const termsFile = process.env.MB2_PRIVACY_TERMS_FILE || path.join(os.homedir(), ".mb2-mcp", "privacy-terms.txt");
  if (fs.existsSync(termsFile)) {
    for (const line of fs.readFileSync(termsFile, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = /^\/(.+)\/([a-z]*)$/.exec(t);
      list.push(["private term", m ? new RegExp(m[1], m[2]) : new RegExp(esc(t), "i")]);
    }
  }
  return { list, termsFile };
}

// ---- scan ---------------------------------------------------------------------------------------------------------

const viaGit = gitFiles();
const published = new Set([...(viaGit ?? treeFiles()), ...npmFiles()]);
const { list, termsFile } = patterns();
const findings = [];
for (const f of [...published].sort()) {
  const abs = path.join(root, f);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) continue; // binary
  const lines = buf.toString("utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [kind, re] of list) if (re.test(line)) findings.push(`${f}:${i + 1}: ${kind}`);
  });
}

// Files that stay local but a zip of the whole folder would carry along.
const rules = gitignoreRules();
const localOnly = [];
const visitLocal = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) visitLocal(p);
    else if (ignored(rel(p), rules)) localOnly.push(rel(p));
  }
};
visitLocal(root);

console.log(`privacy check: ${published.size} file(s) that ${viaGit ? "git" : ".gitignore"} and npm would publish; ${list.length} pattern(s)${fs.existsSync(termsFile) ? "" : ` (no private terms: ${termsFile})`}`);
if (localOnly.length) console.log(`note: local-only file(s) a zip of the whole folder would include (publish with git or npm pack instead): ${localOnly.join(", ")}`);
if (findings.length) {
  console.log(`FAILED — ${findings.length} finding(s) (line contents are not printed):`);
  for (const f of findings) console.log(`  ${f}`);
  process.exit(1);
}
console.log("OK — nothing personal or private found.");
