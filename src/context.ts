import path from "node:path";
import type { Config } from "./config.js";
import { DotnetBridge } from "./dotnet.js";
import { ModuleRegistry, type ModuleInfo } from "./model/modules.js";
import { ObjectIndex } from "./model/objects.js";
import { History } from "./ops/history.js";
import { SchemaStore } from "./ops/schema.js";
import { PrefabIndex } from "./scene/prefabs.js";
import { AssetCatalog } from "./scene/tpac.js";

/** Shared state of one server process. */
export class Ctx {
  readonly registry: ModuleRegistry;
  readonly index: ObjectIndex;
  readonly dotnet: DotnetBridge;
  readonly history: History;
  readonly schemas: SchemaStore;
  readonly prefabs: PrefabIndex;
  readonly assets: AssetCatalog;

  constructor(readonly config: Config) {
    this.registry = new ModuleRegistry(config);
    this.index = new ObjectIndex(this.registry);
    this.dotnet = new DotnetBridge(config.dataDir, config.powershell);
    this.history = new History(config.dataDir, config.readOnly);
    this.schemas = new SchemaStore(() => this.registry.gameDir);
    this.prefabs = new PrefabIndex();
    this.assets = new AssetCatalog();
  }

  /** Called before every tool call. */
  prepare(): void {
    this.registry.ensureFresh();
    this.history.setWriteRoots(this.registry.modules.filter((m) => m.writable).map((m) => m.dir));
  }

  /** Indexes everything (cheap after the first call). */
  indexAll(): void {
    this.index.ensure(this.registry.modules);
  }

  /** Re-reads modules and re-indexes `moduleId` after we changed it. */
  afterWrite(moduleId?: string): void {
    this.registry.refresh();
    if (moduleId) this.index.touch(moduleId);
    this.history.setWriteRoots(this.registry.modules.filter((m) => m.writable).map((m) => m.dir));
  }

  /** Modules referenced by a filter like "Native,SandBoxCore", "official", "mods", "workshop". */
  selectModules(filter?: string): ModuleInfo[] {
    const all = this.registry.modules;
    if (!filter || !filter.trim() || filter.trim().toLowerCase() === "all") return all;
    const out = new Map<string, ModuleInfo>();
    for (const part of filter.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
      const p = part.toLowerCase();
      if (p === "official" || p === "vanilla") all.filter((m) => m.official).forEach((m) => out.set(m.id, m));
      else if (p === "mods" || p === "community") all.filter((m) => !m.official).forEach((m) => out.set(m.id, m));
      else if (p === "writable" || p === "mine") all.filter((m) => m.writable).forEach((m) => out.set(m.id, m));
      else if (p === "workshop") all.filter((m) => m.source === "workshop").forEach((m) => out.set(m.id, m));
      else {
        const m = this.registry.require(part);
        out.set(m.id, m);
      }
    }
    return [...out.values()];
  }

  relToGame(abs: string): string {
    const g = this.registry.gameDir;
    if (g && abs.toLowerCase().startsWith(g.toLowerCase())) return path.relative(g, abs).split(path.sep).join("/");
    return abs;
  }
}
