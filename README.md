<div align="center">

# MB2-MCP

**Turn your AI coding agent into a Mount & Blade II: Bannerlord modding partner.**

[English](README.md) · [简体中文](README.zh-CN.md) · [Tool reference](docs/TOOLS.md)

![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=nodedotjs&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-stdio-6E56CF)
![Bannerlord](https://img.shields.io/badge/Bannerlord-1.2%E2%80%931.4-8B5A2B)
![Platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)
![Tools](https://img.shields.io/badge/tools-43-blue)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

</div>

---

## Introduction

MB2-MCP is an [MCP](https://modelcontextprotocol.io) server that gives Claude Code, Codex, DeepSeek Harness and other MCP clients
the view of a Bannerlord install that an experienced modder has, plus safe tools to change it. You ask in plain language;
the agent searches, writes, patches and validates, then shows you what changed.

> *"Make a mod called RoyalArmory with a sword based on the imperial spatha, worth 5000 denars."*
> *"Raise one-handed skill of every Vlandian cavalry troop above level 26 by 20 — patch it, don't override."*
> *"Translate MyMod into Simplified Chinese."*
> *"In the open editor scene, put three barrels on the ground in a row next to the gate and take a screenshot."*

How it works:

- **Files** — module XML, scenes and prefabs are edited with an offset-preserving XML scanner (only the touched characters change),
  and every write is journaled with a backup.
- **Validation and XSLT** run on the .NET Framework through Windows PowerShell: the same `System.Xml` classes the game uses.
- **Live editing** goes through a small bridge module that the server compiles on your machine against *your* game's editor assemblies,
  with the C# compiler that ships with Windows. It runs only inside the Modding Kit, listens on `127.0.0.1` and requires a random token.

Requirements: Windows 10/11 · [Node.js](https://nodejs.org) 18+ · Bannerlord (tested with 1.4.8; 1.2+ expected to work) ·
optional **Mount & Blade II: Bannerlord – Modding Kit** (Steam → Library → Tools) for the live editor.

## What it can do

**Know your install**
- Detects the game (Steam/Epic/GOG/Xbox) and indexes every module (official, Workshop and your own) in about a second.
- Search objects by id, name (Chinese names too) or attributes, find reverse references, show load order and dependencies.

**Edit game data safely**
- Create modules; write, clone and change items, troops, heroes, clans, kingdoms, settlements and cultures. Files are registered in
  `SubModule.xml` automatically; indentation, comments and encodings (UTF-8/UTF-16) are preserved.
- Change vanilla or other mods without copying them, with XSLT patches (the mechanism the official naval DLC uses), previewed with the
  game's own `XslCompiledTransform` and XSD validation.
- Validate like the game: XSD schemas, XSLT compilation, dependencies, DLLs, duplicate ids, broken references, unregistered files.
- Localization: find untranslatable text, assign `{=ids}`, list untranslated strings, write `Languages/<lang>/` files with placeholder checks.

**Scenes and prefabs (files, no game needed)**
- List, filter and edit `scene.xscene` entities: add prefabs or meshes in rows, move/rotate (degrees)/scale, tags, script variables,
  scene levels, duplicate, delete; create scenes from templates; environment and atmosphere; the saved editor camera; save entities as prefabs.
- Catch what crashes the editor on load: siege spawners with custom names, a camera saved looking straight down, GI flagged without bake data.

**Assets**
- Copy FBX meshes and textures into `AssetSources` with checks (FBX version, texture size, naming), and search the resource tables of all
  `.tpac` packages (~90k names).
- Check converted packages the way the editor loads them (sub-meshes without a material, names corrupted by the importer, collision shapes
  without their mesh) and refuse to launch the editor with packages that would freeze it.

**Live scene editor (Modding Kit + bridge)**
- Launch the Modding Kit with your module and enter the scene editor; the startup prompts that block it (module-metadata warnings, the crash
  watchdog's *collect necessary files?*, *Always Ignore?*, the shader-cache notice) are answered for 10 minutes — always the choice that
  sends and changes nothing.
- `editor_status` explains a stuck editor: message boxes (also those Windows shows for the game, and the editor's own Qt dialogs with
  their buttons), a frozen window, crash-watchdog dumps, engine warnings, which scene file is open and whether changes made through the
  server are unsaved.
- In the open scene: list, select, spawn (rows, snap to ground), move, rotate, scale, rename, tag, show/hide, duplicate and delete entities;
  raycast and ground height; console commands with the engine log they produced; the editor's scene check; screenshots of the editor
  window (viewport *and* UI) that the agent can look at.
- Answer dialogs with explicit buttons in any Windows language (`button="No"` presses `否(N)`).

**Play mode, walk tests and navigation** *(new in 0.3.0, experimental: built on the game's own APIs, not yet tested in a running editor)*
- `editor_play` starts and stops the editor's play mode on a saved scene; live scene edits are refused while it runs.
- `mission action=walk` lets the player walk a route with the game's AI movement on the navigation mesh (never teleported) and reports
  each leg as reached, stuck or timed out, with a JSON position trace; `objects` / `use` / `dismount` / `teleport` (labelled as positioning).
- `navmesh_query` asks the engine's path finder: the face under a point, whether two points connect and how long the path is.
- `editor_camera` reads and moves the viewport camera; `editor_command action=perf` samples frame times;
  `action=fill_dialog` fills an editor dialog's fields, check boxes and list selections without pressing anything.

**Safe by default**
- Official and Workshop modules are never written. Every file change has a backup: `edit_history`, `undo_edit`.
- Launching and quitting the game always need an explicit call (quit also `confirm=true`).

**Privacy**
- No built-in telemetry. The editor bridge uses 127.0.0.1. `read_logs` restricts reads to game log folders, but module path checks
  are not a sandbox: junctions and symbolic links can lead outside a module. Only inspect modules and linked folders you trust.
- Tool output shows your home folder as `%USERPROFILE%` and your user and computer names as `<user>` / `<computer>`; paths
  sent back with `%USERPROFILE%` still work (`MB2_REDACT=0` turns this off). Everything else the agent reads — mod files,
  game logs, screenshots — reaches the model provider of your MCP client, like any tool output. Debug logs and image contents
  are not fully redacted; review them before sharing.
- Screenshots without `path=…png` use temporary files that are removed after a successful capture. Failures can leave raw capture
  files behind. Screen-copy masking is best-effort and can miss other programs' frozen windows; keep private windows out of view.
  `editor_command action=cleanup` deletes screenshots, walk traces and logs from `Documents\Mount and Blade II Bannerlord\MB2MCP`;
  `forget_history` deletes edit backups. These cleanup actions can currently delete server-owned records even in read-only mode.

All 43 tools with their parameters: **[docs/TOOLS.md](docs/TOOLS.md)**.

## What it can't do

- **Open another scene, reload it, or save it in the editor.**
  - Why: the engine offers no call for it — neither the editor's managed API (`MBEditor`) nor the native console's `scene.`,
    `editor.` and `resource.` commands open or save a scene. The editor's toolbar buttons expose no names to accessibility tools, so the
    server would have to click by screen position, which is too risky for your scene. Open and save in the editor (Ctrl+S); `editor_status` shows the file and whether
    changes made through the server are unsaved.
- **Convert new assets the first time** (FBX/textures → `.tpac`).
  - Why: only the Resource Browser's *Import new asset* (with its FBX Import Settings) does it; no engine call or console command converts
    new sources, and `reimport_assets` only re-converts sources imported before. `asset_import` prepares and checks the files,
    `asset_status` verifies the result.
- **Edit the navigation mesh.**
  - Why: the engine's navigation calls are meant for missions (switching face groups on and off at runtime) and cannot add, move or
    save faces; saving goes through the editor's NavigationMeshInspector, and `navmesh.bin` is an undocumented compressed format.
    `navmesh_query` can inspect it.
- **Paint terrain or flora, or edit materials, shaders and textures.**
  - Why: these are native editor tools with no engine call that modules could use. Static flora and other props can still be placed as entities.
- **Change script variables of a live entity.**
  - Why: the engine exposes no supported call for the editor's script inspector that MB2-MCP could rely on. File mode writes them into
    `scene.xscene`; reopen the scene to see them.
- **Turn the live editor camera or read its field of view.**
  - Why: the engine only reports the last rendered camera frame and can move the camera's position. `scene_edit action=focus` zooms toward
    an entity, and `scene_settings editor_camera` sets the camera saved with the scene.
- **Run a light bake as a tracked job** (progress, cancel, result).
  - Why: baking runs through console commands that only answer "Done". The tools return what the engine logged meanwhile and explain known
    messages such as *No border probes can be found*; a "Done" is not proof that GI data exists.
- **Play unsaved changes.**
  - Why: the test mission `editor_play` starts loads the scene by name from its saved file, so it refuses while changes made through the
    server are newer than the file.
- **Undo live editor changes.**
  - Why: they are made through engine calls, outside the editor's undo history, and `undo_edit` covers files only. Save or discard them in the editor.
- **Modify official or Workshop modules.**
  - Why: by design, to protect your install. Patch them with XSLT from your own module instead.
- **Choose a button for you in editor dialogs or after a crash.**
  - Why: editor dialogs can save or discard scenes, and crash prompts end a process; only startup prompts with a harmless answer are
    automatic. Everything else needs an explicit `button`.
- **Test NPC behaviour, battles or sieges.**
  - Why: the tools drive one player agent (walk, use, position). AI and combat need a real game test.
- **Run XSD/XSLT or the live editor outside Windows.**
  - Why: they need the .NET Framework and the Windows-only Modding Kit; browsing and file editing work everywhere.

## How to configure

Build once and check your setup:

```bash
git clone <this repository> MB2-MCP
cd MB2-MCP
npm install
npm run build
node dist/index.js doctor     # game, index, schemas, .NET, Modding Kit
node dist/index.js config     # prints the blocks below with your real paths
```

The examples use the server name `bannerlord`; tools then appear as `mcp__bannerlord__<tool>`. Replace the paths with yours
(`node dist/index.js config claude|codex|dsh` prints them ready to paste).

### Claude Code

```bash
claude mcp add bannerlord --scope user -e MB2_GAME_DIR="D:\SteamLibrary\steamapps\common\Mount & Blade II Bannerlord" -- "C:\Program Files\nodejs\node.exe" D:\MB2-MCP\dist\index.js
```

Or a project-scoped `.mcp.json` in your mod folder ([example](examples/claude-code.mcp.json)). Check with `claude mcp list`.

### Codex

Codex CLI, the desktop app and the IDE extension share `~/.codex/config.toml` ([example](examples/codex.config.toml)):

```toml
[mcp_servers.bannerlord]
command = 'C:\Program Files\nodejs\node.exe'
args = ['D:\MB2-MCP\dist\index.js']
startup_timeout_sec = 30
tool_timeout_sec = 300
default_tools_approval_mode = "writes"   # read-only tools are annotated, so only edits ask

[mcp_servers.bannerlord.env]
MB2_GAME_DIR = 'D:\SteamLibrary\steamapps\common\Mount & Blade II Bannerlord'
```

Or: `codex mcp add bannerlord --env MB2_GAME_DIR="…" -- "C:\Program Files\nodejs\node.exe" D:\MB2-MCP\dist\index.js`.

### DeepSeek Harness

Merge into `~/.dsh/cordis.patch.yml` (all profiles) or `~/.dsh/profiles/<profile>/cordis.patch.yml`
([example](examples/dsh.cordis.patch.yml)); dsh reloads it automatically:

```yaml
- insert:
    - id: mcp-bannerlord
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: bannerlord
        transport: stdio
        command: 'C:\Program Files\nodejs\node.exe'
        args: ['D:\MB2-MCP\dist\index.js']
        env:
          MB2_GAME_DIR: 'D:\SteamLibrary\steamapps\common\Mount & Blade II Bannerlord'
        toolCallTimeoutMs: 300000
```

Other MCP clients (Cursor, Cline, Windsurf, Cherry Studio, …): `node dist/index.js config json` prints a generic `mcpServers` block.

### Options (environment variables)

| Variable | Meaning |
|---|---|
| `MB2_GAME_DIR` | Game folder (auto-detected otherwise) |
| `MB2_MODULE_DIRS` | Extra folders with your own modules (writable), `;`-separated — link them into `<game>/Modules` for the game to load them |
| `MB2_TOOLSETS` | Tool groups to expose: `core,edit,l10n,scene,assets,editor,logs` (default all; fewer tools for small context windows) |
| `MB2_WORKSHOP=0` | Do not index Steam Workshop modules |
| `MB2_READONLY=1` | Disable module edits; cleanup actions can still delete server-owned records |
| `MB2_DATA_DIR` | History and backups (default `%LOCALAPPDATA%\mb2-mcp`) |
| `MB2_MAX_OUTPUT` | Max characters per tool result (default 40000) |
| `MB2_POWERSHELL` | Path to Windows PowerShell for XSD/XSLT |
| `MB2_DEBUG=1` | Log tool timings to stderr |
| `MB2_REDACT=0` | Show the real home folder, user and computer names in tool output (default: masked) |

Before publishing a fork, run `npm run privacy`: it checks every file git and npm would publish for your home folder, user and
computer names, e-mail addresses, keys and tokens, and the private terms you list in `%USERPROFILE%\.mb2-mcp\privacy-terms.txt`
(kept outside the repository). Publish with git or `npm pack`, not by zipping the folder.
Also run `npm pack --dry-run --ignore-scripts` separately and review its file list: the privacy checker can currently omit npm
package files if that command fails. A clean source scan does not remove the runtime limitations described above.

### Live editor (optional)

1. Install the Modding Kit (Steam → Library → Tools).
2. Ask the agent to run `editor_bridge_install` while the game is closed. Run it again after game updates, and when `editor_status` says the
   bridge is outdated after an MB2-MCP update; restart your MCP client so it loads the new server.
3. `editor_launch modules=["MyMod"]` starts the editor; poll `editor_status` until it reports `edit mode ON` (1–5 minutes).

Long-running tools (launching, `editor_play start`, `mission walk`) wait up to two minutes by default. Keep the tool timeout at 300 s as in
the examples, or pass `wait_seconds=0` and poll.

---

## License

Released under the [MIT License](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for upstream acknowledgements and licenses.

<sub>Not affiliated with or endorsed by TaleWorlds Entertainment. Thanks to TaleWorlds for Bannerlord and its modding tools, and to
[BannerlordSceneToolkit](https://github.com/fiefevictionnotice/BannerlordSceneToolkit) for showing which editor APIs exist.</sub>
