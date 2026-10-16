# Tool reference

Generated from the tool definitions of mb2-mcp 0.3.0 (`npm run docs`). 43 tools in 7 groups; `MB2_TOOLSETS` selects groups.

## Browse & validate (`core`)

### `game_info` · read-only

Start here. Shows the detected Mount & Blade II: Bannerlord install, game version, module folders, which modules are writable, the launcher's enabled mods, index/validation status and the recommended editing workflow.

_No parameters._

### `list_modules` · read-only

Lists installed modules (official, Steam Workshop, your own) with id, version, flags (official / writable / workshop / enabled in launcher) and folder. filter: all | official | mods | writable | workshop | enabled.

| Parameter | Type | Description |
|---|---|---|
| `filter` | `all` \| `official` \| `mods` \| `writable` \| `workshop` \| `enabled` | Which modules to show (default all). |
| `query` | string | Optional substring of id or name. |

### `module_info` · read-only

Details of one module: SubModule.xml fields, dependencies (installed versions), DLL entries, every <Xmls> registration with its resolved files and object counts, XSLT patches, unregistered files and language files.

| Parameter | Type | Description |
|---|---|---|
| `module` **(required)** | string | Module id (e.g. MyMod, Native, SandBoxCore). |

### `list_types` · read-only

Summarizes game data by XmlName id (Items, NPCCharacters, SPCultures, Factions, Kingdoms, Settlements, partyTemplates, …) with the object tags and counts per module. Use it to learn what exists before searching.

| Parameter | Type | Description |
|---|---|---|
| `module` | string | Optional module filter: an id, comma list, or official \| mods \| writable \| workshop. |

### `search_objects` · read-only

Searches every module's XML objects (items, troops, heroes, clans, kingdoms, settlements, cultures, crafting pieces, party templates, strings, …) by id / name and attribute filters. Chinese queries also match the 简体中文 names. Returns 'Tag.id "Name" — module file:line | key attributes'.

| Parameter | Type | Description |
|---|---|---|
| `query` | string | Substring of id or name (case-insensitive), or /regex/. Optional when type/where is given. |
| `type` | string | Tag or reference prefix, e.g. Item (includes CraftedItem), NPCCharacter, Hero, Faction, Kingdom, Settlement, Culture, PartyTemplate, CraftingPiece. Comma list allowed. |
| `module` | string | Module filter: id, comma list, official \| mods \| writable \| workshop. Default: all. |
| `where` | string[] | Attribute filters on the object element: culture=Culture.empire, Type=OneHandedWeapon, level>20, is_hero=true, name~sword, tier?, !culture |
| `lang` | string | Also show/match translated names in this language (CNs, zh, 简体中文, RU, …). |
| `limit` | integer | Max results (default 30, max 200). |
| `offset` | integer | Skip this many results (paging). |

### `get_object` · read-only

Returns the XML of a game object, e.g. ref='Item.empire_sword_1_t2', 'NPCCharacter.imperial_recruit', 'Culture.empire' or a bare id. Shows which module's definition wins (load order), other definitions, XSLT patches that touch it and the absolute file path.

| Parameter | Type | Description |
|---|---|---|
| `ref` **(required)** | string | Object reference 'Prefix.id' (Item.x, NPCCharacter.x, Faction.x, …) or a bare id. |
| `module` | string | Only show the definition from this module. |
| `all_definitions` | boolean | Show the XML of every definition, not only the effective one (default false). |
| `lang` | string | Show the translated name in this language (e.g. CNs). |

### `find_references` · read-only

Lists objects that reference a given object (e.g. which troops carry Item.x, which troops upgrade into NPCCharacter.y, which settlements belong to Faction.z). Accepts 'Prefix.id' or a bare id.

| Parameter | Type | Description |
|---|---|---|
| `ref` **(required)** | string | Referenced object: Item.x, NPCCharacter.x, Culture.x, Faction.x, … or bare id. |
| `module` | string | Only report referencing objects from these modules (id, comma list, official, mods…). |
| `limit` | integer | Max results (default 50). |

### `describe_schema` · read-only

Explains which elements/attributes are valid, from the game's own XSD files (XmlSchemas folder) plus real values observed in official data. Use before writing XML. No args: list XmlName ids. xml_id only: root and object elements. element (+path for nested ones, e.g. element=Weapon path=Item/ItemComponent/Weapon): attributes with types/enums and children.

| Parameter | Type | Description |
|---|---|---|
| `xml_id` | string | XmlName id, e.g. Items, NPCCharacters, SPCultures, Factions, Kingdoms, Settlements, partyTemplates, CraftingPieces, Heroes, GameText. |
| `element` | string | Element name, e.g. Item, CraftedItem, NPCCharacter, Culture, Settlement, Weapon, equipment. |
| `path` | string | Optional path suffix to disambiguate nested elements, e.g. Item/ItemComponent/Weapon. |
| `observed` | boolean | Also show attribute values seen in official data (default true). |

### `validate_module` · read-only

Checks a module like the game would: SubModule.xml (ids, versions, dependencies, DLLs), every registered XML (exists, well-formed, game XSD), XSLT compiles, duplicate ids, unresolved references (Item.x, NPCCharacter.x …) against its dependencies, unregistered files, and localization (missing/conflicting {=ids}, translation coverage).

| Parameter | Type | Description |
|---|---|---|
| `module` **(required)** | string | Module id. |
| `xsd` | boolean | Run XSD/XSLT checks through .NET (default true). |
| `refs` | boolean | Check references (default true). |
| `l10n` | boolean | Check localization (default true). |

## Edit game data (`edit`)

### `create_module`

Scaffolds a new module folder with SubModule.xml (dependencies on the installed official modules) and ModuleData/. Optional C# project (Source/<id>.csproj + SubModule.cs that builds into bin/Win64_Shipping_Client). Default location: <game>/Modules.

| Parameter | Type | Description |
|---|---|---|
| `module_id` **(required)** | string | Module id = folder name (letters, digits, _ - .), e.g. MyArmory. |
| `name` | string | Display name in the launcher (default = id). |
| `version` | string | Version like v1.0.0 (default v1.0.0). |
| `location` | string | Parent folder for the module (default <game>/Modules). Outside Modules the game will not see it. |
| `dependencies` | string[] | Dependencies as 'Id', 'Id@v1.2.3' or 'Id?' (optional). Default: Native, SandBoxCore, Sandbox, StoryMode?, CustomBattle? at the installed game version. |
| `category` | `Singleplayer` \| `Multiplayer` | ModuleCategory (default Singleplayer). |
| `with_csharp` | boolean | Also create a C# project skeleton (default false). |

### `edit_submodule`

Edits a writable module's SubModule.xml in place (formatting preserved): name/version/url/category, add or remove dependencies, register or unregister ModuleData XML files, add or remove DLL SubModule entries.

| Parameter | Type | Description |
|---|---|---|
| `module` **(required)** | string | Writable module id. |
| `name` | string | New display name. |
| `version` | string | New version, e.g. v1.0.1. |
| `url` | string | Url value. |
| `category` | `Singleplayer` \| `Multiplayer` | ModuleCategory. |
| `add_dependencies` | string[] | Add/update dependencies: 'Id', 'Id@v1.2.3', 'Id?' (optional). |
| `remove_dependencies` | string[] | Dependency ids to remove. |
| `register_xmls` | object[] | XML registrations to add. path is relative to ModuleData without extension (e.g. mymod_items or XSLT/MyMod_Items). |
| `unregister_xmls` | string[] | Paths (as in XmlName path) to unregister; 'Id:path' to match a specific id. |
| `add_dll` | object[] | DLL SubModule entries to add. |
| `remove_dll` | string[] | SubModule names or DLL names to remove. |

### `write_object`

Writes one or more objects (e.g. <Item>, <CraftedItem>, <NPCCharacter>, <Culture>, <Faction>, <Kingdom>, <Settlement>, <MBPartyTemplate>) into a writable module. Replaces an object with the same tag+id in that module, otherwise appends it to the module's file for that data type (creating ModuleData/<mod>_<type>.xml and registering it in SubModule.xml). Runs the game's XSD check afterwards.

| Parameter | Type | Description |
|---|---|---|
| `module` **(required)** | string | Writable module id. |
| `xml` **(required)** | string | One or more object elements (a wrapping container like <Items>…</Items> is accepted). Use {=stringId}Text for names. |
| `mode` | `upsert` \| `create` \| `replace` | upsert (default), create (fail if exists), replace (fail if missing). |
| `file` | string | Optional target file under ModuleData, e.g. mymod_weapons.xml (created and registered if needed). |
| `xml_id` | string | Optional XmlName id when it cannot be inferred from the tag (e.g. Items, NPCCharacters). |
| `validate` | boolean | Run XSD validation after writing (default true). |

### `clone_object`

Copies an existing object (usually vanilla) into a writable module under a new id, optionally changing attributes — the fastest way to make a new weapon/troop/hero/culture based on an existing one. With new_id omitted the copy keeps the id and fully overrides the original. A plain 'name' gets a fresh {=id}.

| Parameter | Type | Description |
|---|---|---|
| `source` **(required)** | string | Object to copy: Item.x, NPCCharacter.x, Culture.x, … or bare id. |
| `module` **(required)** | string | Target writable module. |
| `new_id` | string | Id of the copy (omit to override the original with the same id). |
| `set` | object | Attributes to change on the copy's root element, e.g. {"name": "Royal Blade", "value": "5000"}. Values are strings. |
| `source_module` | string | Copy this module's definition instead of the effective one. |
| `file` | string | Optional target file under ModuleData. |
| `validate` | boolean | Run XSD validation after writing (default true). |

### `set_attributes`

Changes attributes of an object that lives in a writable module, editing the file in place. Use path to reach nested elements (mini XPath): ItemComponent/Weapon, skills/skill[@id='OneHanded'], Equipments/EquipmentRoster[1]/equipment[@slot='Item0']. For objects owned by other modules use xslt_patch.

| Parameter | Type | Description |
|---|---|---|
| `module` **(required)** | string | Writable module that defines the object. |
| `ref` **(required)** | string | Object: Item.x, NPCCharacter.x, … or bare id. |
| `set` | object | Attributes to set, e.g. {"weight": "2.5", "value": "1200"}. Values are strings. |
| `remove` | string[] | Attribute names to remove. |
| `path` | string | Optional path to nested element(s) inside the object. |
| `all` | boolean | Apply to every element matched by path (default false = must match exactly one). |
| `validate` | boolean | Run XSD validation after writing (default true). |

### `delete_object`

Removes an object definition from a writable module's XML (all definitions of that id in the module).

| Parameter | Type | Description |
|---|---|---|
| `module` **(required)** | string | Writable module id. |
| `ref` **(required)** | string | Object: Item.x, NPCCharacter.x, … or bare id. |

### `xslt_patch`

Changes an object owned by vanilla or another mod without copying it, by adding a rule to your module's XSLT (ModuleData/XSLT/<mod>_<XmlId>.xslt, registered automatically — the same mechanism the official DLC uses). One call per target node; repeated calls merge. Operations: set attributes, remove attributes, remove the node, replace it, append child XML, or clear the rule. Shows a before/after diff computed with the game's XSLT engine.

| Parameter | Type | Description |
|---|---|---|
| `module` **(required)** | string | Your writable module. |
| `target` **(required)** | string | Object to patch: Item.x, NPCCharacter.x, Culture.empire, Settlement.town_EN1, Faction.clan_x, … |
| `path` | string | Optional nested element inside the target (mini XPath), e.g. ItemComponent/Weapon or skills/skill[@id='Bow']. |
| `set` | object | Attributes to set/add, e.g. {"weight": "1.5"}. Values are strings. |
| `remove_attributes` | string[] | Attribute names to delete. |
| `remove` | boolean | Delete the target node entirely. |
| `replace_xml` | string | Replace the target node with this XML. |
| `append_xml` | string | Append this XML as child element(s) of the target node. |
| `clear` | boolean | Remove this module's existing rule for the target instead. |
| `force` | boolean | Overwrite a hand-written rule with the same match. |
| `preview` | boolean | Show the before/after diff (default true). |
| `game_type` | `Campaign` \| `CampaignStoryMode` \| `CustomGame` \| `EditorGame` | Game type used for the preview (default Campaign). |

### `xslt_preview` · read-only

Runs the game's merge + XSLT pipeline (System.Xml XslCompiledTransform, like the game) for a module and shows before/after diffs of every object its XSLT rules target (or only `targets`). Also reveals XSLT errors that would break loading.

| Parameter | Type | Description |
|---|---|---|
| `module` **(required)** | string | Module whose XSLT to preview (any module, read-only is fine). |
| `xml_id` | string | Limit to one XmlName id, e.g. Items. |
| `targets` | string[] | Specific objects to diff, e.g. Item.x or Culture.empire (default: everything the rules target). |
| `game_type` | `Campaign` \| `CampaignStoryMode` \| `CustomGame` \| `EditorGame` | Game type (default Campaign). |

## Localization (`l10n`)

### `l10n_scan`

Scans a module's XML data, GUI prefabs and C# code (Source/ or code_dir) for {=id}Text strings. Reports texts without ids, empty ids, ids reused with different texts, ids colliding with other modules, and translation coverage per language. fix_missing_ids / fix_conflicts rewrite the module's XML with fresh unique ids.

| Parameter | Type | Description |
|---|---|---|
| `module` **(required)** | string | Module id. |
| `fix_missing_ids` | boolean | Add {=newId} to player-facing XML texts that have none (or {=}) (default false). |
| `fix_conflicts` | boolean | Give new ids to strings whose id is reused with a different text, here or in another module (default false). |
| `include_code` | boolean | Also scan .cs files (default: when a Source folder or code_dir exists). |
| `code_dir` | string | Folder with the mod's C# sources if outside the module folder. |

### `l10n_status` · read-only

Lists a module's strings for one language as JSON lines {"id","text"[,"tr"]}: untranslated (default), translated, all, or stale (translations whose id no longer exists). Strings already translated by the game/other modules (same id and text) are skipped. Translate them and send the result to l10n_set.

| Parameter | Type | Description |
|---|---|---|
| `module` **(required)** | string | Module id. |
| `language` **(required)** | string | Target language: CNs/zh/简体中文, CNt/zh-TW, RU, DE, FR, JP, KO, TR, PL, BR, IT, SP, EN. |
| `show` | `untranslated` \| `translated` \| `all` \| `stale` | Which entries (default untranslated). |
| `offset` | integer | Skip entries (paging). |
| `limit` | integer | Max entries (default 100, max 500). |
| `include_code` | boolean | Include strings from C# sources (default: when Source/ or code_dir exists). |
| `code_dir` | string | Folder with C# sources outside the module. |

### `l10n_set`

Writes translations for one language into the module's ModuleData/Languages/<folder>/ files (creates language_data.xml and <module>_strings.xml when missing; existing ids are updated in place). Warns when {PLACEHOLDERS} differ from the source text.

| Parameter | Type | Description |
|---|---|---|
| `module` **(required)** | string | Writable module id. |
| `language` **(required)** | string | Target language (CNs/zh/简体中文, CNt, RU, DE, …). |
| `translations` | object | Map of string id → translated text. Values are strings. |
| `remove` | string[] | String ids to delete from the language files (e.g. stale ones). |
| `fill_untranslated_with_source` | boolean | Also add every untranslated id with its source text (template for human translators). |
| `allow_unknown_ids` | boolean | Write ids that do not occur in the module's sources (default false: they are skipped). |
| `file` | string | Target file relative to ModuleData/Languages (default <folder>/<module>_strings.xml). |

## Scenes & prefabs (`scene`)

### `scene_list` · read-only

Lists scenes (SceneObj/<name>/scene.xscene) of all or selected modules with size, date and whether terrain/navmesh data exists.

| Parameter | Type | Description |
|---|---|---|
| `module` | string | Module filter: id, comma list, official \| mods \| writable. |
| `query` | string | Substring of the scene name. |
| `limit` | integer | Max rows (default 100). |

### `scene_info` · read-only

Overview of a scene file: header, environment/atmosphere settings, terrain, entity/prefab/script/tag statistics, spawn points, bounding box, where the game references it, and checks (unknown prefabs/meshes/physics shapes, XML errors). live=true reports the scene currently open in the Modding Kit editor instead (needs the editor bridge).

| Parameter | Type | Description |
|---|---|---|
| `scene` | string | Scene name, Module/scene, or path. Not needed with live=true. |
| `module` | string | Module to look in when several have a scene with that name. |
| `live` | boolean | Report the scene open in the running editor (default false). |
| `check` | boolean | Run consistency checks (default true). |

### `scene_entities` · read-only

Lists entities of a scene file with handles ([12], [12/0] for children), name, prefab, mesh, position, rotation (degrees), scale, tags and scripts; filters by name/prefab/tag/script/mesh or distance. entity=<handle|name> returns the entity's XML. live=true lists the scene open in the Modding Kit editor (#handles are session ids for scene_edit live=true).

| Parameter | Type | Description |
|---|---|---|
| `scene` | string | Scene name, Module/scene or path (file mode). |
| `module` | string | Module to look in when the scene name is ambiguous. |
| `live` | boolean | Query the scene open in the running editor (default false). |
| `entity` | string | Handle or name of one entity to show in full. |
| `name` | string | Substring (or /regex/) of the entity name. |
| `prefab` | string | Substring of the prefab name (files: prefab or old_prefab_name; live: linked prefab instances). |
| `tag` | string | Exact tag. |
| `script` | string | Exact script component name (file mode). |
| `mesh` | string | Substring of a meta mesh name (file mode). |
| `near` | number[] | Only entities within `radius` of this [x, y, z] point. |
| `radius` | integer | Radius in meters for `near` (default 10). |
| `recursive` | boolean | Include child entities (default: true when filtering, false otherwise). |
| `selected` | boolean | live=true: only the editor's current selection. |
| `limit` | integer | Max rows (default 60). |
| `offset` | integer | Skip rows (paging). |

### `scene_edit`

Adds, updates, deletes or duplicates entities. File mode edits scene.xscene of a writable module (formatting preserved, undoable). live=true edits the scene open in the Modding Kit editor through the bridge (then save with Ctrl+S in the editor); live also supports select, focus and snap_to_ground. add: place a prefab (prefab=…) or a mesh (mesh=…, physics=bo_…) or raw <game_entity> XML, `count`+`offset` make rows. update: position/move_by, rotation/rotate_by (degrees unless rotation_unit=rad), scale, name (exact for every target unless number_names), add_tags/remove_tags, attributes, script+variables, levels (file mode). Live targets: #handles from scene_entities live (valid until the scene is reopened) or names (child entities included). Siege spawner names are protected: the editor derives their prefab from the name.

| Parameter | Type | Description |
|---|---|---|
| `action` **(required)** | `add` \| `update` \| `delete` \| `duplicate` \| `select` \| `focus` | What to do. |
| `scene` | string | Scene name, Module/scene or path (file mode). |
| `module` | string | Module to look in when the scene name is ambiguous. |
| `live` | boolean | Edit the scene open in the running editor instead of the file (default false). |
| `entities` | string[] | Targets: handles ([12], 12/0 in files; #id numbers live), names, 'guid:{…}' or '@selected' (live). |
| `prefab` | string | add: prefab name (see prefab_search). |
| `mesh` | string | add: meta mesh name (see asset_search kind=mesh). |
| `physics` | string | add (file mode, with mesh): physics shape such as bo_… |
| `xml` | string | add (file mode): a complete <game_entity> element. |
| `name` | string | Name of new entities / new name for update. Siege spawners (BallistaSpawner, MangonelSpawner…) must keep '<prefab>_spawner' names — the editor derives their prefab from the name; other names are refused. |
| `number_names` | boolean | Append _1, _2 … to `name`: default true when add makes several entities (never for siege spawners), false for update (every target gets exactly `name`). |
| `levels` | string[] | update (file mode): the scene levels the entities belong to, e.g. ["siege"] ([] = every level). Define levels with scene_settings add_levels. |
| `parent` | string | add (file mode): handle or name of the parent entity. |
| `position` | number[] | [x, y, z] position (add: placement; update: absolute). |
| `rotation` | number[] | [x, y, z] euler rotation (degrees unless rotation_unit=rad). |
| `rotation_unit` | `deg` \| `rad` | Unit of rotation / rotate_by (default deg). |
| `scale` | number[] | [x, y, z] scale (a single number scales uniformly). |
| `move_by` | number[] | update: relative move [dx, dy, dz]. |
| `rotate_by` | number[] | update: relative rotation [dx, dy, dz] (degrees by default). |
| `add_tags` | string[] | Tags to add. |
| `remove_tags` | string[] | Tags to remove. |
| `attributes` | object | update (file mode): attributes to set on <game_entity>, e.g. {"mobility": "1"}. Values are strings. |
| `remove_attributes` | string[] | update (file mode): attributes to remove. |
| `script` | string | update (file mode): script component name whose variables to set (created if missing). |
| `variables` | object | update (file mode): script variables, e.g. {"SoundName": "event:/…"}. Values are strings. |
| `count` | integer | add/duplicate: number of copies (default 1). |
| `offset` | number[] | add/duplicate: step between copies [dx, dy, dz] (duplicate default [1,0,0]). |
| `snap_to_ground` | boolean | live: drop new/moved entities onto terrain or geometry below. |
| `add_to_selection` | boolean | live select: keep the current selection. |
| `visible` | boolean | live update: show/hide the entities. |

### `scene_create`

Creates SceneObj/<name>/ in a writable module: a copy of an existing scene (template=…, any module; terrain/navmesh files are copied, name and unique token renewed) or a minimal empty scene like the editor's New Scene (envmap probe + ground plane, terrain off).

| Parameter | Type | Description |
|---|---|---|
| `module` **(required)** | string | Writable module. |
| `name` **(required)** | string | Scene name (folder name), e.g. mymod_arena_a. |
| `template` | string | Scene to copy (name or Module/name). Omit for an empty scene. |

### `scene_settings`

Reads or changes a scene's <environment_properties> (e.g. atmosphere_name, is_indoors, water_level, physics_world_min, gi_data_exists), its atmosphere.xml values (time_of_day, color_grade_name, season, fog_density, sun_altitude, …), its level definitions (base, siege, civilian… — entities join them with scene_edit levels) and the editor camera saved in <editor_data>. Without changes it lists the current values.

| Parameter | Type | Description |
|---|---|---|
| `scene` **(required)** | string | Scene name, Module/scene or path. |
| `module` | string | Module to look in when the scene name is ambiguous. |
| `environment` | object | environment property name → value. Values are strings. |
| `atmosphere` | object | atmosphere.xml value name → value. Values are strings. |
| `add_levels` | string[] | Scene levels to define, e.g. ["siege"]; each gets the next free mask bit. |
| `remove_levels` | string[] | Scene levels to remove (refused while entities still use them). |
| `editor_camera` | object | Editor camera to save: position, forward (direction; normalized, must not be vertical), elevation, bearing (or the full editor_camera_* names). Values are strings. |
| `copy_editor_camera_from` | string | Copy the editor camera fields from another scene (name, Module/scene or path), e.g. a backup that opened correctly. |

### `prefab_search` · read-only

Searches prefab definitions (Modules/*/Prefabs/*.xml — what the editor's prefab browser shows) by name, mesh, script or tag. name=<exact> returns the prefab's XML. Use the names with scene_edit action=add prefab=….

| Parameter | Type | Description |
|---|---|---|
| `query` | string | Substring (or /regex/) of the prefab name. |
| `name` | string | Exact prefab name to show in full. |
| `module` | string | Module filter (id, comma list, official, mods). |
| `mesh` | string | Substring of a mesh used by the prefab. |
| `script` | string | Script component name used by the prefab. |
| `tag` | string | Tag used by the prefab. |
| `limit` | integer | Max rows (default 40). |
| `offset` | integer | Skip rows. |

### `prefab_create`

Saves a prefab into <module>/Prefabs/<module>_prefabs.xml from a scene entity (from_scene + entity; its position is reset to the origin) or from <game_entity> XML. The editor loads module prefabs at startup (restart it to see new ones).

| Parameter | Type | Description |
|---|---|---|
| `module` **(required)** | string | Writable module. |
| `name` **(required)** | string | Prefab name (unique across modules). |
| `from_scene` | string | Scene that contains the source entity. |
| `entity` | string | Handle or name of the entity in from_scene. |
| `xml` | string | Alternatively a complete <game_entity> element. |
| `keep_position` | boolean | Keep the entity's position instead of moving it to the origin (default false). |
| `overwrite` | boolean | Replace an existing prefab with this name in the same module. |

## Assets (`assets`)

### `asset_import`

Copies FBX meshes and textures (png/tga/dds/tif/psd/bmp/jpg) into <module>/AssetSources (the folder the Modding Kit editor imports from), checks them (FBX version, texture size, naming) and creates Assets/. Copying is not converting: new files become Assets/*.tpac only through the editor's Resource Browser → Import new asset; the result says what to do next, in which order (materials before FBX, with an editor restart in between) and whether the running editor has the module loaded. Folders are expanded (top level).

| Parameter | Type | Description |
|---|---|---|
| `module` **(required)** | string | Writable module. |
| `files` **(required)** | string[] | Absolute paths of files or folders to import. |
| `subfolder` | string | Optional subfolder inside AssetSources. |
| `normalize_names` | boolean | Lower-case names and replace spaces/special characters (default false). |
| `overwrite` | boolean | Replace files that already exist (files over 200 MB are replaced without backup). |
| `reimport` | boolean | Ask the running editor to re-convert replaced sources (default true). New files are converted only through the Resource Browser's Import new asset. |

### `asset_status` · read-only

Compares a module's AssetSources with the editor's imported packages (Assets/*.tpac): imported, pending (copied but never converted), stale (source changed after import) and orphaned packages, plus the meshes/materials/textures/physics shapes each package contains. Checks the packages like the editor will when loading them: sub-meshes without a material or with an unknown one, resource names corrupted with control characters, physics shapes without their mesh.

| Parameter | Type | Description |
|---|---|---|
| `module` **(required)** | string | Module id. |
| `details` | boolean | List the resources inside every package (default false: first 40). |

### `asset_search` · read-only

Searches resource names inside every module's asset packages (vanilla AssetPackages and mod Assets): meshes, materials, textures, physics shapes, skeletons, animations, particle systems, shaders. Use the names in scenes (meta_mesh_component, physics shape), items (mesh=…) or materials.

| Parameter | Type | Description |
|---|---|---|
| `query` **(required)** | string | Substring or /regex/ of the resource name. |
| `kind` | `mesh` \| `physics_shape` \| `texture` \| `material` \| `skeleton` \| `animation` \| `animation_clip` \| `particle_system` \| `shader` \| `face_animation` \| `source` | Resource kind filter. |
| `module` | string | Module filter (id, comma list, official, mods). |
| `limit` | integer | Max rows (default 50). |
| `offset` | integer | Skip rows. |

## Modding Kit editor (live) (`editor`)

### `editor_status` · read-only

Shows whether the Modding Kit (scene editor) is installed, whether the MB2-MCP editor bridge module is installed and current, which Bannerlord processes run, message boxes that block the game (e.g. 'RGL WARNING', 'Safe Mode') and — if the bridge is connected — the editor state, open scene, entity and selection counts.

_No parameters._

### `editor_bridge_install`

Compiles the MB2-MCP editor bridge (a small C# module) against your installed game with the Windows .NET compiler and installs it as Modules/MB2MCP.EditorBridge. Inside the Modding Kit editor it lets the live tools (scene_* live=true, editor_command) inspect and edit the open scene. Re-run after game updates.

| Parameter | Type | Description |
|---|---|---|
| `force` | boolean | Recompile even if the current version is installed. |

### `editor_launch`

Starts the Modding Kit build (bin/Win64_Shipping_wEditor/Bannerlord.exe) with the official singleplayer modules, the given modules and the editor bridge, and (open_editor=true) enters the scene editor automatically (with an empty scene; open yours in the editor). Loading usually takes 1–5 minutes; poll editor_status until it reports 'edit mode ON'. While it loads, 'RGL WARNING' message boxes about other mods' SubModule.xml entries (common with Workshop mods made for launcher extensions) are answered automatically with OK, together with the two prompts that follow each of them (the crash watchdog's 'collect necessary files?' → No, nothing is collected or uploaded; 'Always Ignore?' → Cancel, no setting changes) and the shader-cache notices ('Mod change detected').

| Parameter | Type | Description |
|---|---|---|
| `modules` | string[] | Your module ids to load (with their dependencies), e.g. ["MyMod"]. |
| `open_editor` | boolean | Enter the scene editor automatically (default true; needs the bridge). |
| `dismiss_module_warnings` | boolean | During the first 10 minutes press OK on module-metadata warnings, No/Cancel on the 'collect files?' and 'Always Ignore?' prompts that follow each of them, and OK on shader-cache notices (default true). Other message boxes are left for you; editor_status lists them. |
| `decline_safe_mode` | boolean | If the game asks to start in Safe Mode after a crash, answer No (keeps your modules and the bridge loaded). Default false: the question is left to you. |
| `ignore_asset_problems` | boolean | Start even when your modules' packages contain meshes without a material (the editor then stalls on a crash-watchdog dump for each while loading). |
| `force` | boolean | Start even if a Bannerlord process is already running. |

### `editor_command`

Live actions in the running Modding Kit editor (needs the bridge): console (run a developer console command), list_commands (console commands by prefix; entries ending in '.' are groups such as 'scene.', 'resource.', 'prefab.' — list them with that prefix), check_scene (editor's scene problem check), reimport_assets (re-converts changed sources of earlier imports — new files need the Resource Browser's Import new asset), raycast (from/to or a position straight down → hit point), ground_height, warning (show a message in the editor), enter_editor (from the main menu), ping, quit (confirm=true; closes the game without saving). Also without the bridge: screenshot (captures the game window and returns the image; when the game is frozen or has no window yet, the message box blocking it), dialogs (the game's message boxes such as 'RGL WARNING', prompts Windows shows for it, the scene editor's modal Qt dialogs such as 'Do you want to save the scene?' with their texts, fields and buttons, and its other open windows), dismiss_dialogs (press OK, or `button`, on them; editor dialogs and file dialogs only with a named `button`) and fill_dialog (type into an editor dialog's input fields, set its check boxes and select a list/tree item — by label or #n — then read everything back; it never presses a button). With the bridge also: perf (frame times over `seconds`: average, percentiles, fps, plus the engine's main/renderer fps). cleanup deletes the screenshots, walk traces and dialog/bridge logs this server left in the bridge folder.

| Parameter | Type | Description |
|---|---|---|
| `action` **(required)** | `screenshot` \| `console` \| `list_commands` \| `check_scene` \| `reimport_assets` \| `raycast` \| `ground_height` \| `warning` \| `enter_editor` \| `ping` \| `dialogs` \| `dismiss_dialogs` \| `fill_dialog` \| `perf` \| `cleanup` \| `quit` | Action. |
| `button` | string | dismiss_dialogs: button text or control id to press (default: OK, or the only button). 'OK', 'Cancel', 'Yes', 'No', 'Retry', 'Ignore', 'Close' also match Windows boxes in any language (e.g. 否(N)). Scene editor (Qt) dialogs and file dialogs are only answered with a named button. Dialogs without a matching button are left open. |
| `title` | string | dismiss_dialogs/fill_dialog: only dialogs whose title contains this text (e.g. 'RGL WARNING', 'Save Scene'). |
| `fields` | object | fill_dialog: input fields to set, by label, name or #1, #2 … in order, e.g. {"Name": "my_scene_v2"}. Values are strings. |
| `check` | object | fill_dialog: check boxes or radio buttons to set, by label, to true/false. Values are strings. |
| `select` | string | fill_dialog: text of a list or tree item to select (e.g. a module or scene name). |
| `seconds` | integer | perf: sampling time (default 5, max 120). |
| `confirm` | boolean | quit: must be true — closes the game; unsaved editor changes are lost. |
| `command` | string | console: the command line, e.g. 'help'. |
| `prefix` | string | list_commands: command prefix (default all). |
| `position` | number[] | raycast/ground_height: [x, y, z] point to probe downwards from. |
| `from` | number[] | raycast: start point. |
| `to` | number[] | raycast: end point. |
| `message` | string | warning: text to show in the editor's warning panel. |
| `source` | `window` \| `engine` | screenshot: 'window' (default) captures the game/editor window including the editor UI and works without the bridge; 'engine' asks the renderer (needs the bridge; black while the scene editor is in front). |
| `path` | string | screenshot: keep a full-resolution copy in this .png file (default: nothing is kept on disk). |
| `max_width` | integer | screenshot: width of the image returned to you (default 1280; the saved file keeps full size). |

### `editor_play`

Play mode of the Modding Kit editor (needs the bridge). start plays the open scene with the editor's test mission — the same managed entry the editor's Play button reaches; the player spawns at spawnpoint_player_test or spawnpoint_player — and waits until the player is there. It loads the scene's SAVED file: save first (start refuses when changes made through this server are newer than the file). stop returns to the editor exactly like the leave key does in play mode, and waits for it. status / missions report. While playing, live scene_* commands are refused (they act on the edited scene); use mission, navmesh_query and editor_command screenshot.

| Parameter | Type | Description |
|---|---|---|
| `action` | `status` \| `start` \| `stop` \| `missions` | Action (default status). |
| `scene` | string | start: play another saved scene of the loaded modules by name instead of the open one (the editor keeps its scene). |
| `mission` | string | start: the editor mission (default the first one listed by action=missions). |
| `levels` | string | start: scene levels for the mission, e.g. 'siege' or 'civilian' (default none). |
| `allow_unsaved` | boolean | start: play although changes made through this server since the last save are not in the file (default false). |
| `wait_seconds` | integer | start/stop: wait until the player is spawned / the editor is back (default 120 / 30; 0 = return at once). |

### `mission`

In play mode (editor_play) or another running mission (needs the bridge): status (player position, direction, mission state); objects (usable objects near the player — doors, chairs, passages, ladders… — and whether the player can use them); dismount (the editor's test mission spawns a horseman); walk (the player walks a route with the game's own AI movement on the navigation mesh, never teleported, and each leg reports reached / stuck / timed out with the closest approach; the position trace is saved as JSON — evidence that a route can be walked, or where it is blocked); walk_status / walk_stop; teleport (positioning before a test, reported as such — not evidence of a walkable route); use (use an object within reach, the same callback as the interaction key); stop_using.

| Parameter | Type | Description |
|---|---|---|
| `action` | `status` \| `objects` \| `walk` \| `walk_status` \| `walk_stop` \| `teleport` \| `use` \| `stop_using` \| `dismount` | Action (default status). |
| `points` | array[] | walk: targets in order, [[x, y, z], …]. |
| `return_to_start` | boolean | walk: afterwards walk the route back to where the player started (default false). |
| `allow_mounted` | boolean | walk: test the route on horseback when the player is mounted (default false: dismount first). |
| `tolerance` | number | walk: a target counts as reached within this horizontal distance in meters (default 0.5). |
| `leg_timeout` | number | walk: seconds allowed per leg (default 30). |
| `stall_seconds` | number | walk: a leg fails as 'stuck' after this many seconds without 0.3 m of progress (default 6). |
| `speed` | number | walk: maximum speed limit for the player while walking (default: unchanged). |
| `wait_seconds` | integer | walk: wait for the result up to this long (default 120; 0 = return at once and poll with walk_status). |
| `trace_file` | string | walk/walk_status: where to save the JSON trace (default: Documents/Mount and Blade II Bannerlord/MB2MCP/walk_<id>_<time>.json). |
| `position` | number[] | teleport: target; objects: search center (default the player). |
| `direction` | number[] | teleport: direction to face. |
| `radius` | number | objects: search radius in meters (default 10). |
| `entity` | string | use: name of the usable object's entity (or of its parent). |
| `tag` | string | use: tag of the usable object's entity. |
| `max_distance` | number | use: how far the player may be from the object, in meters (default 3). |

### `navmesh_query` · read-only

Read-only queries with the engine's own path finding (the one AI agents use) on the navigation mesh of the scene open in the editor, or of the running mission (needs the bridge): summary (face count, face ids with their face counts, CRC), at (the face under a position: index, id, island, center, open edges), path (whether two positions are connected, path length against the straight distance, corner points), line (whether a straight move from a position stays on the mesh), group (faces with one id: count and extent). Use mission action=walk to prove a route with a real agent.

| Parameter | Type | Description |
|---|---|---|
| `action` | `summary` \| `at` \| `path` \| `line` \| `group` | Query (default summary). |
| `position` | number[] | at: position to look up. |
| `from` | number[] | path/line: start position. |
| `to` | number[] | path/line: end position. |
| `radius` | number | path/line: agent radius in meters (default 0.3). |
| `id` | integer | group: face id (face group index). |

### `editor_camera`

The live viewport camera (needs the bridge): get (position, view direction, pitch and heading of the last rendered frame — also in play mode), set (move the editor camera to a position, keeping its direction), move (by a delta). The engine offers no call to turn the live editor camera: scene_edit action=focus zooms toward an entity keeping the direction, and scene_settings editor_camera sets the saved camera used when the scene is opened.

| Parameter | Type | Description |
|---|---|---|
| `action` | `get` \| `set` \| `move` | Action (default get). |
| `position` | number[] | set: camera position. |
| `delta` | number[] | move: offset to add to the camera position. |

## Logs & history (`logs`)

### `read_logs` · read-only

Reads Bannerlord's logs to debug a mod: rgl_log_*.txt (main log), rgl_log_errors_*.txt, launcher and crash files under ProgramData and Documents. action=list shows recent files; action=read (default) shows the tail of the latest log or matches of grep / errors_only.

| Parameter | Type | Description |
|---|---|---|
| `action` | `read` \| `list` | read (default) or list. |
| `file` | string | latest (default), latest-errors, launcher, a file name from action=list, or a full path inside a log folder. |
| `grep` | string | Regex or text to filter lines (case-insensitive), e.g. your module id or 'xml'. |
| `errors_only` | boolean | Only lines that look like errors/exceptions (default false). |
| `tail` | integer | Max lines/matches to return (default 120, max 1000). |
| `context` | integer | Context lines around matches (default 0, max 10). |

### `edit_history` · read-only

Lists recent changes made through this MCP server (every write is journaled with a backup), newest first.

| Parameter | Type | Description |
|---|---|---|
| `limit` | integer | How many entries (default 20). |
| `module` | string | Only entries of this module. |

### `forget_history`

Deletes this server's edit journal and the file backups it keeps for undo_edit (in MB2_DATA_DIR, default %LOCALAPPDATA%\mb2-mcp\history): all of it, or only edits older than older_than_days. Forgotten edits can no longer be undone. Needs confirm=true. (Screenshots and traces in the bridge folder: editor_command action=cleanup.)

| Parameter | Type | Description |
|---|---|---|
| `older_than_days` | integer | Only forget edits older than this many days (default: all). |
| `confirm` | boolean | Must be true: forgotten edits cannot be undone any more. |

### `undo_edit`

Reverts one change made through this server (default: the most recent not yet undone, optionally of one module), restoring backed-up files and deleting files it created. Refuses if the files changed afterwards unless force=true.

| Parameter | Type | Description |
|---|---|---|
| `seq` | integer | Edit number from edit_history (default: latest). |
| `module` | string | Undo the latest edit of this module. |
| `force` | boolean | Undo even if files were modified after the edit (those later changes are lost). |
