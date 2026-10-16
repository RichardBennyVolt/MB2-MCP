import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

/** Encodings we can round-trip. Bannerlord ships UTF-8 (with and without BOM) and UTF-16 LE files. */
export type TextEncodingKind = "utf8" | "utf8bom" | "utf16le" | "utf16be";

export interface TextFile {
  /** Decoded text without BOM. */
  text: string;
  encoding: TextEncodingKind;
  eol: "\r\n" | "\n";
}

let gbDecoder: TextDecoder | null | undefined;
function decodeLegacy(buf: Buffer): string {
  if (gbDecoder === undefined) {
    try {
      gbDecoder = new TextDecoder("gb18030");
    } catch {
      gbDecoder = null;
    }
  }
  return gbDecoder ? gbDecoder.decode(buf) : buf.toString("latin1");
}

const utf8Fatal = new TextDecoder("utf-8", { fatal: true });

/** Decodes UTF-8, falling back to GB18030 (common for Chinese Windows logs) and finally latin1. */
export function decodeUtf8Lenient(buf: Buffer): string {
  try {
    return utf8Fatal.decode(buf);
  } catch {
    return decodeLegacy(buf);
  }
}

export function decodeBuffer(buf: Buffer): { text: string; encoding: TextEncodingKind } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: decodeUtf8Lenient(buf.subarray(3)), encoding: "utf8bom" };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.toString("utf16le", 2), encoding: "utf16le" };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    body.swap16();
    return { text: body.toString("utf16le"), encoding: "utf16be" };
  }
  // UTF-16 without BOM ("<" followed by a NUL byte).
  if (buf.length >= 4 && buf[0] === 0x3c && buf[1] === 0x00) {
    return { text: buf.toString("utf16le"), encoding: "utf16le" };
  }
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x3c) {
    const body = Buffer.from(buf.subarray(0, buf.length & ~1));
    body.swap16();
    return { text: body.toString("utf16le"), encoding: "utf16be" };
  }
  return { text: decodeUtf8Lenient(buf), encoding: "utf8" };
}

export function encodeText(text: string, encoding: TextEncodingKind): Buffer {
  switch (encoding) {
    case "utf8":
      return Buffer.from(text, "utf8");
    case "utf8bom":
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
    case "utf16le":
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    case "utf16be": {
      const body = Buffer.from(text, "utf16le");
      body.swap16();
      return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
    }
  }
}

export function detectEol(text: string): "\r\n" | "\n" {
  const i = text.indexOf("\n");
  return i > 0 && text.charCodeAt(i - 1) === 13 ? "\r\n" : "\n";
}

export function readTextFile(file: string): TextFile {
  const buf = fs.readFileSync(file);
  const { text, encoding } = decodeBuffer(buf);
  return { text, encoding, eol: detectEol(text) };
}

/** Converts all line endings in `text` to `eol`. */
export function normalizeEol(text: string, eol: "\r\n" | "\n"): string {
  const lf = text.replace(/\r\n?/g, "\n");
  return eol === "\n" ? lf : lf.replace(/\n/g, "\r\n");
}

/**
 * Writes atomically (temp file + rename) when possible so a crash never leaves a half-written XML.
 * Falls back to a direct write when the rename is blocked (e.g. file opened by another program).
 */
export function writeFileAtomic(file: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.mb2tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    fs.writeFileSync(file, data);
    void err;
  }
}

/** Fixes the encoding="" pseudo-attribute of the XML declaration so it matches the bytes we write. */
export function fixXmlDeclarationEncoding(text: string, encoding: TextEncodingKind): string {
  const want = encoding === "utf16le" || encoding === "utf16be" ? "utf-16" : "utf-8";
  return text.replace(/^(\s*<\?xml[^>]*?\bencoding\s*=\s*)(["'])([^"']*)\2/, (m, pre: string, q: string, cur: string) => {
    const isUtf16 = /^utf-?16/i.test(cur);
    const wantUtf16 = want === "utf-16";
    return isUtf16 === wantUtf16 ? m : `${pre}${q}${want}${q}`;
  });
}

export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = Math.max(10, Math.floor((max - 30) / 2));
  return `${s.slice(0, keep)} …[${s.length - 2 * keep} chars omitted]… ${s.slice(-keep)}`;
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}
