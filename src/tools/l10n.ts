import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "../context.js";
import type { ModuleInfo } from "../model/modules.js";
import {
  collectModuleStrings,
  fixDataFileIds,
  generateStringId,
  knownLanguages,
  languageMap,
  loadModuleLanguage,
  placeholderMismatch,
  resolveLanguage,
  setTranslations,
  summarize,
  takenStringIds,
  type L10nSummary,
  type LanguageDef,
} from "../ops/l10n.js";
import { clip } from "../util/text.js";
import { bool, int, schema, str, strEnum, strList, strMap, type ToolDef } from "./common.js";

function hasCode(mod: ModuleInfo, codeDir?: string): boolean {
  if (codeDir) return true;
  const src = path.join(mod.dir, "Source");
  return fs.existsSync(src);
}

interface Coverage {
  sum: L10nSummary;
  translated: Set<string>;
  /** ids translated by another module (the mod reuses an existing string with the same text). */
  inherited: Set<string>;
  untranslated: string[];
  stale: string[];
}

function coverage(ctx: Ctx, mod: ModuleInfo, lang: LanguageDef, code: boolean, codeDir?: string): Coverage & { files: string[] } {
  ctx.indexAll();
  const sum = summarize(collectModuleStrings(ctx.index, mod, { code, codeDir }));
  const ml = loadModuleLanguage(mod, lang);
  const translated = new Set<string>();
  for (const f of ml.files) for (const id of f.entries.keys()) translated.add(id);
  const others = ctx.registry.loadOrder(ctx.registry.modules.filter((m) => m.id !== mod.id));
  const otherMap = languageMap(others, lang);
  const global = ctx.index.stringIds();
  const inherited = new Set<string>();
  const untranslated: string[] = [];
  for (const [id, s] of sum.unique) {
    if (translated.has(id)) continue;
    const g = global.get(id);
    if (otherMap.has(id) && (!g || g.module === mod.id || g.text === s.text)) {
      inherited.add(id);
      continue;
    }
    untranslated.push(id);
  }
  const stale = [...translated].filter((id) => !sum.unique.has(id));
  return { sum, translated, inherited, untranslated, stale, files: ml.files.map((f) => f.xmlPath) };
}

export const l10nTools: ToolDef[] = [
  {
    name: "l10n_scan",
    group: "l10n",
    title: "Scan localizable strings",
    description:
      "Scans a module's XML data, GUI prefabs and C# code (Source/ or code_dir) for {=id}Text strings. Reports texts without ids, empty ids, ids reused with different texts, ids colliding with other modules, and translation coverage per language. fix_missing_ids / fix_conflicts rewrite the module's XML with fresh unique ids.",
    inputSchema: schema(
      {
        module: str("Module id."),
        fix_missing_ids: bool("Add {=newId} to player-facing XML texts that have none (or {=}) (default false)."),
        fix_conflicts: bool("Give new ids to strings whose id is reused with a different text, here or in another module (default false)."),
        include_code: bool("Also scan .cs files (default: when a Source folder or code_dir exists)."),
        code_dir: str("Folder with the mod's C# sources if outside the module folder."),
      },
      ["module"],
    ),
    handler: async (a, ctx) => {
      const fixMissing = a.bool("fix_missing_ids", false);
      const fixConflicts = a.bool("fix_conflicts", false);
      const mod = fixMissing || fixConflicts ? ctx.registry.requireWritable(a.req("module")) : ctx.registry.require(a.req("module"));
      ctx.indexAll();
      const codeDir = a.str("code_dir");
      const code = a.bool("include_code", hasCode(mod, codeDir));
      const sources = collectModuleStrings(ctx.index, mod, { code, codeDir });
      const sum = summarize(sources);
      const byKind = { xml: 0, gui: 0, code: 0 };
      for (const s of sources) byKind[s.kind]++;
      const global = ctx.index.stringIds();
      const collisions: Array<[string, string, string, string]> = [];
      for (const [id, s] of sum.unique) {
        const g = global.get(id);
        if (g && g.module !== mod.id && g.text !== s.text) collisions.push([id, s.text, g.module, g.text]);
      }
      const L: string[] = [];
      L.push(`${mod.id}: ${sources.length} string occurrence(s) — xml ${byKind.xml}, gui ${byKind.gui}, code ${byKind.code}${code ? "" : " (code not scanned)"}; ${sum.unique.size} unique ids; ${sum.noLocalize} marked {=!}.`);
      if (!code && mod.subModules.length) L.push("Note: this module has DLLs; pass code_dir=<folder with its .cs sources> to include strings from C# code.");
      if (sum.missing.length) {
        L.push(`Missing ids (${sum.missing.length}):`);
        for (const s of sum.missing.slice(0, 15)) L.push(`  ${s.file}:${s.line} <${s.tag} ${s.attr}="${clip(s.text, 60)}">`);
      }
      if (sum.emptyIds.length) L.push(`Empty ids {=} (${sum.emptyIds.length}): ${sum.emptyIds.slice(0, 8).map((s) => `${s.file}:${s.line}`).join(", ")}`);
      if (sum.conflicts.size) {
        L.push(`Same id, different texts (${sum.conflicts.size}):`);
        for (const [id, t] of [...sum.conflicts].slice(0, 10)) L.push(`  {=${id}}: ${[...t].map((x) => `"${clip(x, 40)}"`).join(" vs ")}`);
      }
      if (collisions.length) {
        L.push(`Ids that collide with other modules (${collisions.length}) — the other module's translation would be shown:`);
        for (const [id, mine, m, theirs] of collisions.slice(0, 10)) L.push(`  {=${id}} "${clip(mine, 35)}" vs ${m} "${clip(theirs, 35)}"`);
      }
      const langs = knownLanguages(ctx.registry);
      const cov: string[] = [];
      for (const lang of langs) {
        const ml = loadModuleLanguage(mod, lang);
        if (!ml.languageDataFiles.length) continue;
        const have = new Set(ml.files.flatMap((f) => [...f.entries.keys()]));
        const done = [...sum.unique.keys()].filter((id) => have.has(id)).length;
        cov.push(`${lang.folder} ${done}/${sum.unique.size}`);
      }
      L.push(`Translations: ${cov.length ? cov.join(", ") : "none yet (use l10n_status + l10n_set)"}`);

      if ((fixMissing || fixConflicts) && mod.writable) {
        const taken = takenStringIds(ctx.index, sources);
        const conflictIds = new Set<string>();
        const keep = new Map<string, string>();
        if (fixConflicts) {
          for (const [id] of sum.conflicts) {
            conflictIds.add(id);
            keep.set(id, sum.unique.get(id)!.text);
          }
          for (const [id] of collisions) {
            conflictIds.add(id);
            keep.delete(id);
          }
        }
        const shared = new Map<string, string>();
        const regenerate = (id: string, text: string): string | null => {
          if (!conflictIds.has(id)) return null;
          if (keep.has(id) && keep.get(id) === text) return null;
          const k = `${id}\u0000${text}`;
          let n = shared.get(k);
          if (!n) shared.set(k, (n = generateStringId(taken)));
          return n;
        };
        const files = ctx.index.moduleFiles(mod.id).filter((f) => f.kind === "data");
        const tx = ctx.history.begin("l10n_scan", mod.id, "fix localization ids");
        let assigned = 0;
        let regenerated = 0;
        const samples: string[] = [];
        try {
          for (const f of files) {
            if (!fixMissing && !f.strings.some((s) => conflictIds.has(s.id))) continue;
            if (fixMissing && !f.strings.some((s) => s.missingId || s.id === "" || conflictIds.has(s.id))) continue;
            const r = fixDataFileIds(tx, f.abs, f.rel, taken, fixConflicts ? regenerate : () => null, fixMissing);
            assigned += r.assigned;
            regenerated += r.regenerated;
            samples.push(...r.samples.map((s) => `${f.rel} ${s}`));
          }
        } catch (e) {
          // Leave nothing half-done.
          const entry = tx.commit();
          if (entry) ctx.history.undo(entry.seq, true);
          ctx.afterWrite(mod.id);
          throw e;
        }
        const entry = tx.commit();
        ctx.afterWrite(mod.id);
        L.push("", `Fixed: ${assigned} id(s) added, ${regenerated} id(s) regenerated in XML.${entry ? ` (edit #${entry.seq} — undo_edit seq=${entry.seq} reverts it)` : ""}`);
        for (const s of samples.slice(0, 15)) L.push(`  ${s}`);
        if (sources.some((s) => s.kind !== "xml" && (s.missingId || s.id === ""))) L.push("GUI/C# strings are not rewritten automatically; fix them by hand.");
      } else if (sum.missing.length || sum.emptyIds.length || sum.conflicts.size || collisions.length) {
        L.push("", "Run again with fix_missing_ids=true and/or fix_conflicts=true to repair the XML automatically.");
      }
      return L.join("\n");
    },
  },
  {
    name: "l10n_status",
    group: "l10n",
    title: "List strings to translate",
    description:
      "Lists a module's strings for one language as JSON lines {\"id\",\"text\"[,\"tr\"]}: untranslated (default), translated, all, or stale (translations whose id no longer exists). Strings already translated by the game/other modules (same id and text) are skipped. Translate them and send the result to l10n_set.",
    inputSchema: schema(
      {
        module: str("Module id."),
        language: str("Target language: CNs/zh/简体中文, CNt/zh-TW, RU, DE, FR, JP, KO, TR, PL, BR, IT, SP, EN."),
        show: strEnum(["untranslated", "translated", "all", "stale"], "Which entries (default untranslated)."),
        offset: int("Skip entries (paging)."),
        limit: int("Max entries (default 100, max 500)."),
        include_code: bool("Include strings from C# sources (default: when Source/ or code_dir exists)."),
        code_dir: str("Folder with C# sources outside the module."),
      },
      ["module", "language"],
    ),
    readOnly: true,
    handler: (a, ctx) => {
      const mod = ctx.registry.require(a.req("module"));
      const lang = resolveLanguage(a.req("language"), knownLanguages(ctx.registry));
      const codeDir = a.str("code_dir");
      const scanCode = a.bool("include_code", hasCode(mod, codeDir));
      const cov = coverage(ctx, mod, lang, scanCode, codeDir);
      const show = a.str("show") ?? "untranslated";
      const limit = a.int("limit", 100, 1, 500);
      const offset = a.int("offset", 0, 0);
      const ml = loadModuleLanguage(mod, lang);
      const trOf = (id: string): string | undefined => {
        for (const f of ml.files) {
          const e = f.entries.get(id);
          if (e) return e.text;
        }
        return undefined;
      };
      let ids: string[];
      if (show === "translated") ids = [...cov.sum.unique.keys()].filter((id) => cov.translated.has(id));
      else if (show === "all") ids = [...cov.sum.unique.keys()];
      else if (show === "stale") ids = cov.stale;
      else ids = cov.untranslated;
      const page = ids.slice(offset, offset + limit);
      const L = [
        `${mod.id} → ${lang.id} (${lang.folder}): ${cov.sum.unique.size} ids, ${cov.translated.size - cov.stale.length} translated in this module, ${cov.inherited.size} already translated by other modules, ${cov.untranslated.length} untranslated, ${cov.stale.length} stale.`,
        `Language files: ${cov.files.length ? cov.files.map((f) => `ModuleData/Languages/${f}`).join(", ") : "(none yet — l10n_set creates them)"}`,
        `${show}: ${ids.length} entr${ids.length === 1 ? "y" : "ies"}${ids.length > page.length ? `, showing ${offset + 1}-${offset + page.length}` : ""}`,
      ];
      if (!scanCode && mod.subModules.length) {
        L.splice(2, 0, "Note: the module has DLLs but no C# sources were scanned, so strings used only in code are missing (and their translations look stale). Pass code_dir=<folder with the .cs files>.");
      }
      for (const id of page) {
        const src = cov.sum.unique.get(id);
        const rec: Record<string, string> = { id, text: src?.text ?? "" };
        const tr = trOf(id);
        if (tr !== undefined && show !== "untranslated") rec.tr = tr;
        L.push(JSON.stringify(rec));
      }
      if (ids.length > offset + page.length) L.push(`… next page: offset=${offset + page.length}`);
      if (show === "untranslated" && page.length) L.push("", "Translate and call l10n_set with translations={id: text}. Keep {VARIABLES}, {?CONDITION}…{\\?} and {.%}…{.%} tokens unchanged.");
      return L.join("\n");
    },
  },
  {
    name: "l10n_set",
    group: "l10n",
    title: "Write translations",
    description:
      "Writes translations for one language into the module's ModuleData/Languages/<folder>/ files (creates language_data.xml and <module>_strings.xml when missing; existing ids are updated in place). Warns when {PLACEHOLDERS} differ from the source text.",
    inputSchema: schema(
      {
        module: str("Writable module id."),
        language: str("Target language (CNs/zh/简体中文, CNt, RU, DE, …)."),
        translations: strMap("Map of string id → translated text."),
        remove: strList("String ids to delete from the language files (e.g. stale ones)."),
        fill_untranslated_with_source: bool("Also add every untranslated id with its source text (template for human translators)."),
        allow_unknown_ids: bool("Write ids that do not occur in the module's sources (default false: they are skipped)."),
        file: str("Target file relative to ModuleData/Languages (default <folder>/<module>_strings.xml)."),
      },
      ["module", "language"],
    ),
    handler: async (a, ctx) => {
      const mod = ctx.registry.requireWritable(a.req("module"));
      const lang = resolveLanguage(a.req("language"), knownLanguages(ctx.registry));
      const cov = coverage(ctx, mod, lang, hasCode(mod), undefined);
      const entries = a.map("translations");
      const warnings: string[] = [];
      const unknown: string[] = [];
      const accepted: Array<[string, string]> = [];
      for (const [id, text] of entries) {
        const src = cov.sum.unique.get(id);
        if (!src && !a.bool("allow_unknown_ids", false)) {
          unknown.push(id);
          continue;
        }
        if (src) {
          const mm = placeholderMismatch(src.text, text);
          if (mm) warnings.push(`{=${id}} ${mm}`);
        }
        accepted.push([id, text]);
      }
      if (a.bool("fill_untranslated_with_source", false)) {
        const have = new Set(accepted.map(([id]) => id));
        for (const id of cov.untranslated) if (!have.has(id)) accepted.push([id, cov.sum.unique.get(id)!.text]);
      }
      const remove = a.list("remove");
      if (!accepted.length && !remove.length) {
        return `Nothing written.${unknown.length ? ` Unknown ids skipped: ${unknown.slice(0, 20).join(", ")} (check l10n_status, or allow_unknown_ids=true).` : ""}`;
      }
      const tx = ctx.history.begin("l10n_set", mod.id, `${lang.folder}: ${accepted.length} translation(s)`);
      let res;
      try {
        res = setTranslations(tx, mod, lang, accepted, { file: a.str("file"), remove });
      } catch (e) {
        const entry = tx.commit();
        if (entry) ctx.history.undo(entry.seq, true);
        ctx.afterWrite(mod.id);
        throw e;
      }
      const entry = tx.commit();
      ctx.afterWrite(mod.id);
      const after = coverage(ctx, ctx.registry.require(mod.id), lang, hasCode(mod), undefined);
      const L = [
        `${lang.id} (${lang.folder}): ${res.added} added, ${res.updated} updated, ${res.unchanged} unchanged, ${res.removed} removed.`,
        `Files: ${res.files.join(", ") || "(none)"}`,
        `Remaining untranslated: ${after.untranslated.length} of ${after.sum.unique.size}.`,
      ];
      if (unknown.length) L.push(`Skipped unknown ids (${unknown.length}): ${unknown.slice(0, 20).join(", ")}`);
      if (warnings.length) L.push(`Placeholder warnings (${warnings.length}):`, ...warnings.slice(0, 20).map((w) => `  ${w}`));
      if (entry) L.push(`(edit #${entry.seq} — undo_edit seq=${entry.seq} reverts it)`);
      return L.join("\n");
    },
  },
];
