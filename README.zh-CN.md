<div align="center">

# MB2-MCP

**让你的 AI 编程助手成为《骑马与砍杀 2：霸主》的 Mod 制作搭档。**

[English](README.md) · [简体中文](README.zh-CN.md) · [工具参考](docs/TOOLS.md)

![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=nodedotjs&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-stdio-6E56CF)
![Bannerlord](https://img.shields.io/badge/Bannerlord-1.2%E2%80%931.4-8B5A2B)
![Platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)
![Tools](https://img.shields.io/badge/tools-43-blue)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

</div>

---

## 简介

MB2-MCP 是一个 [MCP](https://modelcontextprotocol.io) 服务器。它让 Claude Code、Codex、DeepSeek Harness 等 MCP 客户端
像资深 Mod 作者一样了解你安装的《霸主》，并提供安全的修改工具。你用自然语言提出需求，助手负责搜索、编写、打补丁、校验，
最后告诉你改了什么。

> *“新建一个叫 RoyalArmory 的 Mod，以帝国斯帕塔剑为基础做一把剑，售价 5000 第纳尔。”*
> *“把所有 26 级以上的瓦兰迪亚骑兵的单手技能提高 20——用补丁，不要覆盖原文件。”*
> *“把 MyMod 翻译成简体中文。”*
> *“在编辑器当前场景里，城门旁边的地面上摆一排三个木桶，然后截图。”*

工作方式：

- **文件**——模块 XML、场景和预制体用保留偏移的 XML 扫描器修改（只改动涉及的字符），每次写入都有日志和备份。
- **校验与 XSLT** 通过 Windows PowerShell 调用 .NET Framework，与游戏使用同一套 `System.Xml` 类。
- **实时编辑**通过一个小型桥接模块完成：服务器在你的电脑上用 Windows 自带的 C# 编译器、针对*你的*游戏版本的编辑器程序集编译它。
  它只在 Modding Kit 中运行，只监听 `127.0.0.1`，并且需要随机令牌。

环境要求：Windows 10/11 · [Node.js](https://nodejs.org) 18+ · 《霸主》（已在 1.4.8 测试，1.2 及以上预计可用）·
实时编辑器需另装 **Mount & Blade II: Bannerlord – Modding Kit**（Steam → 库 → 工具）。

## 能做什么

**了解你的游戏**
- 自动识别游戏（Steam/Epic/GOG/Xbox），约一秒内索引全部模块：官方、创意工坊和你自己的。
- 按 id、名称（支持中文名）或属性搜索对象，查反向引用、加载顺序和依赖。

**安全地修改游戏数据**
- 创建模块；新建、克隆、修改物品、兵种、英雄、家族、王国、定居点和文化。文件会自动注册到 `SubModule.xml`，
  并保留缩进、注释和编码（UTF-8/UTF-16）。
- 用 XSLT 补丁修改原版或其他 Mod，不复制原文件（官方海战 DLC 用的就是这套机制），并用游戏自己的 `XslCompiledTransform`
  和 XSD 校验预览结果。
- 像游戏一样校验：XSD、XSLT 编译、依赖、DLL、重复 id、失效引用、未注册文件。
- 本地化：找出无法翻译的文本，分配 `{=id}`，列出未翻译条目，写入 `Languages/<语言>/` 并检查占位符。

**场景与预制体（文件模式，无需启动游戏）**
- 列出、筛选、编辑 `scene.xscene` 实体：成排添加预制体或网格，移动、旋转（角度）、缩放，标签、脚本变量、场景等级，复制、删除；
  从模板创建场景；环境与大气；保存的编辑器相机；把实体存为预制体。
- 发现会让编辑器加载时崩溃的问题：改了名的攻城器械生成点、保存成垂直向下的相机、标记了 GI 却没有烘焙数据。

**资产**
- 把 FBX 网格和贴图复制到 `AssetSources` 并检查（FBX 版本、贴图尺寸、命名），搜索所有 `.tpac` 资源包的资源表（约 9 万个名称）。
- 按编辑器加载的方式检查转换后的资源包（没有材质的子网格、被导入器写坏的名称、找不到网格的碰撞形状），
  资源包会让编辑器卡死时拒绝启动编辑器。

**实时场景编辑器（Modding Kit + 桥接模块）**
- 带上你的模块启动 Modding Kit 并进入场景编辑器。启动后 10 分钟内，会挡住启动的提示（模块元数据警告、崩溃看门狗的
  *collect necessary files?*、*Always Ignore?*、着色器缓存提示）都会自动回答，而且总是选不发送、不改设置的那个选项。
- `editor_status` 说明编辑器为什么卡住：弹窗（包括 Windows 代游戏显示的，以及编辑器自己的 Qt 对话框和按钮）、无响应的窗口、
  崩溃看门狗转储、引擎警告、当前打开的是哪个场景文件、通过本服务器做的修改是否还没保存。
- 在当前场景中：列出、选择、生成（成排、贴地）、移动、旋转、缩放、重命名、加标签、显示/隐藏、复制、删除实体；射线检测和地面高度；
  执行控制台命令并返回其间的引擎日志；编辑器的场景检查；截取编辑器窗口（视口*和*界面）供助手查看。
- 用明确的按钮回答弹窗，与 Windows 语言无关（`button="No"` 会按下 `否(N)`）。

**游玩模式、行走测试与导航**（*0.3.0 新增，实验性：基于游戏自身接口实现，尚未在运行中的编辑器里实测*）
- `editor_play` 在已保存的场景上开始、结束编辑器游玩模式；游玩期间拒绝实时场景编辑。
- `mission action=walk` 让玩家用游戏的 AI 移动沿导航网格走路线（绝不瞬移），每段报告到达、卡住或超时，并保存 JSON 位置轨迹；
  另有 `objects`、`use`、`dismount`、`teleport`（标明只是摆放位置）。
- `navmesh_query` 用引擎寻路查询：某点下的网格面、两点是否连通以及路径多长。
- `editor_camera` 读取、移动视口相机；`editor_command action=perf` 采样帧时间；
  `action=fill_dialog` 填写编辑器对话框的输入框、复选框和列表选择，但不按任何按钮。

**默认安全**
- 永远不写官方和创意工坊模块。每次文件修改都有备份：`edit_history`、`undo_edit`。
- 启动和退出游戏都需要显式调用（退出还需要 `confirm=true`）。

**隐私**
- 无内置遥测。编辑器桥接使用本机 127.0.0.1；`read_logs` 限定读取游戏日志目录，但模块路径检查并非沙箱：
  目录联接和符号链接可能指向模块外。请只检查可信的模块及其链接目录。
- 工具输出里，你的用户目录显示为 `%USERPROFILE%`，用户名和计算机名显示为 `<user>` / `<computer>`；带 `%USERPROFILE%`
  的路径传回来照样可用（`MB2_REDACT=0` 可关闭）。助手读取的其他内容——Mod 文件、游戏日志、截图——会像其他工具结果一样
  发给你的 MCP 客户端所用的模型服务商。调试日志和图片内容并不保证完整脱敏，分享前请检查。
- 不传 `path=…png` 时，截图使用临时文件并在成功后清理；失败可能留下原始截图文件。从屏幕复制时的遮挡处理
  可能漏掉其他程序的卡死窗口，请先移开含隐私的窗口。`editor_command action=cleanup` 删除服务器留在
  `文档\Mount and Blade II Bannerlord\MB2MCP` 里的截图、行走轨迹和日志；`forget_history` 删除修改备份。
  这些清理操作目前在只读模式下也能删除服务器自身的记录。

全部 43 个工具及参数见 **[docs/TOOLS.md](docs/TOOLS.md)**。

## 不能做什么

- **在编辑器里打开另一个场景、重新加载或保存场景。**
  - 为什么：引擎没有提供对应调用——编辑器的托管接口（`MBEditor`）和原生控制台的 `scene.`、`editor.`、`resource.` 命令都不能
    打开或保存场景。编辑器工具栏按钮在无障碍接口里没有名称，服务器只能按屏幕位置盲点，这对你的场景风险太大。
    请在编辑器里打开和保存（Ctrl+S）；`editor_status` 会显示场景文件以及通过本服务器做的修改是否还没保存。
- **首次转换新资产**（FBX/贴图 → `.tpac`）。
  - 为什么：只有资源浏览器的 *Import new asset*（连同 FBX Import Settings）能做；没有引擎调用或控制台命令能转换新的源文件，
    `reimport_assets` 只会重新转换以前导入过的源文件。`asset_import` 负责准备和检查文件，`asset_status` 负责核对结果。
- **编辑导航网格。**
  - 为什么：引擎的导航调用是给任务运行时用的（开关某组网格面），不能增加、移动或保存网格面；保存要通过编辑器的
    NavigationMeshInspector，而 `navmesh.bin` 是没有公开文档的压缩格式。`navmesh_query` 可以检查它。
- **绘制地形或植被，编辑材质、着色器和贴图。**
  - 为什么：这些是编辑器的原生工具，没有可供模块调用的引擎接口。静态植被和其他摆件仍然可以作为实体放置。
- **修改实时实体的脚本变量。**
  - 为什么：引擎没有为编辑器脚本面板提供 MB2-MCP 能可靠使用的调用。文件模式可以把它们写进 `scene.xscene`，重新打开场景即可看到。
- **转动实时编辑器相机或读取其视场角（FOV）。**
  - 为什么：引擎只报告最后渲染帧的相机位置和朝向，并且只能移动相机位置。`scene_edit action=focus` 可以拉近到某个实体，
    `scene_settings editor_camera` 可以设置随场景保存的相机。
- **把光照烘焙当作可跟踪的任务**（进度、取消、结果）。
  - 为什么：烘焙通过控制台命令执行，只会回复 "Done"。工具会返回其间的引擎日志并解释 *No border probes can be found* 等常见消息；
    "Done" 不能证明 GI 数据已经生成。
- **游玩未保存的修改。**
  - 为什么：`editor_play` 启动的测试任务按场景名从已保存的文件加载，所以通过本服务器做的修改比文件新时会拒绝开始。
- **撤销实时编辑器中的修改。**
  - 为什么：这些修改通过引擎调用完成，不在编辑器的撤销历史里，`undo_edit` 也只管文件。请在编辑器里保存或放弃。
- **修改官方或创意工坊模块。**
  - 为什么：这是有意的设计，用来保护你的游戏安装。请在自己的模块里用 XSLT 补丁修改它们。
- **在编辑器对话框或崩溃提示里替你选按钮。**
  - 为什么：编辑器对话框可能保存或丢弃场景，崩溃提示会结束进程；只有回答无害的启动提示才会自动处理，其他都必须明确指定 `button`。
- **测试 NPC 行为、战斗或攻城。**
  - 为什么：工具只驱动玩家一个角色（行走、使用、摆位）。AI 和战斗需要实际进游戏测试。
- **在 Windows 以外运行 XSD/XSLT 或实时编辑器。**
  - 为什么：它们依赖 .NET Framework 和只有 Windows 版的 Modding Kit；浏览和文件编辑在其他系统上也能用。

## 如何配置

先构建并检查环境：

```bash
git clone <本仓库> MB2-MCP
cd MB2-MCP
npm install
npm run build
node dist/index.js doctor     # 检查游戏、索引、XSD、.NET、Modding Kit
node dist/index.js config     # 用你的真实路径打印下面几段配置
```

下面的例子使用服务器名 `bannerlord`，工具会显示为 `mcp__bannerlord__<工具名>`。请把路径换成你自己的
（`node dist/index.js config claude|codex|dsh` 会直接打印可粘贴的版本）。

### Claude Code

```bash
claude mcp add bannerlord --scope user -e MB2_GAME_DIR="D:\SteamLibrary\steamapps\common\Mount & Blade II Bannerlord" -- "C:\Program Files\nodejs\node.exe" D:\MB2-MCP\dist\index.js
```

也可以在 Mod 项目里放一个项目级 `.mcp.json`（[示例](examples/claude-code.mcp.json)）。用 `claude mcp list` 检查。

### Codex

Codex CLI、桌面版和 IDE 插件共用 `~/.codex/config.toml`（[示例](examples/codex.config.toml)）：

```toml
[mcp_servers.bannerlord]
command = 'C:\Program Files\nodejs\node.exe'
args = ['D:\MB2-MCP\dist\index.js']
startup_timeout_sec = 30
tool_timeout_sec = 300
default_tools_approval_mode = "writes"   # 只读工具已标注，只有修改操作需要确认

[mcp_servers.bannerlord.env]
MB2_GAME_DIR = 'D:\SteamLibrary\steamapps\common\Mount & Blade II Bannerlord'
```

或者：`codex mcp add bannerlord --env MB2_GAME_DIR="…" -- "C:\Program Files\nodejs\node.exe" D:\MB2-MCP\dist\index.js`。

### DeepSeek Harness

合并进 `~/.dsh/cordis.patch.yml`（所有配置档）或 `~/.dsh/profiles/<配置档>/cordis.patch.yml`
（[示例](examples/dsh.cordis.patch.yml)），dsh 会自动重新加载：

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

其他 MCP 客户端（Cursor、Cline、Windsurf、Cherry Studio 等）：`node dist/index.js config json` 会打印通用的 `mcpServers` 配置。

### 选项（环境变量）

| 变量 | 含义 |
|---|---|
| `MB2_GAME_DIR` | 游戏目录（不设置则自动识别） |
| `MB2_MODULE_DIRS` | 存放你自己模块的额外目录（可写），用 `;` 分隔；需要链接进 `<游戏>/Modules` 游戏才会加载 |
| `MB2_TOOLSETS` | 开放的工具组：`core,edit,l10n,scene,assets,editor,logs`（默认全部；上下文窗口小时可以少开几组） |
| `MB2_WORKSHOP=0` | 不索引 Steam 创意工坊模块 |
| `MB2_READONLY=1` | 禁用模块编辑；清理操作仍可删除服务器自身的记录 |
| `MB2_DATA_DIR` | 修改历史与备份目录（默认 `%LOCALAPPDATA%\mb2-mcp`） |
| `MB2_MAX_OUTPUT` | 单次工具结果的最大字符数（默认 40000） |
| `MB2_POWERSHELL` | 用于 XSD/XSLT 的 Windows PowerShell 路径 |
| `MB2_DEBUG=1` | 把工具耗时输出到 stderr |
| `MB2_REDACT=0` | 在工具输出中显示真实的用户目录、用户名和计算机名（默认遮盖） |

发布分支前请运行 `npm run privacy`：它会检查 git 和 npm 将要发布的每个文件，查找你的用户目录、用户名和计算机名、邮箱、
密钥和令牌，以及你在 `%USERPROFILE%\.mb2-mcp\privacy-terms.txt`（放在仓库之外）里列出的私有词。请用 git 或 `npm pack` 发布，
不要直接打包整个文件夹。
还应单独运行 `npm pack --dry-run --ignore-scripts` 并检查文件清单：该命令失败时，隐私检查脚本目前可能漏查 npm
包内文件。源码扫描通过不代表上述运行时限制已消除。

### 实时编辑器（可选）

1. 安装 Modding Kit（Steam → 库 → 工具）。
2. 在游戏关闭时让助手执行 `editor_bridge_install`。游戏更新后、以及更新 MB2-MCP 后 `editor_status` 提示桥接版本过旧时，都要重新执行；
   并重启 MCP 客户端，让它加载新的服务器。
3. `editor_launch modules=["MyMod"]` 启动编辑器；轮询 `editor_status`，直到显示 `edit mode ON`（1–5 分钟）。

耗时较长的工具（启动编辑器、`editor_play start`、`mission walk`）默认最多等待两分钟。请像示例那样把工具超时设为 300 秒，
或者传 `wait_seconds=0` 立即返回后再轮询。

---

## 许可证

本项目采用 [MIT 许可证](LICENSE)。上游致谢与许可见[第三方许可说明](THIRD_PARTY_NOTICES.md)。

<sub>本项目与 TaleWorlds Entertainment 无关，也未获其认可。感谢 TaleWorlds 带来《霸主》及其 Mod 工具，感谢
[BannerlordSceneToolkit](https://github.com/fiefevictionnotice/BannerlordSceneToolkit) 展示了有哪些编辑器 API 可用。</sub>
