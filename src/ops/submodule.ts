import fs from "node:fs";
import path from "node:path";
import type { ModuleInfo, ModuleRegistry } from "../model/modules.js";
import { encodeText, fixXmlDeclarationEncoding, readTextFile, type TextEncodingKind } from "../util/text.js";
import { applyEdits, detectIndentUnit, insertAfterEdit, insertChildEdit, removeElementEdit, setAttributesEdits, type Edit } from "../xml/edit.js";
import { childElements, escapeAttr, firstChild, getAttr, parseTree, type XElem } from "../xml/scanner.js";
import { checkWellFormed } from "../xml/wellformed.js";
import type { Transaction } from "./history.js";

/** Mutable in-memory SubModule.xml that re-parses after every edit (files are tiny). */
export class SubModuleDoc {
  text: string;
  encoding: TextEncodingKind;
  eol: "\r\n" | "\n";
  root!: XElem;
  unit = "\t";
  changed = false;

  constructor(readonly file: string) {
    const tf = readTextFile(file);
    this.text = tf.text;
    this.encoding = tf.encoding;
    this.eol = tf.eol;
    this.reparse();
  }

  private reparse(): void {
    const { root, errors } = parseTree(this.text, 5);
    if (!root || root.name !== "Module") throw new Error(`Cannot edit ${this.file}: ${errors[0]?.message ?? "root element is not <Module>"}`);
    this.root = root;
    this.unit = detectIndentUnit(this.text, root);
  }

  apply(edits: Edit[]): void {
    if (!edits.length) return;
    this.text = applyEdits(this.text, edits);
    this.changed = true;
    this.reparse();
  }

  child(name: string): XElem | undefined {
    return firstChild(this.root, name, true);
  }

  /** Returns the container, creating it (after the first existing sibling in `after`) when missing. */
  container(name: string, after: string[]): XElem {
    let c = this.child(name);
    if (c) return c;
    let anchor: XElem | undefined;
    for (const a of after) {
      const el = this.child(a);
      if (el) anchor = el;
    }
    const xml = `<${name}>${this.eol}</${name}>`;
    this.apply([anchor ? insertAfterEdit(this.text, anchor, xml, this.layout()) : insertChildEdit(this.text, this.root, xml, this.layout())]);
    c = this.child(name)!;
    return c;
  }

  layout(): { eol: string; unit: string } {
    return { eol: this.eol, unit: this.unit };
  }

  /** Sets <Name value="..."/> style properties. */
  setValueElement(name: string, value: string, after: string[]): void {
    const el = this.child(name);
    if (el) {
      this.apply(setAttributesEdits(this.text, el, [["value", value]]));
      return;
    }
    let anchor: XElem | undefined;
    for (const a of after) {
      const x = this.child(a);
      if (x) anchor = x;
    }
    const xml = `<${name} value="${escapeAttr(value)}" />`;
    this.apply([anchor ? insertAfterEdit(this.text, anchor, xml, this.layout()) : insertChildEdit(this.text, this.root, xml, this.layout())]);
  }

  serialize(): Buffer {
    const problems = checkWellFormed(this.text, 3);
    if (problems.length) throw new Error(`Internal error: edited SubModule.xml is not well-formed (line ${problems[0].line}: ${problems[0].message}); nothing was written.`);
    return encodeText(fixXmlDeclarationEncoding(this.text, this.encoding), this.encoding);
  }

  // ---- high level operations -------------------------------------------------------------

  findXmlNode(id: string, p: string): XElem | undefined {
    const xmls = this.child("Xmls");
    for (const node of childElements(xmls, "XmlNode")) {
      const xn = firstChild(node, "XmlName");
      if (getAttr(xn, "id") === id && normPath(getAttr(xn, "path") ?? "") === normPath(p)) return node;
    }
    return undefined;
  }

  addXmlNode(id: string, p: string, gameTypes: string[]): boolean {
    if (this.findXmlNode(id, p)) return false;
    const xmls = this.container("Xmls", ["Name", "Id", "Version", "DefaultModule", "ModuleCategory", "ModuleType", "Url", "DependedModules", "DependedModuleMetadatas", "ModulesToLoadAfterThis", "IncompatibleModules", "SubModules"]);
    const lines = ["<XmlNode>", `\t<XmlName id="${escapeAttr(id)}" path="${escapeAttr(p)}" />`];
    if (gameTypes.length) {
      lines.push("\t<IncludedGameTypes>");
      for (const g of gameTypes) lines.push(`\t\t<GameType value="${escapeAttr(g)}" />`);
      lines.push("\t</IncludedGameTypes>");
    }
    lines.push("</XmlNode>");
    this.apply([insertChildEdit(this.text, xmls, lines.join("\n"), this.layout())]);
    return true;
  }

  removeXmlNode(id: string | undefined, p: string): number {
    let removed = 0;
    for (;;) {
      const xmls = this.child("Xmls");
      const node = childElements(xmls, "XmlNode").find((n) => {
        const xn = firstChild(n, "XmlName");
        return normPath(getAttr(xn, "path") ?? "") === normPath(p) && (!id || getAttr(xn, "id") === id);
      });
      if (!node) break;
      this.apply([removeElementEdit(this.text, node)]);
      removed++;
    }
    return removed;
  }

  setDependency(id: string, version: string | undefined, optional: boolean): "added" | "updated" {
    const deps = this.container("DependedModules", ["Name", "Id", "Version", "RequiredBaseVersion", "DefaultModule", "ModuleCategory", "ModuleType", "Url"]);
    const existing = childElements(deps, "DependedModule").find((d) => (getAttr(d, "Id") ?? "").toLowerCase() === id.toLowerCase());
    if (existing) {
      const changes: Array<[string, string | null]> = [["Optional", optional ? "true" : "false"]];
      if (version) changes.push(["DependentVersion", version]);
      this.apply(setAttributesEdits(this.text, existing, changes));
      return "updated";
    }
    const attrs = [`Id="${escapeAttr(id)}"`];
    if (version) attrs.push(`DependentVersion="${escapeAttr(version)}"`);
    attrs.push(`Optional="${optional ? "true" : "false"}"`);
    this.apply([insertChildEdit(this.text, deps, `<DependedModule ${attrs.join(" ")} />`, this.layout())]);
    return "added";
  }

  removeDependency(id: string): boolean {
    let removed = false;
    for (const containerName of ["DependedModules", "DependedModuleMetadatas"]) {
      for (;;) {
        const c = this.child(containerName);
        const el = childElements(c).find((d) => (getAttr(d, "Id") ?? getAttr(d, "id") ?? "").toLowerCase() === id.toLowerCase());
        if (!el) break;
        this.apply([removeElementEdit(this.text, el)]);
        removed = true;
      }
    }
    return removed;
  }

  addSubModule(name: string, dll: string, classType: string): boolean {
    const subs = this.container("SubModules", ["DependedModules", "DependedModuleMetadatas", "ModulesToLoadAfterThis", "IncompatibleModules", "ModuleType", "ModuleCategory", "Version"]);
    if (childElements(subs, "SubModule").some((s) => getAttr(firstChild(s, "DLLName"), "value")?.toLowerCase() === dll.toLowerCase())) return false;
    const xml = [
      "<SubModule>",
      `\t<Name value="${escapeAttr(name)}" />`,
      `\t<DLLName value="${escapeAttr(dll)}" />`,
      `\t<SubModuleClassType value="${escapeAttr(classType)}" />`,
      "\t<Tags>",
      '\t\t<Tag key="DedicatedServerType" value="none" />',
      '\t\t<Tag key="IsNoRenderModeElement" value="false" />',
      "\t</Tags>",
      "</SubModule>",
    ].join("\n");
    this.apply([insertChildEdit(this.text, subs, xml, this.layout())]);
    return true;
  }

  removeSubModule(nameOrDll: string): boolean {
    const subs = this.child("SubModules");
    const key = nameOrDll.toLowerCase();
    const el = childElements(subs, "SubModule").find(
      (s) => getAttr(firstChild(s, "DLLName"), "value")?.toLowerCase() === key || getAttr(firstChild(s, "Name"), "value")?.toLowerCase() === key,
    );
    if (!el) return false;
    this.apply([removeElementEdit(this.text, el)]);
    return true;
  }
}

export function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.(xml|xslt)$/i, "").toLowerCase();
}

/** Registers a ModuleData file in SubModule.xml (inside the given transaction). */
export function ensureXmlNodeRegistered(tx: Transaction, mod: ModuleInfo, registry: ModuleRegistry, xmlId: string, relNoExt: string): boolean {
  const doc = new SubModuleDoc(path.join(mod.dir, "SubModule.xml"));
  const added = doc.addXmlNode(xmlId, relNoExt, registry.defaultGameTypes(xmlId));
  if (added) tx.write(doc.file, doc.serialize());
  return added;
}

// ---- module scaffolding -----------------------------------------------------------------------

export interface CreateModuleOptions {
  id: string;
  name: string;
  version: string;
  category: string;
  deps: Array<{ id: string; version?: string; optional: boolean }>;
  withCSharp: boolean;
  gameDir: string | null;
  gameVersion: string;
}

export function buildSubModuleXml(o: CreateModuleOptions): string {
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<Module>",
    `\t<Name value="${escapeAttr(o.name)}" />`,
    `\t<Id value="${escapeAttr(o.id)}" />`,
    `\t<Version value="${escapeAttr(o.version)}" />`,
    '\t<DefaultModule value="false" />',
    `\t<ModuleCategory value="${escapeAttr(o.category)}" />`,
    '\t<ModuleType value="Community" />',
    "\t<DependedModules>",
  ];
  for (const d of o.deps) {
    lines.push(`\t\t<DependedModule Id="${escapeAttr(d.id)}"${d.version ? ` DependentVersion="${escapeAttr(d.version)}"` : ""} Optional="${d.optional ? "true" : "false"}" />`);
  }
  lines.push("\t</DependedModules>");
  if (o.withCSharp) {
    const ns = csharpIdentifier(o.id);
    lines.push(
      "\t<SubModules>",
      "\t\t<SubModule>",
      `\t\t\t<Name value="${escapeAttr(o.id)}" />`,
      `\t\t\t<DLLName value="${escapeAttr(o.id)}.dll" />`,
      `\t\t\t<SubModuleClassType value="${escapeAttr(ns)}.SubModule" />`,
      "\t\t\t<Tags>",
      '\t\t\t\t<Tag key="DedicatedServerType" value="none" />',
      '\t\t\t\t<Tag key="IsNoRenderModeElement" value="false" />',
      "\t\t\t</Tags>",
      "\t\t</SubModule>",
      "\t</SubModules>",
    );
  } else lines.push("\t<SubModules />");
  lines.push("\t<Xmls />", "</Module>", "");
  return lines.join("\r\n");
}

export function csharpIdentifier(id: string): string {
  let s = id.replace(/[^A-Za-z0-9_.]/g, "_").replace(/\.{2,}/g, ".").replace(/^\.|\.$/g, "");
  s = s
    .split(".")
    .map((p) => (/^[0-9]/.test(p) ? `_${p}` : p || "_"))
    .join(".");
  return s || "MyMod";
}

export function buildCsproj(o: CreateModuleOptions): string {
  const game = (o.gameDir ?? "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Mount & Blade II Bannerlord").replace(/\//g, "\\");
  const asm = csharpIdentifier(o.id);
  return [
    '<Project Sdk="Microsoft.NET.Sdk">',
    "",
    "  <PropertyGroup>",
    "    <TargetFramework>net472</TargetFramework>",
    "    <LangVersion>latest</LangVersion>",
    "    <Nullable>disable</Nullable>",
    "    <Platforms>x64</Platforms>",
    "    <PlatformTarget>x64</PlatformTarget>",
    `    <AssemblyName>${escapeAttr(o.id)}</AssemblyName>`,
    `    <RootNamespace>${asm}</RootNamespace>`,
    `    <ModuleId>${escapeAttr(o.id)}</ModuleId>`,
    "    <!-- Override with the BANNERLORD_GAME_DIR environment variable or /p:GameFolder=... -->",
    "    <GameFolder Condition=\"'$(GameFolder)' == '' and '$(BANNERLORD_GAME_DIR)' != ''\">$(BANNERLORD_GAME_DIR)</GameFolder>",
    `    <GameFolder Condition="'$(GameFolder)' == ''">${escapeAttr(game)}</GameFolder>`,
    "    <!-- The DLL is written straight into <Module>/bin/Win64_Shipping_Client -->",
    "    <OutputPath>$(MSBuildProjectDirectory)\\..\\bin\\Win64_Shipping_Client\\</OutputPath>",
    "    <AppendTargetFrameworkToOutputPath>false</AppendTargetFrameworkToOutputPath>",
    "    <AppendRuntimeIdentifierToOutputPath>false</AppendRuntimeIdentifierToOutputPath>",
    "    <CopyLocalLockFileAssemblies>false</CopyLocalLockFileAssemblies>",
    "    <GenerateDocumentationFile>false</GenerateDocumentationFile>",
    "  </PropertyGroup>",
    "",
    "  <ItemGroup>",
    "    <!-- Lets `dotnet build` compile net472 without a targeting pack installed. -->",
    '    <PackageReference Include="Microsoft.NETFramework.ReferenceAssemblies" Version="1.0.3" PrivateAssets="all" />',
    "  </ItemGroup>",
    "",
    "  <ItemGroup>",
    "    <!-- TaleWorlds.Native.dll is a native (C++) library and must not be referenced. -->",
    '    <Reference Include="$(GameFolder)\\bin\\Win64_Shipping_Client\\TaleWorlds.*.dll" Exclude="$(GameFolder)\\bin\\Win64_Shipping_Client\\TaleWorlds.Native.dll">',
    "      <Private>false</Private>",
    "    </Reference>",
    '    <Reference Include="$(GameFolder)\\Modules\\Native\\bin\\Win64_Shipping_Client\\TaleWorlds.*.dll">',
    "      <Private>false</Private>",
    "    </Reference>",
    '    <Reference Include="$(GameFolder)\\Modules\\SandBox\\bin\\Win64_Shipping_Client\\*.dll">',
    "      <Private>false</Private>",
    "    </Reference>",
    '    <Reference Include="$(GameFolder)\\Modules\\SandBoxCore\\bin\\Win64_Shipping_Client\\*.dll">',
    "      <Private>false</Private>",
    "    </Reference>",
    '    <Reference Include="$(GameFolder)\\Modules\\StoryMode\\bin\\Win64_Shipping_Client\\*.dll">',
    "      <Private>false</Private>",
    "    </Reference>",
    "  </ItemGroup>",
    "",
    "</Project>",
    "",
  ].join("\r\n");
}

export function buildSubModuleCs(o: CreateModuleOptions): string {
  const ns = csharpIdentifier(o.id);
  // C# 5 compatible on purpose (compiles with any toolchain, including csc from .NET Framework).
  return [
    "using TaleWorlds.Core;",
    "using TaleWorlds.Library;",
    "using TaleWorlds.Localization;",
    "using TaleWorlds.MountAndBlade;",
    "",
    `namespace ${ns}`,
    "{",
    "    public class SubModule : MBSubModuleBase",
    "    {",
    "        protected override void OnSubModuleLoad()",
    "        {",
    "            base.OnSubModuleLoad();",
    "        }",
    "",
    "        protected override void OnBeforeInitialModuleScreenSetAsRoot()",
    "        {",
    "            base.OnBeforeInitialModuleScreenSetAsRoot();",
    `            InformationManager.DisplayMessage(new InformationMessage(new TextObject("{=${ns.replace(/\./g, "_")}_loaded}${o.name.replace(/[{}"\\]/g, "")} loaded").ToString()));`,
    "        }",
    "",
    "        protected override void OnGameStart(Game game, IGameStarter gameStarterObject)",
    "        {",
    "            base.OnGameStart(game, gameStarterObject);",
    "            // Register campaign behaviors here, e.g.:",
    "            // var starter = gameStarterObject as TaleWorlds.CampaignSystem.CampaignGameStarter;",
    "            // if (starter != null) starter.AddBehavior(new MyCampaignBehavior());",
    "        }",
    "    }",
    "}",
    "",
  ].join("\r\n");
}

export function validateModuleId(id: string): string | null {
  if (!id) return "Module id is required.";
  if (!/^[A-Za-z0-9_.\-]+$/.test(id)) return "Use only letters, digits, '_', '-' and '.' in the module id (it is also the folder name).";
  if (id.length > 64) return "Module id is too long.";
  return null;
}

export function moduleDirFree(dir: string): boolean {
  if (!fs.existsSync(dir)) return true;
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}
