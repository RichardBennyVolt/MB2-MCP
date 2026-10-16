import { SaxesParser } from "saxes";
import type { XmlIssue } from "./scanner.js";

/**
 * Strict well-formedness check (the game uses System.Xml, which rejects anything that is
 * not well-formed XML 1.0). Returns at most `maxErrors` issues with 1-based line/column.
 */
export function checkWellFormed(text: string, maxErrors = 20): XmlIssue[] {
  // Raw '&' is the most common mistake; saxes reports it as confusing follow-up errors, so catch it first.
  const amp = unescapedAmpersands(text, maxErrors);
  if (amp.length) return amp;
  const issues: XmlIssue[] = [];
  const parser = new SaxesParser({ xmlns: false, position: true });
  const STOP = new Error("stop");
  parser.on("error", (e: Error) => {
    const message = e.message.replace(/^[^:]*:\d+:\d+:\s*/, "").replace(/^\d+:\d+:\s*/, "");
    issues.push({ message, line: parser.line, col: parser.column + 1, offset: parser.position });
    if (issues.length >= maxErrors) throw STOP;
  });
  try {
    parser.write(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).close();
  } catch (e) {
    if (e !== STOP) {
      issues.push({ message: e instanceof Error ? e.message : String(e), line: parser.line, col: parser.column + 1, offset: parser.position });
    }
  }
  return issues;
}

function unescapedAmpersands(text: string, max: number): XmlIssue[] {
  if (text.indexOf("&") === -1) return [];
  const skip: Array<[number, number]> = [];
  for (const m of text.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g)) skip.push([m.index!, m.index! + m[0].length]);
  const out: XmlIssue[] = [];
  for (const m of text.matchAll(/&(?!(?:[A-Za-z_][\w.-]*|#[0-9]+|#x[0-9A-Fa-f]+);)/g)) {
    const at = m.index!;
    if (skip.some(([a, b]) => at >= a && at < b)) continue;
    const before = text.slice(0, at);
    const line = before.split("\n").length;
    const col = at - before.lastIndexOf("\n");
    out.push({ message: "Unescaped '&' — write it as &amp; (XML requires escaping & as &amp;, < as &lt;)", line, col, offset: at });
    if (out.length >= max) break;
  }
  return out;
}

export function formatIssues(issues: XmlIssue[], prefix = ""): string {
  return issues.map((i) => `${prefix}line ${i.line}:${i.col} ${i.message}`).join("\n");
}
