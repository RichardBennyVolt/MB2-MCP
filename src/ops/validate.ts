import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "../context.js";
import { compareVersions, resolveXmlNode, type ModuleInfo } from "../model/modules.js";
import { isCheckablePrefix, refPrefixForTag, type ObjRec } from "../model/objects.js";
import { readTextFile } from "../util/text.js";
import { checkWellFormed } from "../xml/wellformed.js";
import { collectModuleStrings, knownLanguages, loadModuleLanguage, summarize } from "./l10n.js";
import { isDirEntry } from "../util/fsx.js";

export interface Issue {
  severity: "error" | "warning" | "info";
  file?: string;
  line?: number;
  message: string;
}

export interface ValidateOptions {
  xsd: boolean;
  refs: boolean;
  l10n: boolean;
}

function rel(mod: ModuleInfo, abs: string): string {
  return path.relative(mod.dir, abs).split(path.sep).join("/");
}

export async function validateModule(ctx: Ctx, mod: ModuleInfo, opts: ValidateOptions): Promise<Issue[]> {
  const issues: Issue[] = [];
  const add = (severity: Issue["severity"], message: string, file?: string, line?: number): void => {
    issues.push({ severity, message, file, line });
  };

  // ---- SubModule.xml ---------------------------------------------------------------------------
  for (const e of mod.parseErrors) add("error", e, "SubModule.xml");
  if (mod.source !== "workshop" && mod.folderName.toLowerCase() !== mod.id.toLowerCase()) {
    add("warning", `Folder name '${mod.folderName}' differs from module Id '${mod.id}'. Keep them identical to avoid launcher/path issues.`, "SubModule.xml");
  }
  if (!/^[veabd]\d+(\.\d+){1,3}$/.test(mod.version)) add("warning", `Version '${mod.version}' should look like v1.0.0 (prefix v/e/b/a/d followed by numbers).`, "SubModule.xml");
  if (!mod.category) add("info", "No <ModuleCategory> (Singleplayer/Multiplayer); the launcher may hide the module.", "SubModule.xml");
  const gameVersion = ctx.registry.gameVersion();
  for (const d of mod.deps) {
    if (d.incompatible) continue;
    const dep = ctx.registry.get(d.id);
    if (!dep) {
      add(d.optional ? "info" : "error", `Dependency '${d.id}' is not installed${d.optional ? " (optional)" : ""}.`, "SubModule.xml");
      continue;
    }
    if (d.version && !d.version.includes("*") && compareVersions(dep.version, d.version, 3) < 0) {
      add("warning", `Dependency '${d.id}' requires ${d.version} but ${dep.version} is installed.`, "SubModule.xml");
    }
  }
  if (gameVersion && mod.deps.some((d) => d.id === "Native" && d.version && compareVersions(d.version, gameVersion, 3) !== 0)) {
    const v = mod.deps.find((d) => d.id === "Native")!.version!;
    add("info", `Native dependency version ${v} differs from the installed game ${gameVersion}.`, "SubModule.xml");
  }
  for (const s of mod.subModules) {
    if (!s.dll) {
      add("error", `<SubModule> '${s.name}' has no DLLName.`, "SubModule.xml");
      continue;
    }
    const dll = path.join(mod.dir, "bin", "Win64_Shipping_Client", s.dll);
    if (!fs.existsSync(dll)) add("error", `DLL ${s.dll} not found in bin/Win64_Shipping_Client (build the C# project first). The game fails to start the module without it.`, "SubModule.xml");
    if (!s.classType) add("error", `<SubModule> '${s.name}' has no SubModuleClassType.`, "SubModule.xml");
  }

  // ---- registered XML ------------------------------------------------------------------------------
  ctx.indexAll();
  const officialXmlIds = new Set<string>();
  for (const m of ctx.registry.modules) if (m.official) for (const n of m.xmls) officialXmlIds.add(n.id);
  for (const id of ctx.schemas.ids()) officialXmlIds.add(id);
  const seenNodes = new Set<string>();
  const xsdTasks: Array<{ op: "xsd"; xml: string; xsd: string }> = [];
  const xsltTasks: Array<{ op: "xslt-compile"; xslt: string }> = [];
  for (const node of mod.xmls) {
    const key = `${node.id}|${node.path.toLowerCase()}`;
    if (seenNodes.has(key)) add("warning", `XmlNode ${node.id}:${node.path} is registered twice.`, "SubModule.xml", node.line);
    seenNodes.add(key);
    if (officialXmlIds.size && !officialXmlIds.has(node.id)) {
      const close = [...officialXmlIds].find((x) => x.toLowerCase() === node.id.toLowerCase());
      add("warning", `XmlName id '${node.id}' is not used by the game${close ? ` (did you mean '${close}'? ids are case-sensitive)` : ""}.`, "SubModule.xml", node.line);
    }
    const r = resolveXmlNode(mod, node);
    if (r.kind === "outside") add("error", `XmlNode ${node.id}: path '${node.path}' leaves the module's ModuleData folder; it is not read.`, "SubModule.xml", node.line);
    if (r.kind === "missing") add("error", `XmlNode ${node.id}: neither ModuleData/${node.path}.xml, a folder, nor ${node.path}.xslt exists. The game shows "Unable to find xml file" or crashes.`, "SubModule.xml", node.line);
    if (r.strayXsl) add("warning", `Found ${rel(mod, r.strayXsl)} — the game only loads .xslt files; rename it.`, "SubModule.xml", node.line);
    const xsd = ctx.schemas.pathFor(node.id);
    const expectedRoot = ctx.index.rootTagForXmlId(node.id);
    for (const step of r.steps) {
      if (step.xml) {
        if (xsd) xsdTasks.push({ op: "xsd", xml: step.xml, xsd });
        const fr = ctx.index.moduleFiles(mod.id).find((f) => f.abs.toLowerCase() === step.xml!.toLowerCase());
        if (fr?.rootTag && expectedRoot && fr.rootTag !== expectedRoot) {
          add("warning", `Root element <${fr.rootTag}> but official ${node.id} files use <${expectedRoot}>.`, rel(mod, step.xml), 1);
        }
      }
      if (step.xslt) xsltTasks.push({ op: "xslt-compile", xslt: step.xslt });
    }
  }

  // ---- well-formedness of the XML the game parses with System.Xml (ModuleData, GUI) ---------------
  const allXml: string[] = [];
  const walkAll = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (isDirEntry(e, p)) {
        if (depth < 10) walkAll(p, depth + 1);
      } else if (/\.(xml|xslt)$/i.test(e.name)) allXml.push(p);
    }
  };
  walkAll(path.join(mod.dir, "ModuleData"), 0);
  walkAll(path.join(mod.dir, "GUI"), 0);
  for (const f of allXml.slice(0, 3000)) {
    try {
      const probs = checkWellFormed(readTextFile(f).text, 3);
      for (const p of probs) add("error", `Not well-formed: ${p.message}`, rel(mod, f), p.line);
    } catch (e) {
      add("error", `Cannot read: ${(e as Error).message}`, rel(mod, f));
    }
  }

  // ---- unregistered data files -----------------------------------------------------------------------
  const hasCode = mod.subModules.length > 0;
  // File names that official modules also ship without registration are loaded by the engine by name.
  const engineNames = new Set<string>();
  for (const m of ctx.registry.modules) {
    if (!m.official) continue;
    for (const f of ctx.index.moduleFiles(m.id)) if (!f.xmlIds.length) engineNames.add(path.basename(f.rel).toLowerCase());
  }
  const unregistered = ctx.index.moduleFiles(mod.id).filter((f) => !f.registered);
  for (const f of unregistered) {
    if (engineNames.has(path.basename(f.rel).toLowerCase())) continue;
    if (hasCode) add("info", "Not registered in SubModule.xml <Xmls> or project.mbproj; only loaded if the mod's code reads it.", f.rel);
    else add("warning", "Not registered in SubModule.xml <Xmls> (or project.mbproj), so the game never loads it. Register it with edit_submodule register_xmls.", f.rel);
  }

  // ---- .NET checks (XSD + XSLT compile) ------------------------------------------------------------
  if (opts.xsd && (xsdTasks.length || xsltTasks.length)) {
    if (!ctx.dotnet.available()) add("info", `XSD/XSLT checks skipped: ${ctx.dotnet.unavailableReason()}`);
    else {
      const tasks = [...xsdTasks, ...xsltTasks];
      const res = await ctx.dotnet.run(tasks);
      res.forEach((r, i) => {
        const t = tasks[i];
        const file = rel(mod, t.op === "xsd" ? t.xml : t.xslt);
        if (!r.ok) {
          add("error", t.op === "xsd" ? `XSD validation failed: ${r.error}` : `XSLT does not compile: ${r.error}`, file, r.line);
          return;
        }
        for (const e of r.result?.errors ?? []) add(e.severity === "Warning" ? "warning" : "error", `XSD: ${e.message}`, file, e.line);
      });
    }
  }

  // ---- objects -----------------------------------------------------------------------------------------
  const objs: ObjRec[] = [...ctx.index.objects([mod.id])];
  const byKey = new Map<string, ObjRec[]>();
  for (const o of objs) {
    const k = `${refPrefixForTag(o.tag)}.${o.id}`;
    const list = byKey.get(k) ?? [];
    list.push(o);
    byKey.set(k, list);
  }
  for (const [k, list] of byKey) {
    // Duplicates only matter when they end up in the same merged document (same XmlName id).
    const perXml = new Map<string, ObjRec[]>();
    for (const o of list) for (const x of o.file.xmlIds) perXml.set(x, [...(perXml.get(x) ?? []), o]);
    for (const [x, dups] of perXml) {
      if (dups.length < 2) continue;
      add("error", `${k} is defined ${dups.length} times in this module's ${x} files (${dups.map((o) => `${o.file.rel}:${o.line}`).join(", ")}); only the last one wins.`, dups[1].file.rel, dups[1].line);
    }
  }
  const context = ctx.registry.contextFor(mod);
  const contextIds = new Set(context.map((m) => m.id));
  const overrides: string[] = [];
  for (const [k, list] of byKey) {
    const o = list[0];
    const others = ctx.index.find(o.id).filter((x) => x.module !== mod.id && refPrefixForTag(x.tag) === refPrefixForTag(o.tag) && contextIds.has(x.module));
    if (others.length) overrides.push(`${k} (from ${[...new Set(others.map((x) => x.module))].join(", ")})`);
  }
  if (overrides.length) add("info", `${overrides.length} object(s) override other modules: ${overrides.slice(0, 15).join("; ")}${overrides.length > 15 ? "; …" : ""}`);

  if (opts.refs) {
    const known = ctx.index.knownTags();
    // Group by reference so one typo does not produce hundreds of lines.
    const bad = new Map<string, { users: ObjRec[]; elsewhere: string[] }>();
    for (const o of objs) {
      if (!o.file.registered) continue;
      for (const ref of o.refs) {
        const prefix = ref.slice(0, ref.indexOf("."));
        if (!isCheckablePrefix(prefix, known)) continue;
        const res = ctx.index.lookup(ref);
        if (res.matches.some((m) => contextIds.has(m.module) || m.module === mod.id)) continue;
        let b = bad.get(ref);
        if (!b) bad.set(ref, (b = { users: [], elsewhere: [...new Set(res.matches.map((m) => m.module))] }));
        b.users.push(o);
      }
    }
    for (const [ref, b] of bad) {
      const first = b.users[0];
      const who = `${b.users.length} object(s), e.g. ${b.users
        .slice(0, 3)
        .map((u) => `${u.tag}.${u.id}`)
        .join(", ")}`;
      if (b.elsewhere.length) add("warning", `${ref} only exists in ${b.elsewhere.join(", ")} (not a dependency of this module); used by ${who}.`, first.file.rel, first.line);
      else add("warning", `Unknown reference ${ref}, used by ${who}.`, first.file.rel, first.line);
    }
  }

  // ---- localization ------------------------------------------------------------------------------------
  if (opts.l10n) {
    const sum = summarize(collectModuleStrings(ctx.index, mod, { code: false }));
    if (sum.missing.length) {
      add(
        "warning",
        `${sum.missing.length} player-facing text(s) have no {=id} (cannot be translated). Examples: ${sum.missing
          .slice(0, 5)
          .map((s) => `${s.file}:${s.line} ${s.tag}@${s.attr}="${s.text.slice(0, 30)}"`)
          .join("; ")}. Fix with l10n_scan fix_missing_ids=true.`,
      );
    }
    if (sum.emptyIds.length) add("warning", `${sum.emptyIds.length} text(s) use an empty id {=}. Fix with l10n_scan fix_missing_ids=true.`);
    for (const [id, texts] of [...sum.conflicts].slice(0, 20)) {
      add("warning", `String id {=${id}} is used with ${texts.size} different texts: ${[...texts].map((t) => `"${t.slice(0, 30)}"`).join(", ")}.`);
    }
    const globalIds = ctx.index.stringIds();
    let collisions = 0;
    const samples: string[] = [];
    for (const [id, s] of sum.unique) {
      const g = globalIds.get(id);
      if (g && g.module !== mod.id && g.text !== s.text) {
        collisions++;
        if (samples.length < 5) samples.push(`{=${id}} "${s.text.slice(0, 25)}" vs ${g.module} "${g.text.slice(0, 25)}"`);
      }
    }
    if (collisions) add("warning", `${collisions} string id(s) collide with other modules but have different text (translations will show the other text): ${samples.join("; ")}. Fix with l10n_scan fix_conflicts=true.`);
    for (const lang of knownLanguages(ctx.registry)) {
      const ml = loadModuleLanguage(mod, lang);
      if (!ml.languageDataFiles.length) continue;
      for (const f of ml.files) if (!f.exists) add("error", `language_data.xml (${lang.id}) references missing file ${f.xmlPath}.`, rel(mod, ml.languageDataFiles[0]));
      const have = new Set(ml.files.flatMap((f) => [...f.entries.keys()]));
      const untranslated = [...sum.unique.keys()].filter((id) => !have.has(id)).length;
      add("info", `${lang.folder} (${lang.id}): ${have.size} translated entries, ${untranslated} of ${sum.unique.size} ids untranslated.`);
    }
  }

  if (!mod.xmls.length && !mod.subModules.length) add("info", "The module registers no XML and no DLL; it does nothing yet.");
  return issues;
}

export function formatIssues(issues: Issue[], limit = 200): string {
  const order = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity]);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.severity]++;
  const lines = [`${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info`];
  for (const i of sorted.slice(0, limit)) {
    const loc = i.file ? ` ${i.file}${i.line ? `:${i.line}` : ""}` : "";
    lines.push(`[${i.severity}]${loc} ${i.message}`);
  }
  if (sorted.length > limit) lines.push(`… ${sorted.length - limit} more`);
  return lines.join("\n");
}
