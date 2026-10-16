import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "../context.js";
import { CORE_SP_MODULES, type ModuleInfo } from "../model/modules.js";
import { refPrefixForTag } from "../model/objects.js";
import { analyzeWritten, deleteObject, effectiveDefinition, parseSnippet, prepareClone, setAttributes, wrapFragment, writeObjects, xsdCheck } from "../ops/objects-edit.js";
import { patchedTargets, previewXslt, xsltPatch } from "../ops/patching.js";
import {
  buildCsproj,
  buildSubModuleCs,
  buildSubModuleXml,
  csharpIdentifier,
  moduleDirFree,
  SubModuleDoc,
  validateModuleId,
  type CreateModuleOptions,
} from "../ops/submodule.js";
import { formatIssues, validateModule } from "../ops/validate.js";
import type { Args } from "../util/args.js";
import { encodeText } from "../util/text.js";
import { bool, objList, schema, str, strEnum, strList, strMap, type ToolDef } from "./common.js";

async function withTx<T>(ctx: Ctx, tool: string, mod: ModuleInfo | string, summary: string, fn: (tx: ReturnType<Ctx["history"]["begin"]>) => Promise<T> | T): Promise<{ result: T; seq: number | null }> {
  const modId = typeof mod === "string" ? mod : mod.id;
  const tx = ctx.history.begin(tool, modId, summary);
  try {
    const result = await fn(tx);
    const entry = tx.commit();
    return { result, seq: entry?.seq ?? null };
  } catch (e) {
    // Roll back anything already written in this transaction.
    const entry = tx.commit();
    if (entry) {
      try {
        ctx.history.undo(entry.seq, true);
      } catch {
        /* best effort */
      }
    }
    throw e;
  } finally {
    ctx.afterWrite(modId);
  }
}

function parseDeps(a: Args, name: string): Array<{ id: string; version?: string; optional: boolean }> {
  const out: Array<{ id: string; version?: string; optional: boolean }> = [];
  const raw = a.value(name);
  if (raw === undefined || raw === null || raw === "") return out;
  const items = Array.isArray(raw) ? raw : typeof raw === "string" && raw.trim().startsWith("[") ? JSON.parse(raw) : String(raw).split(/[,\n]/);
  for (const it of items as unknown[]) {
    if (typeof it === "string") {
      // "Id", "Id@v1.2.3", "Id?" (optional)
      const s = it.trim();
      if (!s) continue;
      const optional = s.endsWith("?");
      const body = optional ? s.slice(0, -1) : s;
      const [id, version] = body.split("@");
      out.push({ id: id.trim(), version: version?.trim() || undefined, optional });
    } else if (it && typeof it === "object") {
      const o = it as Record<string, unknown>;
      const id = String(o.id ?? o.Id ?? "").trim();
      if (!id) continue;
      const opt = o.optional ?? o.Optional;
      out.push({ id, version: o.version ? String(o.version) : undefined, optional: opt === true || /^true$/i.test(String(opt ?? "")) });
    }
  }
  return out;
}

function footer(seq: number | null): string {
  return seq !== null ? `\n(edit #${seq} — undo_edit seq=${seq} reverts it)` : "";
}

export const editTools: ToolDef[] = [
  {
    name: "create_module",
    group: "edit",
    title: "Create a new mod module",
    description:
      "Scaffolds a new module folder with SubModule.xml (dependencies on the installed official modules) and ModuleData/. Optional C# project (Source/<id>.csproj + SubModule.cs that builds into bin/Win64_Shipping_Client). Default location: <game>/Modules.",
    inputSchema: schema(
      {
        module_id: str("Module id = folder name (letters, digits, _ - .), e.g. MyArmory."),
        name: str("Display name in the launcher (default = id)."),
        version: str("Version like v1.0.0 (default v1.0.0)."),
        location: str("Parent folder for the module (default <game>/Modules). Outside Modules the game will not see it."),
        dependencies: strList("Dependencies as 'Id', 'Id@v1.2.3' or 'Id?' (optional). Default: Native, SandBoxCore, Sandbox, StoryMode?, CustomBattle? at the installed game version."),
        category: strEnum(["Singleplayer", "Multiplayer"], "ModuleCategory (default Singleplayer)."),
        with_csharp: bool("Also create a C# project skeleton (default false)."),
      },
      ["module_id"],
    ),
    handler: async (a, ctx) => {
      const id = a.req("module_id").trim();
      const bad = validateModuleId(id);
      if (bad) throw new Error(bad);
      if (ctx.config.readOnly) throw new Error("Read-only mode (MB2_READONLY): writes are disabled.");
      if (ctx.registry.get(id)) throw new Error(`A module with id '${id}' already exists (${ctx.registry.get(id)!.dir}).`);
      const gameDir = ctx.registry.gameDir;
      const parent = a.str("location") ? path.resolve(a.req("location")) : gameDir ? path.join(gameDir, "Modules") : null;
      if (!parent) throw new Error("Game folder not detected; pass location or set MB2_GAME_DIR.");
      const dir = path.join(parent, id);
      if (!moduleDirFree(dir)) throw new Error(`${dir} already exists and is not empty.`);
      const gv = ctx.registry.gameVersion() || "v1.0.0";
      let deps = parseDeps(a, "dependencies");
      if (!deps.length) {
        deps = CORE_SP_MODULES.filter((m) => ctx.registry.get(m)).map((m) => ({ id: m, version: ctx.registry.get(m)!.version || gv, optional: m === "StoryMode" || m === "CustomBattle" }));
      } else {
        deps = deps.map((d) => ({ ...d, version: d.version ?? ctx.registry.get(d.id)?.version }));
      }
      const opts: CreateModuleOptions = {
        id,
        name: a.str("name") || id,
        version: a.str("version") || "v1.0.0",
        category: a.str("category") || "Singleplayer",
        deps,
        withCSharp: a.bool("with_csharp", false),
        gameDir,
        gameVersion: gv,
      };
      ctx.history.allowRoot(dir);
      const isInModules = gameDir && path.resolve(parent).toLowerCase() === path.join(gameDir, "Modules").toLowerCase();
      if (!isInModules && !ctx.config.extraModuleDirs.some((d) => path.resolve(d).toLowerCase() === parent.toLowerCase())) {
        ctx.config.extraModuleDirs.push(parent);
      }
      const { seq } = await withTx(ctx, "create_module", id, `create module ${id}`, (tx) => {
        tx.mkdir(dir);
        tx.write(path.join(dir, "SubModule.xml"), encodeText(buildSubModuleXml(opts), "utf8"));
        tx.mkdir(path.join(dir, "ModuleData"));
        if (opts.withCSharp) {
          tx.write(path.join(dir, "Source", `${id}.csproj`), encodeText(buildCsproj(opts), "utf8"));
          tx.write(path.join(dir, "Source", "SubModule.cs"), encodeText(buildSubModuleCs(opts), "utf8"));
          tx.write(path.join(dir, "Source", ".gitignore"), encodeText("bin/\nobj/\n", "utf8"));
        }
      });
      const lines = [`Created module ${id} at ${dir}`, `Dependencies: ${deps.map((d) => `${d.id}${d.version ? ` ${d.version}` : ""}${d.optional ? " (optional)" : ""}`).join(", ")}`];
      if (opts.withCSharp) {
        lines.push(
          `C# project: ${path.join(dir, "Source", `${id}.csproj`)} (net472, references the game DLLs, outputs ${id}.dll to bin/Win64_Shipping_Client).`,
          `Build: dotnet build "${path.join(dir, "Source", `${id}.csproj`)}" -c Release   (SubModule class: ${csharpIdentifier(id)}.SubModule)`,
        );
      }
      if (!isInModules) {
        lines.push(
          `Note: ${parent} is not the game's Modules folder; it was added to this session's module dirs (set MB2_MODULE_DIRS to keep it). The game and editor only load modules from <game>/Modules, so link it there (no copy):`,
          gameDir ? `  mklink /J "${path.join(gameDir, "Modules", id)}" "${dir}"` : "  mklink /J \"<game>\\Modules\\<id>\" \"<module folder>\"",
        );
      }
      lines.push("Enable it in the launcher's Mods tab. Next: write_object / clone_object to add content.");
      return lines.join("\n") + footer(seq);
    },
  },
  {
    name: "edit_submodule",
    group: "edit",
    title: "Edit SubModule.xml",
    description:
      "Edits a writable module's SubModule.xml in place (formatting preserved): name/version/url/category, add or remove dependencies, register or unregister ModuleData XML files, add or remove DLL SubModule entries.",
    inputSchema: schema(
      {
        module: str("Writable module id."),
        name: str("New display name."),
        version: str("New version, e.g. v1.0.1."),
        url: str("Url value."),
        category: strEnum(["Singleplayer", "Multiplayer"], "ModuleCategory."),
        add_dependencies: strList("Add/update dependencies: 'Id', 'Id@v1.2.3', 'Id?' (optional)."),
        remove_dependencies: strList("Dependency ids to remove."),
        register_xmls: objList(
          "XML registrations to add. path is relative to ModuleData without extension (e.g. mymod_items or XSLT/MyMod_Items).",
          { id: str("XmlName id, e.g. Items"), path: str("Path under ModuleData without .xml/.xslt"), game_types: strList("Campaign, CampaignStoryMode, CustomGame, EditorGame, MultiplayerGame. Default: same as official modules.") },
          ["id", "path"],
        ),
        unregister_xmls: strList("Paths (as in XmlName path) to unregister; 'Id:path' to match a specific id."),
        add_dll: objList("DLL SubModule entries to add.", { name: str("SubModule name"), dll: str("DLL file name, e.g. MyMod.dll"), class_type: str("Full class name, e.g. MyMod.SubModule") }, ["dll", "class_type"]),
        remove_dll: strList("SubModule names or DLL names to remove."),
      },
      ["module"],
    ),
    handler: async (a, ctx) => {
      const mod = ctx.registry.requireWritable(a.req("module"));
      const lines: string[] = [];
      const { seq } = await withTx(ctx, "edit_submodule", mod, "edit SubModule.xml", (tx) => {
        const doc = new SubModuleDoc(path.join(mod.dir, "SubModule.xml"));
        if (a.has("name")) (doc.setValueElement("Name", a.req("name"), []), lines.push(`Name = ${a.str("name")}`));
        if (a.has("version")) (doc.setValueElement("Version", a.req("version"), ["Id", "Name"]), lines.push(`Version = ${a.str("version")}`));
        if (a.has("url")) (doc.setValueElement("Url", a.req("url"), ["ModuleType", "ModuleCategory", "DefaultModule", "Version"]), lines.push(`Url = ${a.str("url")}`));
        if (a.has("category")) (doc.setValueElement("ModuleCategory", a.req("category"), ["DefaultModule", "Version"]), lines.push(`ModuleCategory = ${a.str("category")}`));
        for (const d of parseDeps(a, "add_dependencies")) {
          const inst = ctx.registry.get(d.id);
          const version = d.version ?? inst?.version;
          const r = doc.setDependency(inst?.id ?? d.id, version, d.optional);
          lines.push(`${r} dependency ${inst?.id ?? d.id}${version ? ` ${version}` : ""}${d.optional ? " (optional)" : ""}${inst ? "" : " — WARNING: not installed"}`);
        }
        for (const id of a.list("remove_dependencies")) lines.push(doc.removeDependency(id) ? `removed dependency ${id}` : `dependency ${id} not found`);
        for (const x of a.objects("register_xmls")) {
          const id = String(x.id ?? "").trim();
          const p = String(x.path ?? "").trim().replace(/\\/g, "/").replace(/^ModuleData\//i, "").replace(/\.(xml|xslt)$/i, "");
          if (!id || !p) throw new Error("register_xmls entries need id and path.");
          if (p.split("/").includes("..") || /^[a-z]:/i.test(p) || p.startsWith("/")) throw new Error(`register_xmls path '${p}' must stay inside the module's ModuleData folder.`);
          const gt = Array.isArray(x.game_types) ? (x.game_types as unknown[]).map(String) : typeof x.game_types === "string" ? String(x.game_types).split(/[,\s]+/).filter(Boolean) : ctx.registry.defaultGameTypes(id);
          const exists = ["xml", "xslt"].some((ext) => fs.existsSync(path.join(mod.dir, "ModuleData", `${p}.${ext}`))) || fs.existsSync(path.join(mod.dir, "ModuleData", p));
          lines.push(doc.addXmlNode(id, p, gt) ? `registered ${id}:${p} [${gt.join(",")}]${exists ? "" : " — WARNING: file does not exist yet"}` : `${id}:${p} already registered`);
        }
        for (const spec of a.list("unregister_xmls")) {
          const m = /^([A-Za-z]+):(.+)$/.exec(spec);
          const n = doc.removeXmlNode(m ? m[1] : undefined, m ? m[2] : spec);
          lines.push(n ? `unregistered ${spec} (${n})` : `${spec} not registered`);
        }
        for (const x of a.objects("add_dll")) {
          const dll = String(x.dll ?? "").trim();
          const cls = String(x.class_type ?? x.classType ?? "").trim();
          if (!dll || !cls) throw new Error("add_dll entries need dll and class_type.");
          const name = String(x.name ?? dll.replace(/\.dll$/i, ""));
          lines.push(doc.addSubModule(name, /\.dll$/i.test(dll) ? dll : `${dll}.dll`, cls) ? `added SubModule ${name} (${dll})` : `SubModule ${dll} already present`);
        }
        for (const n of a.list("remove_dll")) lines.push(doc.removeSubModule(n) ? `removed SubModule ${n}` : `SubModule ${n} not found`);
        if (!doc.changed) {
          lines.push("Nothing changed.");
          return;
        }
        tx.write(doc.file, doc.serialize());
      });
      return lines.join("\n") + footer(seq);
    },
  },
  {
    name: "write_object",
    group: "edit",
    title: "Create or replace objects (XML)",
    description:
      "Writes one or more objects (e.g. <Item>, <CraftedItem>, <NPCCharacter>, <Culture>, <Faction>, <Kingdom>, <Settlement>, <MBPartyTemplate>) into a writable module. Replaces an object with the same tag+id in that module, otherwise appends it to the module's file for that data type (creating ModuleData/<mod>_<type>.xml and registering it in SubModule.xml). Runs the game's XSD check afterwards.",
    inputSchema: schema(
      {
        module: str("Writable module id."),
        xml: str("One or more object elements (a wrapping container like <Items>…</Items> is accepted). Use {=stringId}Text for names."),
        mode: strEnum(["upsert", "create", "replace"], "upsert (default), create (fail if exists), replace (fail if missing)."),
        file: str("Optional target file under ModuleData, e.g. mymod_weapons.xml (created and registered if needed)."),
        xml_id: str("Optional XmlName id when it cannot be inferred from the tag (e.g. Items, NPCCharacters)."),
        validate: bool("Run XSD validation after writing (default true)."),
      },
      ["module", "xml"],
    ),
    handler: async (a, ctx) => {
      const mod = ctx.registry.requireWritable(a.req("module"));
      const objects = parseSnippet(a.req("xml"));
      const mode = (a.str("mode") ?? "upsert") as "upsert" | "create" | "replace";
      if (!["upsert", "create", "replace"].includes(mode)) throw new Error("mode must be upsert, create or replace.");
      const { result: rep, seq } = await withTx(ctx, "write_object", mod, `write ${objects.map((o) => `${o.tag}.${o.id}`).join(", ")}`, (tx) =>
        writeObjects(ctx, tx, mod, objects, { mode, file: a.str("file"), xmlId: a.str("xml_id") }),
      );
      const out = [...rep.lines];
      const notes = analyzeWritten(ctx, ctx.registry.require(mod.id), objects);
      if (notes.length) out.push("", ...notes.map((n) => `note: ${n}`));
      if (a.bool("validate", true)) {
        const xsd = await xsdCheck(ctx, rep.xmlIds, mod.dir);
        out.push("", xsd.length ? xsd.slice(0, 40).join("\n") : "XSD check: OK");
      }
      return out.join("\n") + footer(seq);
    },
  },
  {
    name: "clone_object",
    group: "edit",
    title: "Copy an object into your module",
    description:
      "Copies an existing object (usually vanilla) into a writable module under a new id, optionally changing attributes — the fastest way to make a new weapon/troop/hero/culture based on an existing one. With new_id omitted the copy keeps the id and fully overrides the original. A plain 'name' gets a fresh {=id}.",
    inputSchema: schema(
      {
        source: str("Object to copy: Item.x, NPCCharacter.x, Culture.x, … or bare id."),
        module: str("Target writable module."),
        new_id: str("Id of the copy (omit to override the original with the same id)."),
        set: strMap("Attributes to change on the copy's root element, e.g. {\"name\": \"Royal Blade\", \"value\": \"5000\"}."),
        source_module: str("Copy this module's definition instead of the effective one."),
        file: str("Optional target file under ModuleData."),
        validate: bool("Run XSD validation after writing (default true)."),
      },
      ["source", "module"],
    ),
    handler: async (a, ctx) => {
      const mod = ctx.registry.requireWritable(a.req("module"));
      ctx.indexAll();
      const src = a.req("source");
      const res = ctx.index.lookup(src);
      let matches = res.matches;
      if (a.has("source_module")) {
        const sm = ctx.registry.require(a.req("source_module"));
        matches = matches.filter((o) => o.module === sm.id);
      }
      if (!matches.length) throw new Error(`${src} not found. Use search_objects.`);
      const families = new Set(matches.map((m) => `${refPrefixForTag(m.tag)}.${m.id}`));
      if (families.size > 1) throw new Error(`'${src}' is ambiguous (${[...families].join(", ")}); use Prefix.id.`);
      const def = effectiveDefinition(ctx, matches)!;
      const newId = a.str("new_id")?.trim() || undefined;
      if (!newId && def.module === mod.id) throw new Error("new_id is required when copying within the same module.");
      if (newId) {
        const clash = ctx.index.find(newId).filter((o) => refPrefixForTag(o.tag) === refPrefixForTag(def.tag));
        if (clash.length) throw new Error(`${refPrefixForTag(def.tag)}.${newId} already exists in ${clash.map((c) => c.module).join(", ")}; pick another new_id.`);
      }
      const { xml, notes } = prepareClone(ctx, def, newId, a.map("set"));
      const objects = parseSnippet(xml);
      const { result: rep, seq } = await withTx(ctx, "clone_object", mod, `clone ${def.tag}.${def.id} → ${newId ?? def.id}`, (tx) =>
        writeObjects(ctx, tx, mod, objects, { mode: newId ? "create" : "upsert", file: a.str("file"), xmlId: def.file.xmlIds[0] }),
      );
      const out = [`copied ${def.tag} '${def.id}' from ${def.module} (${def.file.rel}:${def.line})`, ...rep.lines, ...notes];
      const an = analyzeWritten(ctx, ctx.registry.require(mod.id), objects);
      if (an.length) out.push("", ...an.map((n) => `note: ${n}`));
      if (a.bool("validate", true)) {
        const xsd = await xsdCheck(ctx, rep.xmlIds, mod.dir);
        out.push("", xsd.length ? xsd.slice(0, 40).join("\n") : "XSD check: OK");
      }
      out.push("", "Result:", objects[0].xml.length > 6000 ? `${objects[0].xml.slice(0, 6000)}\n…` : objects[0].xml);
      return out.join("\n") + footer(seq);
    },
  },
  {
    name: "set_attributes",
    group: "edit",
    title: "Change attributes of your object",
    description:
      "Changes attributes of an object that lives in a writable module, editing the file in place. Use path to reach nested elements (mini XPath): ItemComponent/Weapon, skills/skill[@id='OneHanded'], Equipments/EquipmentRoster[1]/equipment[@slot='Item0']. For objects owned by other modules use xslt_patch.",
    inputSchema: schema(
      {
        module: str("Writable module that defines the object."),
        ref: str("Object: Item.x, NPCCharacter.x, … or bare id."),
        set: strMap("Attributes to set, e.g. {\"weight\": \"2.5\", \"value\": \"1200\"}."),
        remove: strList("Attribute names to remove."),
        path: str("Optional path to nested element(s) inside the object."),
        all: bool("Apply to every element matched by path (default false = must match exactly one)."),
        validate: bool("Run XSD validation after writing (default true)."),
      },
      ["module", "ref"],
    ),
    handler: async (a, ctx) => {
      const mod = ctx.registry.requireWritable(a.req("module"));
      const set = a.map("set");
      const unset = a.list("remove");
      if (!set.length && !unset.length) throw new Error("Nothing to change: pass set and/or remove.");
      const { result: r, seq } = await withTx(ctx, "set_attributes", mod, `set attributes on ${a.req("ref")}`, (tx) =>
        setAttributes(ctx, tx, mod, a.req("ref"), a.str("path") ?? "", set, unset, a.bool("all", false)),
      );
      const out = [...r.lines];
      if (a.bool("validate", true) && r.xmlId) {
        const xsd = await xsdCheck(ctx, new Map([[r.file, r.xmlId]]), mod.dir);
        out.push(xsd.length ? xsd.slice(0, 30).join("\n") : "XSD check: OK");
      }
      out.push("", r.xml.length > 5000 ? `${r.xml.slice(0, 5000)}\n…` : r.xml);
      return out.join("\n") + footer(seq);
    },
  },
  {
    name: "delete_object",
    group: "edit",
    title: "Delete an object from your module",
    description: "Removes an object definition from a writable module's XML (all definitions of that id in the module).",
    inputSchema: schema({ module: str("Writable module id."), ref: str("Object: Item.x, NPCCharacter.x, … or bare id.") }, ["module", "ref"]),
    destructive: true,
    handler: async (a, ctx) => {
      const mod = ctx.registry.requireWritable(a.req("module"));
      const { result: lines, seq } = await withTx(ctx, "delete_object", mod, `delete ${a.req("ref")}`, (tx) => deleteObject(ctx, tx, mod, a.req("ref")));
      ctx.indexAll();
      const left = ctx.index.referencesTo(a.req("ref")).filter((o) => o.module === mod.id);
      if (left.length) lines.push(`warning: still referenced by ${left.map((o) => `${o.tag}.${o.id}`).slice(0, 10).join(", ")}`);
      return lines.join("\n") + footer(seq);
    },
  },
  {
    name: "xslt_patch",
    group: "edit",
    title: "Patch another module's object (XSLT)",
    description:
      "Changes an object owned by vanilla or another mod without copying it, by adding a rule to your module's XSLT (ModuleData/XSLT/<mod>_<XmlId>.xslt, registered automatically — the same mechanism the official DLC uses). One call per target node; repeated calls merge. Operations: set attributes, remove attributes, remove the node, replace it, append child XML, or clear the rule. Shows a before/after diff computed with the game's XSLT engine.",
    inputSchema: schema(
      {
        module: str("Your writable module."),
        target: str("Object to patch: Item.x, NPCCharacter.x, Culture.empire, Settlement.town_EN1, Faction.clan_x, …"),
        path: str("Optional nested element inside the target (mini XPath), e.g. ItemComponent/Weapon or skills/skill[@id='Bow']."),
        set: strMap("Attributes to set/add, e.g. {\"weight\": \"1.5\"}."),
        remove_attributes: strList("Attribute names to delete."),
        remove: bool("Delete the target node entirely."),
        replace_xml: str("Replace the target node with this XML."),
        append_xml: str("Append this XML as child element(s) of the target node."),
        clear: bool("Remove this module's existing rule for the target instead."),
        force: bool("Overwrite a hand-written rule with the same match."),
        preview: bool("Show the before/after diff (default true)."),
        game_type: strEnum(["Campaign", "CampaignStoryMode", "CustomGame", "EditorGame"], "Game type used for the preview (default Campaign)."),
      },
      ["module", "target"],
    ),
    handler: async (a, ctx) => {
      const mod = ctx.registry.requireWritable(a.req("module"));
      const req = {
        set: a.map("set"),
        unset: a.list("remove_attributes"),
        remove: a.bool("remove", false),
        replace: a.str("replace_xml") || null,
        append: a.has("append_xml") ? [a.req("append_xml")] : [],
      };
      for (const x of [req.replace, ...req.append]) if (x) wrapFragment(x);
      const { result: r, seq } = await withTx(ctx, "xslt_patch", mod, `xslt patch ${a.req("target")}`, (tx) =>
        xsltPatch(ctx, tx, mod, a.req("target"), { path: a.str("path") ?? "", req, clear: a.bool("clear", false), force: a.bool("force", false) }),
      );
      const out = [...r.lines];
      if (a.bool("preview", true)) {
        const fresh = ctx.registry.require(mod.id);
        const p = await previewXslt(ctx, fresh, r.xmlId, [r.target], a.str("game_type") ?? "Campaign");
        out.push("", p.text);
        if (!p.ok && /failed/i.test(p.text)) out.push("", `The patch breaks loading; fix it or run undo_edit seq=${seq}.`);
      }
      return out.join("\n") + footer(seq);
    },
  },
  {
    name: "xslt_preview",
    group: "edit",
    title: "Preview XSLT patches",
    description:
      "Runs the game's merge + XSLT pipeline (System.Xml XslCompiledTransform, like the game) for a module and shows before/after diffs of every object its XSLT rules target (or only `targets`). Also reveals XSLT errors that would break loading.",
    inputSchema: schema(
      {
        module: str("Module whose XSLT to preview (any module, read-only is fine)."),
        xml_id: str("Limit to one XmlName id, e.g. Items."),
        targets: strList("Specific objects to diff, e.g. Item.x or Culture.empire (default: everything the rules target)."),
        game_type: strEnum(["Campaign", "CampaignStoryMode", "CustomGame", "EditorGame"], "Game type (default Campaign)."),
      },
      ["module"],
    ),
    readOnly: true,
    handler: async (a, ctx) => {
      const mod = ctx.registry.require(a.req("module"));
      const xmlIdFilter = a.str("xml_id");
      const groups = patchedTargets(ctx, mod, xmlIdFilter);
      const wanted = a.list("targets");
      if (wanted.length) {
        groups.clear();
        for (const t of wanted) {
          const res = ctx.index.lookup(t);
          const def = res.matches.find((o) => o.module !== mod.id) ?? res.matches[0];
          if (!def) throw new Error(`${t} not found.`);
          const xid = xmlIdFilter ?? def.file.xmlIds[0];
          if (!xid) throw new Error(`${t} is in an unregistered file.`);
          const list = groups.get(xid) ?? [];
          list.push({ tag: def.tag, id: def.id, depth: def.depth, parentTag: def.parentTag });
          groups.set(xid, list);
        }
      }
      if (!groups.size) return `${mod.id} has no XSLT rules targeting objects by id${xmlIdFilter ? ` for ${xmlIdFilter}` : ""}. Pass targets=[...] to diff specific objects.`;
      const out: string[] = [];
      for (const [xid, targets] of groups) {
        if (!targets.length) continue;
        const shown = targets.slice(0, 25);
        const p = await previewXslt(ctx, mod, xid, shown, a.str("game_type") ?? "Campaign");
        out.push(p.text);
        if (targets.length > shown.length) out.push(`(${targets.length - shown.length} more targets not shown; pass targets=[...])`);
        out.push("");
      }
      return out.join("\n").trimEnd();
    },
  },
  {
    name: "validate_module",
    group: "core",
    title: "Validate a module",
    description:
      "Checks a module like the game would: SubModule.xml (ids, versions, dependencies, DLLs), every registered XML (exists, well-formed, game XSD), XSLT compiles, duplicate ids, unresolved references (Item.x, NPCCharacter.x …) against its dependencies, unregistered files, and localization (missing/conflicting {=ids}, translation coverage).",
    inputSchema: schema(
      {
        module: str("Module id."),
        xsd: bool("Run XSD/XSLT checks through .NET (default true)."),
        refs: bool("Check references (default true)."),
        l10n: bool("Check localization (default true)."),
      },
      ["module"],
    ),
    readOnly: true,
    handler: async (a, ctx) => {
      const mod = ctx.registry.require(a.req("module"));
      const issues = await validateModule(ctx, mod, { xsd: a.bool("xsd", true), refs: a.bool("refs", true), l10n: a.bool("l10n", true) });
      return `Validation of ${mod.id} (${mod.dir})\n${formatIssues(issues)}`;
    },
  },
];
