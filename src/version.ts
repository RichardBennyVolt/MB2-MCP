export const VERSION = "0.3.0";

export const WORKFLOW = [
  "Workflow:",
  "1. list_modules → pick your module or create_module (official and Steam Workshop modules are read-only).",
  "2. search_objects / get_object / find_references to study existing data; describe_schema shows valid attributes (game XSD + real values).",
  "3. Add content with write_object (XML) or clone_object (copy an existing object under a new id); change your own objects with set_attributes / delete_object.",
  "4. Change vanilla or other mods without copying them: xslt_patch (generates ModuleData/XSLT/*.xslt like the official DLC does) and check with xslt_preview.",
  "5. Scenes: scene_list / scene_info / scene_entities to read, scene_edit / scene_create / scene_settings to change files; prefab_search and asset_search find placeable prefabs and meshes; asset_import copies FBX/textures into AssetSources (the editor converts them via Resource Browser → Import new asset: textures/materials first, restart the editor, then FBX); asset_status checks the converted packages (meshes without materials stall the editor at startup).",
  "6. Live editing: editor_bridge_install once, editor_launch, poll editor_status until 'edit mode ON' (it also shows message boxes blocking the game; editor_command action=dismiss_dialogs answers them), then scene_* with live=true and editor_command (screenshot, console, raycast) act on the scene open in the Modding Kit editor (save there with Ctrl+S). editor_play plays a saved scene; mission walks the player along a route with the game's AI movement (evidence of a walkable route), uses objects; navmesh_query asks the engine's path finder; editor_camera reads/moves the viewport camera.",
  "7. validate_module; translations with l10n_scan → l10n_status → l10n_set; read_logs after testing; edit_history / undo_edit revert any change made through this server.",
].join("\n");

export const INSTRUCTIONS = `Tools for editing Mount & Blade II: Bannerlord mods (modules in <game>/Modules).
Key facts:
- A module = folder with SubModule.xml. Data lives in ModuleData/*.xml and is only loaded when registered in SubModule.xml <Xmls> (XmlName id = data type such as Items, NPCCharacters, SPCultures, Factions (clans), Kingdoms, Settlements, partyTemplates, Heroes, GameText). The write tools register files automatically.
- Objects reference each other as 'Prefix.id': Item.x (Item and CraftedItem), NPCCharacter.x, Hero.x, Faction.x, Kingdom.x, Culture.x, Settlement.x, PartyTemplate.x, CraftingPiece.x, EquipmentRoster.x, BodyProperty.x, SkillSet.x.
- Defining an object with an existing id replaces it completely; for partial changes to vanilla/other mods use xslt_patch.
- Player-facing text uses {=stringId}Text; keep ids unique; translations go to ModuleData/Languages/<lang>/ via l10n_set.
- Scenes are SceneObj/<name>/scene.xscene (+ atmosphere.xml, terrain.bin, navmesh.bin). Entities place prefabs (prefab=…) or meta meshes; rotations are radians in files, the tools take degrees by default.
- Never edit official (TaleWorlds) or Workshop modules; the server refuses. Every file write is backed up (edit_history / undo_edit). Live editor changes must be saved in the editor (Ctrl+S).
${WORKFLOW}`;
