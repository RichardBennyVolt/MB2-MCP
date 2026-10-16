import { browseTools } from "./browse.js";
import type { ToolDef, ToolGroup } from "./common.js";
import { editTools } from "./edit.js";
import { l10nTools } from "./l10n.js";
import { miscTools } from "./misc.js";
import { playTools } from "./play.js";
import { sceneTools } from "./scene.js";

export const ALL_TOOLS: ToolDef[] = [...browseTools, ...editTools, ...l10nTools, ...sceneTools, ...playTools, ...miscTools];

export const TOOL_GROUPS: ToolGroup[] = ["core", "edit", "l10n", "scene", "assets", "editor", "logs"];

/** Tools enabled by MB2_TOOLSETS (comma list of groups; "all" or empty = everything). */
export function enabledTools(toolsets: string[]): ToolDef[] {
  if (!toolsets.length || toolsets.includes("all")) return ALL_TOOLS;
  const want = new Set(toolsets);
  return ALL_TOOLS.filter((t) => want.has(t.group));
}

export type { ToolDef };
