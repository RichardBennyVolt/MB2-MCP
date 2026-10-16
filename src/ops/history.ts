import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { writeFileAtomic } from "../util/text.js";

export interface JournalFile {
  path: string;
  /** Blob name of the content before the change (null if the file did not exist or was not backed up). */
  backup: string | null;
  existed: boolean;
  /** Fingerprint after the change (sha1, or size+mtime for huge files); null when the file was deleted. */
  afterHash: string | null;
  /** True when an existing file was overwritten without a backup (huge binary asset). */
  noBackup?: boolean;
}

export interface JournalEntry {
  seq: number;
  time: string;
  tool: string;
  module: string;
  summary: string;
  files: JournalFile[];
  createdDirs: string[];
  undone?: boolean;
}

const HASH_LIMIT = 64 * 1024 * 1024;
const COMPRESS_FROM = 1024 * 1024;

function sha1(data: Buffer): string {
  return crypto.createHash("sha1").update(data).digest("hex");
}

/** Content hash for normal files, size+mtime for huge binaries (hashing 500 MB per edit is wasteful). */
export function fingerprint(file: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (st.size > HASH_LIMIT) return `big:${st.size}:${Math.floor(st.mtimeMs)}`;
  return sha1(fs.readFileSync(file));
}

/** Every write goes through a Transaction so it can be listed and undone (undo_edit). */
export class Transaction {
  private files = new Map<string, JournalFile>();
  private createdDirs: string[] = [];
  private committed = false;

  constructor(
    private readonly history: History,
    readonly tool: string,
    readonly module: string,
    public summary: string,
  ) {}

  private track(abs: string, backup = true): JournalFile {
    const key = abs.toLowerCase();
    let jf = this.files.get(key);
    if (!jf) {
      let blob: string | null = null;
      let existed = false;
      let noBackup = false;
      if (fs.existsSync(abs)) {
        existed = true;
        if (backup) blob = this.history.storeBlob(fs.readFileSync(abs));
        else noBackup = true;
      }
      jf = { path: abs, backup: blob, existed, afterHash: null, ...(noBackup ? { noBackup } : {}) };
      this.files.set(key, jf);
    }
    return jf;
  }

  write(file: string, data: Buffer): void {
    const abs = path.resolve(file);
    this.history.assertWritable(abs);
    const jf = this.track(abs);
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) this.mkdir(dir);
    writeFileAtomic(abs, data);
    jf.afterHash = data.length > HASH_LIMIT ? fingerprint(abs) : sha1(data);
  }

  /** Copies a (possibly huge) file into the module without loading it into memory. */
  copyIn(src: string, dest: string, opts: { backup: boolean }): void {
    const abs = path.resolve(dest);
    this.history.assertWritable(abs);
    const jf = this.track(abs, opts.backup);
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) this.mkdir(dir);
    fs.copyFileSync(src, abs);
    jf.afterHash = fingerprint(abs);
  }

  remove(file: string): void {
    const abs = path.resolve(file);
    this.history.assertWritable(abs);
    if (!fs.existsSync(abs)) return;
    const jf = this.track(abs);
    fs.rmSync(abs, { force: true });
    jf.afterHash = null;
  }

  mkdir(dir: string): void {
    const abs = path.resolve(dir);
    this.history.assertWritable(abs);
    const missing: string[] = [];
    let cur = abs;
    while (!fs.existsSync(cur)) {
      missing.push(cur);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    fs.mkdirSync(abs, { recursive: true });
    this.createdDirs.push(...missing.reverse());
  }

  get changedFiles(): string[] {
    return [...this.files.values()].map((f) => f.path);
  }

  commit(): JournalEntry | null {
    if (this.committed) return null;
    this.committed = true;
    if (this.files.size === 0 && this.createdDirs.length === 0) return null;
    return this.history.append({
      tool: this.tool,
      module: this.module,
      summary: this.summary,
      files: [...this.files.values()],
      createdDirs: this.createdDirs,
    });
  }
}

export class History {
  readonly dir: string;
  private readonly journal: string;
  private readonly blobs: string;
  private writeRoots: string[] = [];

  constructor(
    dataDir: string,
    private readonly readOnly: boolean,
  ) {
    this.dir = path.join(dataDir, "history");
    this.journal = path.join(this.dir, "journal.jsonl");
    this.blobs = path.join(this.dir, "blobs");
  }

  /** Directories the server may write into (writable modules + new module locations). */
  setWriteRoots(roots: string[]): void {
    const extra = this.writeRoots.filter((r) => this.pinned.has(r));
    this.writeRoots = [...new Set([...roots.map((r) => path.resolve(r).toLowerCase()), ...extra])];
  }

  private pinned = new Set<string>();

  allowRoot(root: string): void {
    const r = path.resolve(root).toLowerCase();
    this.pinned.add(r);
    if (!this.writeRoots.includes(r)) this.writeRoots.push(r);
  }

  assertWritable(abs: string): void {
    if (this.readOnly) throw new Error("Read-only mode (MB2_READONLY): writes are disabled.");
    const p = abs.toLowerCase();
    if (!this.writeRoots.some((r) => p === r || p.startsWith(r.endsWith(path.sep) ? r : r + path.sep))) {
      throw new Error(`Refusing to write outside writable module folders: ${abs}`);
    }
  }

  begin(tool: string, module: string, summary: string): Transaction {
    return new Transaction(this, tool, module, summary);
  }

  storeBlob(data: Buffer): string {
    fs.mkdirSync(this.blobs, { recursive: true });
    const hash = sha1(data);
    if (data.length >= COMPRESS_FROM) {
      const name = `${hash}.gz`;
      const p = path.join(this.blobs, name);
      if (!fs.existsSync(p)) fs.writeFileSync(p, zlib.gzipSync(data, { level: 3 }));
      return name;
    }
    const name = `${hash}.bak`;
    const p = path.join(this.blobs, name);
    if (!fs.existsSync(p)) fs.writeFileSync(p, data);
    return name;
  }

  readBlob(name: string): Buffer {
    const raw = fs.readFileSync(path.join(this.blobs, name));
    return name.endsWith(".gz") ? zlib.gunzipSync(raw) : raw;
  }

  private readAll(): JournalEntry[] {
    let text = "";
    try {
      text = fs.readFileSync(this.journal, "utf8");
    } catch {
      return [];
    }
    const entries = new Map<number, JournalEntry>();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as JournalEntry & { type?: string };
        if (rec.type === "undo") {
          const e = entries.get(rec.seq);
          if (e) e.undone = true;
        } else entries.set(rec.seq, rec);
      } catch {
        /* skip corrupt line */
      }
    }
    return [...entries.values()].sort((a, b) => a.seq - b.seq);
  }

  append(e: Omit<JournalEntry, "seq" | "time">): JournalEntry {
    fs.mkdirSync(this.dir, { recursive: true });
    const all = this.readAll();
    const seq = (all.length ? all[all.length - 1].seq : 0) + 1;
    const entry: JournalEntry = { seq, time: new Date().toISOString(), ...e };
    fs.appendFileSync(this.journal, JSON.stringify(entry) + "\n", "utf8");
    if (all.length > 400 || (seq % 25 === 0 && this.blobBytes() > 2 * 1024 * 1024 * 1024)) this.prune(all.concat(entry));
    return entry;
  }

  private blobBytes(): number {
    let total = 0;
    try {
      for (const b of fs.readdirSync(this.blobs)) total += fs.statSync(path.join(this.blobs, b)).size;
    } catch {
      /* none */
    }
    return total;
  }

  /**
   * Forgets edits (and deletes their backups): all of them, or those older than `days` days. They can no longer be
   * undone. Returns how many entries went and how many bytes of backups were freed.
   */
  forget(days?: number): { removed: number; kept: number; freedBytes: number } {
    const all = this.readAll();
    const cutoff = days === undefined ? Infinity : Date.now() - days * 24 * 3600 * 1000;
    const keep = all.filter((e) => Date.parse(e.time) >= cutoff);
    const before = this.blobBytes();
    if (keep.length === all.length) return { removed: 0, kept: keep.length, freedBytes: 0 };
    this.rewrite(keep);
    return { removed: all.length - keep.length, kept: keep.length, freedBytes: Math.max(0, before - this.blobBytes()) };
  }

  private prune(all: JournalEntry[]): void {
    let keep = all.slice(-300);
    // Keep the backups below ~2 GB by dropping the oldest entries.
    const sizes = new Map<string, number>();
    const sizeOf = (b: string): number => {
      if (!sizes.has(b)) {
        try {
          sizes.set(b, fs.statSync(path.join(this.blobs, b)).size);
        } catch {
          sizes.set(b, 0);
        }
      }
      return sizes.get(b)!;
    };
    const total = (list: JournalEntry[]): number => {
      const set = new Set(list.flatMap((e) => e.files.map((f) => f.backup).filter(Boolean) as string[]));
      let t = 0;
      for (const b of set) t += sizeOf(b);
      return t;
    };
    while (keep.length > 20 && total(keep) > 2 * 1024 * 1024 * 1024) keep = keep.slice(10);
    this.rewrite(keep);
  }

  /** Rewrites the journal with `keep` and deletes backups no kept entry needs. */
  private rewrite(keep: JournalEntry[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const lines = keep.map((e) => JSON.stringify(e));
    for (const e of keep) if (e.undone) lines.push(JSON.stringify({ type: "undo", seq: e.seq }));
    fs.writeFileSync(this.journal, lines.length ? lines.join("\n") + "\n" : "", "utf8");
    const used = new Set(keep.flatMap((e) => e.files.map((f) => f.backup).filter(Boolean) as string[]));
    try {
      for (const b of fs.readdirSync(this.blobs)) if (!used.has(b)) fs.rmSync(path.join(this.blobs, b), { force: true });
    } catch {
      /* ignore */
    }
  }

  entries(limit = 20, module?: string): JournalEntry[] {
    let all = this.readAll();
    if (module) all = all.filter((e) => e.module.toLowerCase() === module.toLowerCase());
    return all.slice(-limit).reverse();
  }

  /** Restores the files of one entry (default: the latest not yet undone). */
  undo(seq?: number, force = false, module?: string): { entry: JournalEntry; restored: string[]; deleted: string[]; skipped: string[] } {
    if (this.readOnly) throw new Error("Read-only mode (MB2_READONLY): undo is disabled.");
    const all = this.readAll();
    const candidates = all.filter((e) => !e.undone && (!module || e.module.toLowerCase() === module.toLowerCase()));
    const entry = seq !== undefined ? all.find((e) => e.seq === seq) : candidates[candidates.length - 1];
    if (!entry) throw new Error(seq !== undefined ? `No history entry #${seq}.` : "Nothing to undo.");
    if (entry.undone) throw new Error(`Entry #${entry.seq} was already undone.`);
    const conflicts: string[] = [];
    const unrecoverable: string[] = [];
    for (const f of entry.files) {
      if (fingerprint(f.path) !== f.afterHash) conflicts.push(f.path);
      if (f.noBackup) unrecoverable.push(f.path);
    }
    if ((conflicts.length || unrecoverable.length) && !force) {
      const parts: string[] = [];
      if (conflicts.length) parts.push(`Files changed after edit #${entry.seq}; undo would discard those changes:\n${conflicts.join("\n")}`);
      if (unrecoverable.length) parts.push(`These files were overwritten without a backup (too large) and cannot be restored:\n${unrecoverable.join("\n")}`);
      throw new Error(`${parts.join("\n")}\nUndo newer edits first, or pass force=true.`);
    }
    const restored: string[] = [];
    const deleted: string[] = [];
    const skipped: string[] = [];
    for (const f of entry.files) {
      if (f.existed && f.backup) {
        writeFileAtomic(f.path, this.readBlob(f.backup));
        restored.push(f.path);
      } else if (f.existed && f.noBackup) {
        skipped.push(f.path);
      } else if (!f.existed && fs.existsSync(f.path)) {
        fs.rmSync(f.path, { force: true });
        deleted.push(f.path);
      }
    }
    for (const d of [...entry.createdDirs].reverse()) {
      try {
        if (fs.existsSync(d) && fs.readdirSync(d).length === 0) fs.rmdirSync(d);
      } catch {
        /* keep non-empty dirs */
      }
    }
    fs.appendFileSync(this.journal, JSON.stringify({ type: "undo", seq: entry.seq }) + "\n", "utf8");
    return { entry, restored, deleted, skipped };
  }
}
