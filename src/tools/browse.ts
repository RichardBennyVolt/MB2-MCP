import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "../context.js";
import { resolveXmlNode } from "../model/modules.js";
import { displayName, refPrefixForTag, tagsForPrefix, type ObjRec } from "../model/objects.js";
import { knownLanguages, languageMap, loadModuleLanguage, resolveLanguage, type LanguageDef } from "../ops/l10n.js";
import { effectiveDefinition, locate } from "../ops/objects-edit.js";
import { observeAttributes } from "../ops/schema.js";
import { clip, readTextFile } from "../util/text.js";
import { elementSource } from "../xml/edit.js";
import { bool, hasCjk, int, objLabel, objLine, schema, str, strEnum, strList, type ToolDef } from "./common.js";
import { VERSION, WORKFLOW } from "../version.js";

function langFor(ctx: Ctx, spec: string | undefined, query: string | undefined): { lang: LanguageDef; map: Map<string, string> } | null {
  let s = spec;
  if (!s && query && hasCjk(query)) s = "CNs";
  if (!s) return null;
  const lang = resolveLanguage(s, knownLanguages(ctx.registry));
  const mods = ctx.registry.loadOrder(ctx.registry.modules);
  return { lang, map: languageMap(mods, lang) };
}

function typeTags(ctx: Ctx, type: string | undefined): Set<string> | null {
  if (!type) return null;
  const out = new Set<string>();
  for (const t of type.split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
    for (const tag of tagsForPrefix(t)) out.add(tag);
    out.add(t);
    // case-insensitive convenience
    for (const k of ctx.index.knownTags()) if (k.toLowerCase() === t.toLowerCase()) out.add(k);
  }
  return out;
}

type Cond = (o: ObjRec) => boolean;

function parseWhere(list: string[]): Cond[] {
  return list.map((raw) => {
    const s = raw.trim();
    let m: RegExpExecArray | null;
    const get = (o: ObjRec, k: string): string | undefined => o.attrs.find(([n]) => n === k)?.[1];
    if ((m = /^!\s*([\w.:-]+)$/.exec(s))) {
      const k = m[1];
      return (o) => get(o, k) === undefined;
    }
    if ((m = /^([\w.:-]+)\s*\?$/.exec(s))) {
      const k = m[1];
      return (o) => get(o, k) !== undefined;
    }
    if ((m = /^([\w.:-]+)\s*(!=|>=|<=|=|~|>|<)\s*(.*)$/.exec(s))) {
      const [, k, op, rawV] = m;
      const v = rawV.trim().replace(/^["'](.*)["']$/, "$1");
      const num = parseFloat(v);
      return (o) => {
        const a = get(o, k);
        if (op === "!=") return a !== v;
        if (a === undefined) return false;
        switch (op) {
          case "=":
            return a.toLowerCase() === v.toLowerCase();
          case "~":
            return a.toLowerCase().includes(v.toLowerCase());
          case ">":
            return parseFloat(a) > num;
          case "<":
            return parseFloat(a) < num;
          case ">=":
            return parseFloat(a) >= num;
          case "<=":
            return parseFloat(a) <= num;
        }
        return false;
      };
    }
    throw new Error(`Bad where condition '${s}'. Use attr=value, attr!=value, attr~text, attr>number, attr<number, attr? (exists) or !attr (missing).`);
  });
}

function textOf(o: ObjRec, tr: Map<string, string> | undefined): string {
  if (!tr || !o.name) return "";
  const m = /^\{=([^}]*)\}/.exec(o.name);
  return m && m[1] ? (tr.get(m[1]) ?? "") : "";
}

export const browseTools: ToolDef[] = [
  {
    name: "game_info",
    group: "core",
    title: "Bannerlord environment overview",
    description:
      "Start here. Shows the detected Mount & Blade II: Bannerlord install, game version, module folders, which modules are writable, the launcher's enabled mods, index/validation status and the recommended editing workflow.",
    inputSchema: schema({}),
    readOnly: true,
    handler: (_a, ctx) => {
      ctx.registry.refresh();
      const loc = ctx.registry.location;
      const mods = ctx.registry.modules;
      ctx.indexAll();
      const st = ctx.index.stats();
      const lines = [`mb2-mcp ${VERSION} — Mount & Blade II: Bannerlord mod editor`];
      if (loc.gameDir) lines.push(`Game: ${loc.gameDir} (version ${ctx.registry.gameVersion() || "?"}, found via ${loc.detectedBy})`);
      else lines.push(`Game: NOT FOUND (${loc.detectedBy}). Set MB2_GAME_DIR to the folder that contains Modules\\Native.`);
      lines.push(`Workshop: ${ctx.config.includeWorkshop ? (loc.workshopDir ?? "(none)") : "(disabled)"}`);
      if (ctx.config.extraModuleDirs.length) lines.push(`Extra module dirs (writable): ${ctx.config.extraModuleDirs.join("; ")}`);
      const off = mods.filter((m) => m.official);
      const wr = mods.filter((m) => m.writable);
      const ws = mods.filter((m) => m.source === "workshop");
      lines.push(`Modules: ${mods.length} (${off.length} official, ${ws.length} workshop, ${wr.length} writable${wr.length ? `: ${wr.map((m) => m.id).join(", ")}` : ""})`);
      const launcher = ctx.registry.launcher;
      if (launcher) lines.push(`Launcher (enabled, in order): ${launcher.order.filter((id) => launcher.enabled.has(id.toLowerCase())).join(", ") || "(none)"}`);
      const xsd = ctx.schemas.ids();
      lines.push(`XML schemas: ${xsd.length ? `${xsd.length} XSD files in XmlSchemas` : "not found"}; .NET (XSD validation + XSLT preview): ${ctx.dotnet.available() ? "available" : `unavailable — ${ctx.dotnet.unavailableReason()}`}`);
      lines.push(`Index: ${st.files} files, ${st.objects} objects`);
      lines.push(`History/backups: ${ctx.history.dir}${ctx.config.readOnly ? " (READ-ONLY MODE)" : ""}`);
      lines.push("", WORKFLOW);
      return lines.join("\n");
    },
  },
  {
    name: "list_modules",
    group: "core",
    title: "List modules",
    description:
      "Lists installed modules (official, Steam Workshop, your own) with id, version, flags (official / writable / workshop / enabled in launcher) and folder. filter: all | official | mods | writable | workshop | enabled.",
    inputSchema: schema({
      filter: strEnum(["all", "official", "mods", "writable", "workshop", "enabled"], "Which modules to show (default all)."),
      query: str("Optional substring of id or name."),
    }),
    readOnly: true,
    handler: (a, ctx) => {
      const filter = (a.str("filter") ?? "all").toLowerCase();
      const q = (a.str("query") ?? "").toLowerCase();
      const launcher = ctx.registry.launcher;
      let mods = ctx.registry.loadOrder(ctx.registry.modules);
      if (filter === "enabled") mods = mods.filter((m) => launcher?.enabled.has(m.id.toLowerCase()));
      else if (filter !== "all") {
        const sel = new Set(ctx.selectModules(filter).map((m) => m.id));
        mods = mods.filter((m) => sel.has(m.id));
      }
      if (q) mods = mods.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
      const enabledOrder = (launcher?.order ?? []).filter((x) => launcher?.enabled.has(x.toLowerCase())).map((x) => x.toLowerCase());
      const lines = [`${mods.length} module(s) (load order):`];
      for (const m of mods) {
        const flags = [m.official ? "official" : m.source === "workshop" ? "workshop" : "mod", m.writable ? "writable" : "read-only"];
        const li = enabledOrder.indexOf(m.id.toLowerCase());
        if (li >= 0) flags.push(`enabled #${li + 1}`);
        const deps = m.deps.filter((d) => !d.incompatible && d.order === "before").map((d) => d.id + (d.optional ? "?" : ""));
        lines.push(`${m.id} ${m.version} [${flags.join(", ")}]${m.name !== m.id ? ` "${m.name}"` : ""} — ${m.dir}${deps.length ? `\n    depends: ${deps.join(", ")}` : ""}${m.shadowedBy ? ` (shadowed by ${m.shadowedBy})` : ""}`);
      }
      const dups = ctx.registry.all.filter((m) => m.shadowedBy);
      if (dups.length) lines.push(`Duplicates ignored: ${dups.map((d) => `${d.id} at ${d.dir}`).join("; ")}`);
      return lines.join("\n");
    },
  },
  {
    name: "module_info",
    group: "core",
    title: "Module details",
    description:
      "Details of one module: SubModule.xml fields, dependencies (installed versions), DLL entries, every <Xmls> registration with its resolved files and object counts, XSLT patches, unregistered files and language files.",
    inputSchema: schema({ module: str("Module id (e.g. MyMod, Native, SandBoxCore).") }, ["module"]),
    readOnly: true,
    handler: (a, ctx) => {
      const mod = ctx.registry.require(a.req("module"));
      ctx.index.ensure([mod]);
      const L: string[] = [];
      L.push(`${mod.id} "${mod.name}" ${mod.version}${mod.requiredBaseVersion ? ` (requires game ${mod.requiredBaseVersion})` : ""}`);
      L.push(`Folder: ${mod.dir}`);
      L.push(`Source: ${mod.source}; type: ${mod.moduleType || "-"}; category: ${mod.category || "-"}; default: ${mod.defaultModule}; ${mod.writable ? "WRITABLE" : "read-only"}`);
      for (const e of mod.parseErrors) L.push(`! ${e}`);
      if (mod.deps.length) {
        L.push("Dependencies:");
        for (const d of mod.deps) {
          const inst = ctx.registry.get(d.id);
          L.push(`  ${d.id}${d.version ? ` ${d.version}` : ""}${d.optional ? " (optional)" : ""}${d.order === "after" ? " [loads after this]" : ""}${d.incompatible ? " [incompatible]" : ""} → ${inst ? `installed ${inst.version}` : "NOT INSTALLED"}`);
        }
      }
      if (mod.loadAfterThis.length) L.push(`ModulesToLoadAfterThis: ${mod.loadAfterThis.join(", ")}`);
      if (mod.incompatible.length) L.push(`IncompatibleModules: ${mod.incompatible.join(", ")}`);
      if (mod.subModules.length) {
        L.push("SubModules (code):");
        for (const s of mod.subModules) {
          const dll = path.join(mod.dir, "bin", "Win64_Shipping_Client", s.dll);
          L.push(`  ${s.name}: ${s.dll} [${fs.existsSync(dll) ? "ok" : "MISSING"}] class ${s.classType}${s.assemblies.length ? ` (+ ${s.assemblies.join(", ")})` : ""}`);
        }
      }
      const files = ctx.index.moduleFiles(mod.id);
      if (mod.xmls.length) {
        L.push("XML registrations (<Xmls>):");
        for (const node of mod.xmls) {
          const r = resolveXmlNode(mod, node);
          const gt = node.gameTypes.length ? ` [${node.gameTypes.join(",")}]` : "";
          if (r.kind === "missing") {
            L.push(`  ${node.id} → ${node.path}: MISSING FILE${gt}`);
            continue;
          }
          if (r.kind === "outside") {
            L.push(`  ${node.id} → ${node.path}: OUTSIDE ModuleData — not read${gt}`);
            continue;
          }
          const parts = r.steps.map((s) => {
            const out: string[] = [];
            if (s.xml) {
              const fr = files.find((f) => f.abs.toLowerCase() === s.xml!.toLowerCase());
              const counts = new Map<string, number>();
              for (const o of fr?.objects ?? []) counts.set(o.tag, (counts.get(o.tag) ?? 0) + 1);
              out.push(`${path.relative(mod.dir, s.xml).split(path.sep).join("/")} (${[...counts].map(([t, n]) => `${t}×${n}`).join(", ") || "empty"})`);
            }
            if (s.xslt) {
              const fr = files.find((f) => f.abs.toLowerCase() === s.xslt!.toLowerCase());
              out.push(`${path.relative(mod.dir, s.xslt).split(path.sep).join("/")} (XSLT, ${fr?.xsltRules?.length ?? 0} rule(s))`);
            }
            return out.join(" + ");
          });
          L.push(`  ${node.id} → ${node.path} (${r.kind}): ${parts.join("; ")}${gt}`);
        }
      }
      const engine = files.filter((f) => f.engineType);
      if (engine.length) L.push(`Engine files (ModuleData/project.mbproj): ${engine.map((f) => `${f.rel} [${f.engineType}]`).join(", ")}`);
      const unreg = files.filter((f) => !f.registered);
      if (unreg.length) L.push(`Not registered (the game's XML loader ignores them unless the mod's code reads them): ${unreg.map((f) => f.rel).join(", ")}`);
      const langs: string[] = [];
      for (const lang of knownLanguages(ctx.registry)) {
        const ml = loadModuleLanguage(mod, lang);
        if (!ml.languageDataFiles.length) continue;
        const n = ml.files.reduce((s, f) => s + f.entries.size, 0);
        langs.push(`${lang.folder} (${lang.id}): ${ml.files.length} file(s), ${n} strings`);
      }
      if (langs.length) L.push(`Languages: ${langs.join("; ")}`);
      const other: string[] = [];
      for (const d of ["GUI", "bin", "Assets", "AssetPackages", "SceneObj", "Atmospheres", "NavMeshPrefabs"]) {
        if (fs.existsSync(path.join(mod.dir, d))) other.push(d);
      }
      if (other.length) L.push(`Other folders: ${other.join(", ")}`);
      const ctxMods = ctx.registry.contextFor(mod);
      L.push(`Runtime context (load order): ${ctxMods.map((m) => m.id).join(" > ")}`);
      return L.join("\n");
    },
  },
  {
    name: "list_types",
    group: "core",
    title: "List data types",
    description:
      "Summarizes game data by XmlName id (Items, NPCCharacters, SPCultures, Factions, Kingdoms, Settlements, partyTemplates, …) with the object tags and counts per module. Use it to learn what exists before searching.",
    inputSchema: schema({ module: str("Optional module filter: an id, comma list, or official | mods | writable | workshop.") }),
    readOnly: true,
    handler: (a, ctx) => {
      const mods = ctx.selectModules(a.str("module"));
      ctx.index.ensure(mods);
      const byXml = new Map<string, Map<string, Map<string, number>>>();
      for (const f of ctx.index.files(mods.map((m) => m.id))) {
        if (f.kind !== "data") continue;
        const keys = f.xmlIds.length ? f.xmlIds : [f.engineType ? `(engine files via project.mbproj)` : "(files not registered in SubModule.xml)"];
        for (const k of keys) {
          let tags = byXml.get(k);
          if (!tags) byXml.set(k, (tags = new Map()));
          for (const o of f.objects) {
            let per = tags.get(o.tag);
            if (!per) tags.set(o.tag, (per = new Map()));
            per.set(f.module, (per.get(f.module) ?? 0) + 1);
          }
        }
      }
      const lines: string[] = [];
      const xsd = new Set(ctx.schemas.ids().map((x) => x.toLowerCase()));
      for (const [xmlId, tags] of [...byXml].sort((x, y) => x[0].localeCompare(y[0]))) {
        const parts = [...tags].map(([tag, per]) => {
          const total = [...per.values()].reduce((s, n) => s + n, 0);
          return `${tag}×${total} (${[...per].map(([m, n]) => `${m}:${n}`).join(", ")})`;
        });
        lines.push(`${xmlId}${xsd.has(xmlId.toLowerCase()) ? " [xsd]" : ""}: ${parts.join("; ") || "(no objects)"}`);
      }
      lines.push("", "References between objects use 'Prefix.id': Item.x (Item/CraftedItem), NPCCharacter.x, Hero.x, Faction.x (clans), Kingdom.x, Culture.x, Settlement.x, PartyTemplate.x (MBPartyTemplate), CraftingPiece.x, EquipmentRoster.x, BodyProperty.x, SkillSet.x.");
      return lines.join("\n");
    },
  },
  {
    name: "search_objects",
    group: "core",
    title: "Search game objects",
    description:
      "Searches every module's XML objects (items, troops, heroes, clans, kingdoms, settlements, cultures, crafting pieces, party templates, strings, …) by id / name and attribute filters. Chinese queries also match the 简体中文 names. Returns 'Tag.id \"Name\" — module file:line | key attributes'.",
    inputSchema: schema({
      query: str("Substring of id or name (case-insensitive), or /regex/. Optional when type/where is given."),
      type: str("Tag or reference prefix, e.g. Item (includes CraftedItem), NPCCharacter, Hero, Faction, Kingdom, Settlement, Culture, PartyTemplate, CraftingPiece. Comma list allowed."),
      module: str("Module filter: id, comma list, official | mods | writable | workshop. Default: all."),
      where: strList("Attribute filters on the object element: culture=Culture.empire, Type=OneHandedWeapon, level>20, is_hero=true, name~sword, tier?, !culture"),
      lang: str("Also show/match translated names in this language (CNs, zh, 简体中文, RU, …)."),
      limit: int("Max results (default 30, max 200)."),
      offset: int("Skip this many results (paging)."),
    }),
    readOnly: true,
    handler: (a, ctx) => {
      const mods = ctx.selectModules(a.str("module"));
      ctx.index.ensure(mods);
      const q = a.str("query")?.trim() ?? "";
      const tags = typeTags(ctx, a.str("type"));
      const conds = parseWhere(a.list("where"));
      const limit = a.int("limit", 30, 1, 200);
      const offset = a.int("offset", 0, 0);
      const tr = langFor(ctx, a.str("lang"), q);
      if (!q && !tags && !conds.length) throw new Error("Give at least one of query, type or where.");
      let re: RegExp | null = null;
      if (q.length > 2 && q.startsWith("/") && q.lastIndexOf("/") > 0) {
        const last = q.lastIndexOf("/");
        re = new RegExp(q.slice(1, last), q.slice(last + 1).includes("i") ? q.slice(last + 1) : `${q.slice(last + 1)}i`);
      }
      const ql = q.toLowerCase();
      const order = new Map(ctx.registry.loadOrder(mods).map((m, i) => [m.id, i]));
      const hits: Array<{ o: ObjRec; score: number }> = [];
      for (const o of ctx.index.objects(mods.map((m) => m.id))) {
        if (tags && !tags.has(o.tag)) continue;
        if (conds.length && !conds.every((c) => c(o))) continue;
        let score = 5;
        if (q) {
          const dn = displayName(o.name);
          const t = textOf(o, tr?.map);
          if (re) {
            if (re.test(o.id)) score = 1;
            else if (re.test(dn) || (t && re.test(t))) score = 2;
            else continue;
          } else {
            const id = o.id.toLowerCase();
            if (id === ql) score = 0;
            else if (id.startsWith(ql)) score = 1;
            else if (id.includes(ql)) score = 2;
            else if (dn.toLowerCase().includes(ql)) score = 3;
            else if (t && t.toLowerCase().includes(ql)) score = 3;
            else continue;
          }
        }
        hits.push({ o, score });
      }
      hits.sort((x, y) => x.score - y.score || (order.get(x.o.module) ?? 0) - (order.get(y.o.module) ?? 0) || x.o.id.localeCompare(y.o.id));
      const page = hits.slice(offset, offset + limit);
      const lines = [`${hits.length} match(es)${hits.length > page.length ? `, showing ${offset + 1}-${offset + page.length}` : ""}${tr ? ` (names in ${tr.lang.id})` : ""}:`];
      for (const h of page) lines.push(objLine(h.o, tr?.map));
      if (hits.length > offset + page.length) lines.push(`… use offset=${offset + page.length} for more.`);
      if (!hits.length) lines.push("Tip: try a shorter query, drop filters, or list_types to see available tags.");
      return lines.join("\n");
    },
  },
  {
    name: "get_object",
    group: "core",
    title: "Read an object's XML",
    description:
      "Returns the XML of a game object, e.g. ref='Item.empire_sword_1_t2', 'NPCCharacter.imperial_recruit', 'Culture.empire' or a bare id. Shows which module's definition wins (load order), other definitions, XSLT patches that touch it and the absolute file path.",
    inputSchema: schema(
      {
        ref: str("Object reference 'Prefix.id' (Item.x, NPCCharacter.x, Faction.x, …) or a bare id."),
        module: str("Only show the definition from this module."),
        all_definitions: bool("Show the XML of every definition, not only the effective one (default false)."),
        lang: str("Show the translated name in this language (e.g. CNs)."),
      },
      ["ref"],
    ),
    readOnly: true,
    handler: (a, ctx) => {
      ctx.indexAll();
      const ref = a.req("ref");
      const res = ctx.index.lookup(ref);
      let matches = res.matches;
      const modFilter = a.str("module");
      if (modFilter) {
        const m = ctx.registry.require(modFilter);
        matches = matches.filter((o) => o.module === m.id);
      }
      if (!matches.length) {
        const sugg = [...ctx.index.objects()].filter((o) => o.id.toLowerCase().includes(res.id.toLowerCase())).slice(0, 10);
        return `Not found: ${ref}.${sugg.length ? ` Similar ids:\n${sugg.map((o) => `  ${o.tag}.${o.id} (${o.module})`).join("\n")}` : " Use search_objects."}`;
      }
      const tr = langFor(ctx, a.str("lang"), undefined);
      const groups = new Map<string, ObjRec[]>();
      for (const o of matches) {
        const k = `${refPrefixForTag(o.tag)}.${o.id}`;
        const list = groups.get(k) ?? [];
        list.push(o);
        groups.set(k, list);
      }
      const out: string[] = [];
      const all = a.bool("all_definitions", false);
      for (const [key, defs] of groups) {
        const eff = effectiveDefinition(ctx, defs)!;
        const mods = ctx.registry.loadOrder([...new Set(defs.map((d) => d.module))].map((id) => ctx.registry.get(id)!).filter(Boolean));
        out.push(`${objLabel(eff, tr?.map)}`);
        out.push(`Defined in: ${mods.map((m) => m.id).join(" → ")}${mods.length > 1 ? " (the last loaded definition wins)" : ""}`);
        const show = all ? defs : [eff];
        for (const d of show) {
          const text = readTextFile(d.file.abs).text;
          let xml: string;
          try {
            xml = elementSource(text, locate(text, d));
          } catch {
            xml = text.slice(d.start, d.end);
          }
          if (xml.length > 20000) xml = `${xml.slice(0, 20000)}\n… (truncated, ${xml.length} chars; open the file directly)`;
          out.push("", `== ${d.module}: ${d.file.rel}:${d.line}${d === eff ? " [effective]" : ""}`, `   ${d.file.abs}`, xml);
        }
        if (!all && defs.length > 1) out.push("", `Other definitions: ${defs.filter((d) => d !== eff).map((d) => `${d.module} ${d.file.rel}:${d.line}`).join("; ")} (all_definitions=true to show)`);
        const patches = ctx.index.xsltRulesFor(eff.id, eff.tag);
        if (patches.length) out.push("", `XSLT patches touching it: ${patches.map((p) => `${p.file.module} ${p.file.rel}:${p.rule.line} match="${clip(p.rule.match, 80)}"`).join("; ")}`);
        const nref = ctx.index.referencesTo(key).length;
        if (nref) out.push(`Referenced by ${nref} object(s) — find_references ${key}`);
        out.push("");
      }
      return out.join("\n").trimEnd();
    },
  },
  {
    name: "find_references",
    group: "core",
    title: "Find references",
    description:
      "Lists objects that reference a given object (e.g. which troops carry Item.x, which troops upgrade into NPCCharacter.y, which settlements belong to Faction.z). Accepts 'Prefix.id' or a bare id.",
    inputSchema: schema(
      {
        ref: str("Referenced object: Item.x, NPCCharacter.x, Culture.x, Faction.x, … or bare id."),
        module: str("Only report referencing objects from these modules (id, comma list, official, mods…)."),
        limit: int("Max results (default 50)."),
      },
      ["ref"],
    ),
    readOnly: true,
    handler: (a, ctx) => {
      ctx.indexAll();
      const ref = a.req("ref");
      const keys = new Set<string>();
      const res = ctx.index.lookup(ref);
      if (res.matches.length) for (const o of res.matches) keys.add(`${refPrefixForTag(o.tag)}.${o.id}`);
      if (res.prefix) keys.add(`${res.prefix}.${res.id}`);
      if (!keys.size) keys.add(ref);
      const filter = a.str("module") ? new Set(ctx.selectModules(a.str("module")).map((m) => m.id)) : null;
      const limit = a.int("limit", 50, 1, 500);
      const seen = new Set<ObjRec>();
      const hits: ObjRec[] = [];
      for (const k of keys) for (const o of ctx.index.referencesTo(k)) if (!seen.has(o) && (!filter || filter.has(o.module))) (seen.add(o), hits.push(o));
      const order = new Map(ctx.registry.loadOrder().map((m, i) => [m.id, i]));
      hits.sort((x, y) => (order.get(x.module) ?? 0) - (order.get(y.module) ?? 0) || x.tag.localeCompare(y.tag) || x.id.localeCompare(y.id));
      const perModule = new Map<string, number>();
      for (const h of hits) perModule.set(h.module, (perModule.get(h.module) ?? 0) + 1);
      const lines = [`${hits.length} object(s) reference ${[...keys].join(" / ")}${hits.length ? ` (${[...perModule].map(([m, n]) => `${m}:${n}`).join(", ")})` : ""}:`];
      for (const h of hits.slice(0, limit)) lines.push(objLine(h));
      if (hits.length > limit) lines.push(`… ${hits.length - limit} more (raise limit or filter by module).`);
      return lines.join("\n");
    },
  },
  {
    name: "describe_schema",
    group: "core",
    title: "Describe XML schema",
    description:
      "Explains which elements/attributes are valid, from the game's own XSD files (XmlSchemas folder) plus real values observed in official data. Use before writing XML. No args: list XmlName ids. xml_id only: root and object elements. element (+path for nested ones, e.g. element=Weapon path=Item/ItemComponent/Weapon): attributes with types/enums and children.",
    inputSchema: schema({
      xml_id: str("XmlName id, e.g. Items, NPCCharacters, SPCultures, Factions, Kingdoms, Settlements, partyTemplates, CraftingPieces, Heroes, GameText."),
      element: str("Element name, e.g. Item, CraftedItem, NPCCharacter, Culture, Settlement, Weapon, equipment."),
      path: str("Optional path suffix to disambiguate nested elements, e.g. Item/ItemComponent/Weapon."),
      observed: bool("Also show attribute values seen in official data (default true)."),
    }),
    readOnly: true,
    handler: (a, ctx) => {
      ctx.indexAll();
      let xmlId = a.str("xml_id");
      const element = a.str("element");
      const pathHint = a.str("path");
      const ids = ctx.schemas.ids();
      if (!xmlId && !element) {
        const lines = [`XSD files (XmlName ids) in ${ctx.schemas.dir() ?? "(XmlSchemas not found)"}:`];
        const tagMap = ctx.index.tagXmlIds();
        for (const id of ids) {
          const s = ctx.schemas.get(id);
          const tagsHere = [...tagMap].filter(([, m]) => m.has(id)).map(([t]) => t);
          lines.push(`  ${id}: root <${s?.rootElements().join(", ") ?? "?"}>${tagsHere.length ? ` objects: ${tagsHere.join(", ")}` : ""}`);
        }
        lines.push("Call again with xml_id and/or element for details.");
        return lines.join("\n");
      }
      if (!xmlId && element) xmlId = ctx.index.xmlIdForTag(element);
      const candidates = xmlId ? [xmlId] : ids;
      const out: string[] = [];
      let found = false;
      for (const id of candidates) {
        const s = ctx.schemas.get(id);
        if (!s) continue;
        if (!element) {
          for (const r of s.rootElements()) {
            const decl = s.find(r)[0];
            if (!decl) continue;
            const info = s.describe(decl.decl, decl.path);
            out.push(`${id}.xsd root <${r}> children: ${info.children.map((c) => `${c.name}[${c.min}..${c.max === "unbounded" ? "*" : c.max}]`).join(", ")}`);
          }
          found = true;
          break;
        }
        const decls = s.find(element, pathHint);
        if (!decls.length) continue;
        found = true;
        const d = decls[0];
        const info = s.describe(d.decl, d.path);
        out.push(`<${info.name}> in ${id}.xsd (path ${d.path})${decls.length > 1 ? ` — also declared at: ${decls.slice(1, 6).map((x) => x.path).join(", ")}` : ""}`);
        if (info.textType) out.push(`text content: ${info.textType}`);
        out.push(`attributes (${info.attributes.length}):`);
        for (const at of info.attributes) {
          const en = at.enumValues ? ` enum: ${at.enumValues.slice(0, 40).join(" | ")}${at.enumValues.length > 40 ? " | …" : ""}` : "";
          out.push(`  ${at.name}: ${at.type}${at.use === "required" ? " REQUIRED" : ""}${at.default ? ` default=${at.default}` : ""}${en}`);
        }
        if (info.children.length) {
          out.push("children:");
          for (const c of info.children) out.push(`  ${c.name} [${c.min}..${c.max === "unbounded" ? "*" : c.max}]${c.inChoice ? " (choice)" : ""}`);
        }
        if (a.bool("observed", true)) {
          const files = ctx.index
            .files(ctx.registry.modules.filter((m) => m.official).map((m) => m.id))
            .filter((f) => f.kind === "data" && f.xmlIds.includes(id))
            .map((f) => f.abs);
          const suffix = pathHint ?? (d.path.split("/").length > 2 ? d.path.split("/").slice(1).join("/") : undefined);
          const obs = observeAttributes(files, info.name, suffix);
          if (obs.occurrences) {
            out.push(`observed in official ${id} data (${obs.occurrences} elements):`);
            for (const at of obs.attrs.slice(0, 60)) {
              const many = at.distinct >= 100;
              const samples = (many ? at.values.slice(0, 2) : at.values).map(([v, n]) => `${clip(v, 50)}${n > 1 && !many ? `×${n}` : ""}`).join(" | ");
              out.push(`  ${at.name} (${at.count}×, ${many ? "mostly unique, e.g." : `${at.distinct} distinct:`} ${samples})`);
            }
            if (obs.childTags.length) out.push(`  child elements seen: ${obs.childTags.slice(0, 20).map(([t, n]) => `${t}×${n}`).join(", ")}`);
          }
        }
        break;
      }
      if (!found) {
        // No XSD: fall back to observed data only.
        const tag = element ?? "";
        const files = ctx.index.files().filter((f) => f.kind === "data" && (!xmlId || f.xmlIds.includes(xmlId))).map((f) => f.abs);
        const obs = tag ? observeAttributes(files, tag, pathHint) : { occurrences: 0, attrs: [], childTags: [] };
        if (!obs.occurrences) return `No schema or data found for ${element ?? ""}${xmlId ? ` in ${xmlId}` : ""}. Known XSD ids: ${ids.join(", ")}`;
        out.push(`No XSD declares <${tag}>${xmlId ? ` in ${xmlId}` : ""}; attributes observed in data (${obs.occurrences} elements):`);
        for (const at of obs.attrs.slice(0, 60)) out.push(`  ${at.name} (${at.count}×): ${at.values.map(([v, n]) => `${clip(v, 50)}${n > 1 ? `×${n}` : ""}`).join(" | ")}`);
        if (obs.childTags.length) out.push(`  child elements seen: ${obs.childTags.slice(0, 20).map(([t, n]) => `${t}×${n}`).join(", ")}`);
      }
      return out.join("\n");
    },
  },
];
