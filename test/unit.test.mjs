// Unit tests for the text-preserving XML machinery (no game install needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const imp = (p) => import(pathToFileURL(path.join(dist, p)).href);
const { scanXml, parseTree, getAttr, parseMiniPath, selectMiniPath, miniPathToXPath } = await imp("xml/scanner.js");
const { applyEdits, insertChildEdit, setAttributesEdits, removeElementEdit, replaceElementEdit, reindent, detectIndentUnit } = await imp("xml/edit.js");
const { checkWellFormed } = await imp("xml/wellformed.js");
const { decodeBuffer, encodeText, fixXmlDeclarationEncoding } = await imp("util/text.js");
const { escapeAvt, unescapeAvt, renderTemplate, parseTemplate, mergeOps, buildMatch, emptyOps } = await imp("ops/xslt.js");
const { normalizeForDiff } = await imp("ops/patching.js");
const { Args } = await imp("util/args.js");
const { placeholderMismatch, generateStringId } = await imp("ops/l10n.js");
const { unifiedDiff } = await imp("util/diff.js");
const { parseSnippet } = await imp("ops/objects-edit.js");
const { compareVersions } = await imp("model/modules.js");

test("scanner keeps offsets, lines and decoded attributes", () => {
  const xml = `<?xml version="1.0"?>\r\n<Items>\r\n\t<!-- c -->\r\n\t<Item id="a" name="{=x}A &amp; B"\r\n\t\tweight="1"/>\r\n\t<Item id='b'><Flags x="1"/></Item>\r\n</Items>\r\n`;
  const { root, errors } = parseTree(xml);
  assert.equal(errors.length, 0);
  assert.equal(root.name, "Items");
  const [a, b] = root.children;
  assert.equal(getAttr(a, "name"), "{=x}A & B");
  assert.equal(a.line, 4);
  assert.equal(xml.slice(a.start, a.end).endsWith("/>"), true);
  assert.equal(b.line, 6);
  assert.equal(xml.slice(b.start, b.end), `<Item id='b'><Flags x="1"/></Item>`);
});

test("scanner reports mismatched and unclosed tags", () => {
  const { errors } = scanXml(`<a><b></a>`);
  assert.ok(errors.some((e) => /not closed/.test(e.message)));
  const r2 = scanXml(`<a><b>`);
  assert.ok(r2.errors.some((e) => /never closed/.test(e.message)));
});

test("well-formedness catches raw ampersands with a clear message", () => {
  const issues = checkWellFormed(`<a x="Salt & Pepper"/>`);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /Unescaped '&'/);
  assert.equal(checkWellFormed(`<a x="a &amp; b &#10; &lt;"/>`).length, 0);
  assert.ok(checkWellFormed(`<a><b></a>`).length > 0);
});

test("utf-16 files round-trip with BOM", () => {
  const text = `<?xml version="1.0" encoding="utf-16"?>\r\n<base><string id="a" text="简体中文"/></base>`;
  const buf = encodeText(text, "utf16le");
  assert.equal(buf[0], 0xff);
  const d = decodeBuffer(buf);
  assert.equal(d.encoding, "utf16le");
  assert.equal(d.text, text);
  assert.match(fixXmlDeclarationEncoding(`<?xml version="1.0" encoding="utf-16"?><a/>`, "utf8"), /encoding="utf-8"/);
});

test("insertChildEdit handles self-closing, inline and normal containers", () => {
  const layout = { eol: "\n", unit: "\t" };
  let t = `<Module>\n\t<Xmls />\n</Module>\n`;
  let root = parseTree(t).root;
  t = applyEdits(t, [insertChildEdit(t, root.children[0], `<XmlNode>\n  <XmlName id="Items" path="x" />\n</XmlNode>`, layout)]);
  assert.equal(t, `<Module>\n\t<Xmls>\n\t\t<XmlNode>\n\t\t\t<XmlName id="Items" path="x" />\n\t\t</XmlNode>\n\t</Xmls>\n</Module>\n`);
  t = `<Items></Items>`;
  root = parseTree(t).root;
  t = applyEdits(t, [insertChildEdit(t, root, `<Item id="a"/>`, layout)]);
  assert.equal(t, `<Items>\n\t<Item id="a"/>\n</Items>`);
  t = `<Items>\r\n    <Item id="a"/>\r\n</Items>\r\n`;
  root = parseTree(t).root;
  t = applyEdits(t, [insertChildEdit(t, root, `<Item id="b">\n\t<X/>\n</Item>`, { eol: "\r\n", unit: detectIndentUnit(t, root) })]);
  assert.equal(t, `<Items>\r\n    <Item id="a"/>\r\n    <Item id="b">\r\n        <X/>\r\n    </Item>\r\n</Items>\r\n`);
});

test("setAttributesEdits edits only the touched characters and follows the layout", () => {
  const t = `<Items>\n\t<Item\n\t\tid="a"\n\t\tweight="1"\n\t\tvalue="2" />\n</Items>`;
  const el = parseTree(t).root.children[0];
  const out = applyEdits(t, setAttributesEdits(t, el, [["weight", "1.5"], ["value", null], ["culture", "Culture.empire"]]));
  assert.equal(out, `<Items>\n\t<Item\n\t\tid="a"\n\t\tweight="1.5"\n\t\tculture="Culture.empire" />\n</Items>`);
  const t2 = `<a x="1"/>`;
  const out2 = applyEdits(t2, setAttributesEdits(t2, parseTree(t2).root, [["y", 'q"<&']]));
  assert.equal(out2, `<a x="1" y="q&quot;&lt;&amp;"/>`);
});

test("remove and replace keep surrounding formatting", () => {
  const t = `<Items>\n\t<Item id="a"/>\n\t<Item id="b"/>\n</Items>\n`;
  const root = parseTree(t).root;
  assert.equal(applyEdits(t, [removeElementEdit(t, root.children[0])]), `<Items>\n\t<Item id="b"/>\n</Items>\n`);
  const r = applyEdits(t, [replaceElementEdit(t, root.children[1], `<Item id="b">\n    <Flags/>\n</Item>`, { eol: "\n", unit: "\t" })]);
  assert.equal(r, `<Items>\n\t<Item id="a"/>\n\t<Item id="b">\n\t\t<Flags/>\n\t</Item>\n</Items>\n`);
});

test("reindent converts snippet indentation", () => {
  assert.equal(reindent(`<a>\n  <b>\n    <c/>\n  </b>\n</a>`, "\t", "\t", "\n"), `\t<a>\n\t\t<b>\n\t\t\t<c/>\n\t\t</b>\n\t</a>`);
  assert.equal(reindent(`\t\t<a>\n\t\t\t<b/>\n\t\t</a>`, "", "  ", "\n"), `<a>\n  <b/>\n</a>`);
});

test("mini path selects nested elements and renders XPath", () => {
  const t = `<NPCCharacter id="x"><skills><skill id="OneHanded" value="1"/><skill id="Bow" value="2"/></skills></NPCCharacter>`;
  const root = parseTree(t).root;
  const steps = parseMiniPath("skills/skill[@id='Bow']");
  const hits = selectMiniPath(root, steps);
  assert.equal(hits.length, 1);
  assert.equal(getAttr(hits[0], "value"), "2");
  assert.equal(miniPathToXPath(steps), "skills/skill[@id='Bow']");
  assert.equal(selectMiniPath(root, parseMiniPath("skills/skill[2]")).length, 1);
  assert.throws(() => parseMiniPath("skills//skill[contains(@id,'x')]"));
});

test("XSLT literal results escape Bannerlord {=id} text", () => {
  const x = `<Item id="a" name="{=abc}Sword"><X t="{B}"/></Item>`;
  const esc = escapeAvt(x);
  assert.equal(esc, `<Item id="a" name="{{=abc}}Sword"><X t="{{B}}"/></Item>`);
  assert.equal(unescapeAvt(esc), x);
});

test("XSLT templates round-trip and merge", () => {
  const match = buildMatch("Item", "torch", 1, undefined, "");
  assert.equal(match, "/*/Item[@id='torch']");
  let { ops } = mergeOps(null, { set: [["weight", "0.5"]], unset: ["prefab"] }, "\t", "\n");
  ({ ops } = mergeOps(ops, { set: [["value", "7"]], append: [`<Flags Civilian="true" />`] }, "\t", "\n"));
  const tpl = renderTemplate(match, ops, "\t", "\n");
  const sheet = `<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">\n${tpl}\n</xsl:stylesheet>`;
  assert.equal(checkWellFormed(sheet).length, 0);
  const parsed = parseTemplate(sheet, parseTree(sheet).root.children[0]);
  assert.deepEqual(parsed.set, [["weight", "0.5"], ["value", "7"]]);
  assert.deepEqual(parsed.unset, ["prefab"]);
  assert.equal(parsed.append.length, 1);
  const removed = mergeOps(parsed, { remove: true }, "\t", "\n").ops;
  assert.equal(renderTemplate(match, removed, "\t", "\n"), `<xsl:template match="/*/Item[@id='torch']" />`);
  const replaced = mergeOps(null, { replace: `<Item id="torch" name="{=x}T"/>` }, "\t", "\n").ops;
  const withSet = mergeOps(replaced, { set: [["weight", "3"]] }, "\t", "\n").ops;
  assert.match(withSet.replace, /weight="3"/);
  assert.deepEqual(emptyOps().set, []);
});

test("diff normalization isolates changed attributes", () => {
  const a = `<Item id="t" a="1" b="2" c="3" d="4">\n  <X />\n</Item>`;
  const b = `<Item id="t" a="1" c="3" d="4" b="9">\n  <X></X>\n</Item>`;
  const d = unifiedDiff(normalizeForDiff(a), normalizeForDiff(b));
  assert.match(d, /-\s+b="2"/);
  assert.match(d, /\+\s+b="9"/);
  assert.ok(!/<X/.test(d.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-")).join("\n")));
});

test("Args coerces what different clients send", () => {
  const a = new Args({ m1: { a: 1, b: "x" }, m2: '{"a":"1"}', m3: ["a=1", "b = two"], m4: "a=1; b=2", l1: '["x","y"]', l2: "x, y", n: "5", f: "true" });
  assert.deepEqual(a.map("m1"), [["a", "1"], ["b", "x"]]);
  assert.deepEqual(a.map("m2"), [["a", "1"]]);
  assert.deepEqual(a.map("m3"), [["a", "1"], ["b", "two"]]);
  assert.deepEqual(a.map("m4"), [["a", "1"], ["b", "2"]]);
  assert.deepEqual(a.list("l1"), ["x", "y"]);
  assert.deepEqual(a.list("l2"), ["x", "y"]);
  assert.equal(a.int("n", 0), 5);
  assert.equal(a.bool("f", false), true);
});

test("snippets: containers are unwrapped, ids required", () => {
  const objs = parseSnippet(`<?xml version="1.0"?><Items><Item id="a"/><CraftedItem id="b"/></Items>`);
  assert.deepEqual(objs.map((o) => `${o.tag}.${o.id}`), ["Item.a", "CraftedItem.b"]);
  assert.throws(() => parseSnippet(`<Item name="x"/>`), /no id/);
});

test("localization helpers", () => {
  assert.equal(placeholderMismatch("{PLAYER.NAME} joined {CLAN}", "{CLAN}加入了{PLAYER.NAME}"), null);
  assert.ok(placeholderMismatch("{PLAYER.NAME} joined", "加入了"));
  const taken = new Set(["abc"]);
  const id = generateStringId(taken);
  assert.match(id, /^[A-Za-z0-9]{8}$/);
  assert.ok(taken.has(id));
});

test("version comparison", () => {
  assert.equal(compareVersions("v1.4.8", "v1.4.8.119303"), -1);
  assert.equal(compareVersions("v1.2.10", "v1.2.9"), 1);
  assert.equal(compareVersions("e1.7.0", "v1.7"), 0);
});

test("screenshots: BMP decode, downscale and PNG encode", async () => {
  const { decodeBmp, fitImage, encodePng, imageMime } = await imp("util/image.js");
  const zlib = await import("node:zlib");
  // 4×2 bottom-up 32-bit BMP: bottom row red, top row blue (stored as BGRA)
  const w = 4;
  const h = 2;
  const header = Buffer.alloc(54);
  header.write("BM", 0, "latin1");
  header.writeUInt32LE(54 + w * h * 4, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(w, 18);
  header.writeInt32LE(h, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(32, 28);
  const px = Buffer.alloc(w * h * 4);
  for (let x = 0; x < w; x++) {
    px.set([0, 0, 255, 255], x * 4); // first stored row = bottom = red
    px.set([255, 0, 0, 255], (w + x) * 4); // top = blue
  }
  const bmp = Buffer.concat([header, px]);
  assert.equal(imageMime(bmp), "image/bmp");
  const img = decodeBmp(bmp);
  assert.deepEqual([img.width, img.height], [4, 2]);
  assert.deepEqual([...img.rgb.subarray(0, 3)], [0, 0, 255]); // top-left is blue
  assert.deepEqual([...img.rgb.subarray(4 * 3, 4 * 3 + 3)], [255, 0, 0]); // bottom-left is red
  const small = fitImage(img, 2, 2);
  assert.deepEqual([small.width, small.height], [2, 1]);
  assert.deepEqual([...small.rgb.subarray(0, 3)], [128, 0, 128]);
  const png = encodePng(img);
  assert.equal(imageMime(png), "image/png");
  assert.equal(png.readUInt32BE(16), 4); // IHDR width
  const idatLen = png.readUInt32BE(33);
  assert.equal(png.toString("latin1", 37, 41), "IDAT");
  const raw = zlib.inflateSync(png.subarray(41, 41 + idatLen));
  assert.equal(raw.length, (w * 3 + 1) * h);
  assert.deepEqual([...raw.subarray(1, 4)], [0, 0, 255]);
});

test("game dialogs: origin description and one-line summary", async () => {
  const { describeOrigin, dialogLine, WIN_HELPER_CS } = await imp("scene/windows.js");
  assert.match(describeOrigin("TaleWorlds.ModuleManager.dll"), /SubModule\.xml/);
  assert.equal(describeOrigin("Foo.dll"), "Foo.dll");
  const line = dialogLine({ hwnd: "1", pid: 7, title: "RGL WARNING", origin: "TaleWorlds.ModuleManager.dll", texts: ["", "C:\\x\\TaleWorlds.Engine.dll@1@0\nC:\\x\\TaleWorlds.ModuleManager.dll@2@535"], buttons: [{ id: 2, text: "OK" }] });
  assert.match(line, /^'RGL WARNING' \(pid 7, window 1\)/);
  assert.match(line, /buttons: OK$/);
  assert.doesNotMatch(WIN_HELPER_CS, /\$\{/); // plain C# 5, no template holes

  // The scene editor's modal Qt dialogs: texts and buttons, never a default answer.
  const qt = dialogLine({ hwnd: "9", pid: 7, qt: true, title: "Save", origin: "", texts: ["Do you want to save the scene?"], buttons: [{ id: -1, text: "Yes" }, { id: -1, text: "No" }, { id: -1, text: "Cancel" }] });
  assert.match(qt, /^'Save' \(scene editor dialog, pid 7, window 9\) — "Do you want to save the scene\?"; buttons: Yes \/ No \/ Cancel/);
  assert.match(qt, /only when you name it/);
  assert.match(WIN_HELPER_CS, /if \(d\.FileDialog \|\| d\.Qt\) return null;/);
  // Prompts that are easy to misread say what their buttons do.
  const upload = dialogLine({ hwnd: "3", pid: 4, system: true, title: "*_*", origin: "", texts: ["The application faced a problem. We need to collect necessary files to fix this problem. Would you like to proceed?"], buttons: [{ id: 6, text: "是(Y)" }, { id: 7, text: "否(N)" }] });
  assert.match(upload, /shown by Windows for the game, csrss pid 4/);
  assert.match(upload, /No collects and uploads nothing/);
  const ignore = dialogLine({ hwnd: "5", pid: 7, title: "Always Ignore?", origin: "", texts: ["Would you like to always ignore this failure?"], buttons: [{ id: 1, text: "确定" }, { id: 2, text: "取消" }] });
  assert.match(ignore, /Cancel = keep reporting it/);
});

test("launch watcher: follow-up prompts only after a module warning it answered", async () => {
  const W = await imp("scene/windows.js");
  assert.deepEqual(W.MODULE_WARNING_FOLLOW_UPS, { "*_*": "No", "Always Ignore?": "Cancel" });
  assert.equal(W.STARTUP_NOTICES["Mod change detected"], "OK");
  // "~Title=button" rules are follow-ups, valid for 5 minutes after the watcher pressed OK on a module warning.
  assert.match(W.WIN_HELPER_CS, /if \(t\.StartsWith\("~"\)\) followUps\[t\.Substring\(1\)\.Trim\(\)\] = b;/);
  assert.match(W.WIN_HELPER_CS, /\(DateTime\.UtcNow - lastWarning\)\.TotalSeconds < 300\) byTitle = followUps\.TryGetValue/);
  assert.match(W.WIN_HELPER_CS, /if \(warning\) lastWarning = DateTime\.UtcNow;/);
  // What a launch logged (one round per module warning), as editor_status summarizes it.
  const round = [
    { hwnd: "1", pid: 50, title: "RGL WARNING", origin: "TaleWorlds.ModuleManager.dll", texts: [], buttons: [], pressed: "确定", closed: true },
    { hwnd: "2", pid: 900, system: true, title: "*_*", origin: "", texts: [], buttons: [], pressed: "否(N)", closed: true },
    { hwnd: "3", pid: 50, title: "Always Ignore?", origin: "", texts: [], buttons: [], pressed: "取消", closed: true },
  ];
  assert.equal(
    W.answeredSummary([...round, ...round], [50]),
    "Startup prompts answered automatically: 6 (TaleWorlds.ModuleManager.dll ×2, '*_*' → 否(N) ×2, 'Always Ignore?' → 取消 ×2)",
  );
  assert.equal(W.answeredSummary(round.filter((d) => !d.system), [51]), null); // another game's entries
});

test("XSLT imports stay inside the mod: no URLs, network shares or other folders", async (t) => {
  const { DotnetBridge, findPowerShell } = await imp("dotnet.js");
  if (!findPowerShell(null)) return t.skip("Windows PowerShell not available");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const net = await import("node:net");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mb2mcp-xslt-"));
  let connections = 0;
  const server = net.createServer((s) => {
    connections++;
    s.destroy();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const xdir = path.join(root, "Modules", "SomeMod", "ModuleData", "XSLT");
    fs.mkdirSync(path.join(xdir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "Modules", "SomeMod", "SubModule.xml"), '<Module><Id value="SomeMod"/></Module>');
    fs.writeFileSync(path.join(root, "outside.xsl"), '<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"/>');
    const sheet = (body) => `<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">${body}<xsl:template match="/"/></xsl:stylesheet>`;
    const files = {
      "lib/common.xsl": '<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"/>',
      "lib/bad.xsl": `<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><xsl:import href="http://127.0.0.1:${port}/x.xsl"/></xsl:stylesheet>`,
      "ok.xslt": sheet('<xsl:import href="lib/common.xsl"/>'),
      "http.xslt": sheet(`<xsl:import href="http://127.0.0.1:${port}/x.xsl"/>`),
      "include.xslt": sheet(`<xsl:include href="https://127.0.0.1:${port}/x.xsl"/>`),
      "share.xslt": sheet('<xsl:import href="\\\\127.0.0.1\\share\\x.xsl"/>'),
      "fileurl.xslt": sheet('<xsl:import href="file:///C:/Windows/win.ini"/>'),
      "up.xslt": sheet('<xsl:import href="../../../../outside.xsl"/>'),
      "nested.xslt": sheet('<xsl:import href="lib/bad.xsl"/>'),
    };
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(xdir, name), body);
    const names = ["ok.xslt", "http.xslt", "include.xslt", "share.xslt", "fileurl.xslt", "up.xslt", "nested.xslt"];
    const res = await new DotnetBridge(path.join(root, "data"), null).run(names.map((n) => ({ op: "xslt-compile", xslt: path.join(xdir, n) })));
    assert.equal(res[0].ok, true, JSON.stringify(res[0]));
    for (let i = 1; i < names.length; i++) {
      assert.equal(res[i].ok, false, names[i]);
      assert.match(res[i].error, /Refusing xsl:(import|include)/, names[i]);
    }
    assert.equal(connections, 0);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("redaction: home folder, user and computer names leave tool output, numbers stay", async () => {
  const { makeRedactor } = await imp("util/redact.js");
  // Invented names; paths are assembled at run time so this file never contains a literal user folder.
  const user = "testuser";
  const host = "TESTHOST-7";
  const win = (...p) => p.join("\\");
  const home = win("C:", "Users", user);
  const r = makeRedactor(true, home, user, host);
  assert.equal(r.text(win(home, "Documents", "x.png")), win("%USERPROFILE%", "Documents", "x.png"));
  assert.equal(r.text(`${home.replace(/\\/g, "/").toLowerCase()}/AppData/Local/mb2-mcp`), "%USERPROFILE%/AppData/Local/mb2-mcp");
  assert.equal(r.text(JSON.stringify({ p: win(home, "Desktop") })), JSON.stringify({ p: win("%USERPROFILE%", "Desktop") }));
  assert.equal(r.text(win("D:", "Users", user, "stuff")), win("D:", "Users", "<user>", "stuff"));
  assert.equal(r.text(`Computer: ${host} User: ${user}`), "Computer: <computer> User: <user>");
  assert.equal(r.text(`\\\\${host}\\share`), "\\\\<computer>\\share");
  assert.equal(r.text(`${user}s met ${user} in a story`), `${user}s met ${user} in a story`); // plain words stay
  // A numeric user name only goes in paths and after "User:", never in data such as prices.
  const n = makeRedactor(true, win("C:", "Users", "67890"), "67890", "BOX-12345");
  assert.equal(n.text(`Computer: BOX-12345 User: 67890 | price 67890 | ${win("C:", "Users", "67890", "x")}`), `Computer: <computer> User: <user> | price 67890 | ${win("%USERPROFILE%", "x")}`);
  assert.deepEqual(r.arg({ path: win("%USERPROFILE%", "Documents", "a.png"), list: [win("D:", "Users", "<user>", "x"), 3] }), { path: win(home, "Documents", "a.png"), list: [win("D:", "Users", user, "x"), 3] });
  const off = makeRedactor(false, home, user, host);
  assert.equal(off.text(home), home);
});

test("read_logs only reads files really inside the game's log folders", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const L = await imp("ops/logs.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mb2mcp-logs-"));
  const saved = process.env.ProgramData;
  process.env.ProgramData = root;
  try {
    const game = path.join(root, "Mount and Blade II Bannerlord");
    fs.mkdirSync(path.join(game, "logs"), { recursive: true });
    fs.mkdirSync(path.join(game, "logs2"), { recursive: true });
    fs.mkdirSync(path.join(root, "outside"), { recursive: true });
    fs.writeFileSync(path.join(game, "logs", "rgl_log_1.txt"), "inside\n");
    fs.writeFileSync(path.join(game, "logs2", "secret.txt"), "look-alike folder\n");
    fs.writeFileSync(path.join(root, "outside", "secret.txt"), "outside\n");
    assert.equal(L.resolveLogFile(path.join(game, "logs", "rgl_log_1.txt")), fs.realpathSync(path.join(game, "logs", "rgl_log_1.txt")));
    assert.throws(() => L.resolveLogFile(path.join(game, "logs", "..", "..", "outside", "secret.txt")), /Only files inside/);
    assert.throws(() => L.resolveLogFile(path.join(game, "logs2", "secret.txt")), /Only files inside/);
    if (process.platform === "win32") {
      fs.symlinkSync(path.join(root, "outside"), path.join(game, "logs", "link"), "junction");
      assert.throws(() => L.resolveLogFile(path.join(game, "logs", "link", "secret.txt")), /Only files inside/);
      assert.ok(!L.listLogs(500).some((f) => f.path.includes(path.join("logs", "link"))), "listing must not follow links");
      fs.unlinkSync(path.join(game, "logs", "link"));
    }
  } finally {
    if (saved === undefined) delete process.env.ProgramData;
    else process.env.ProgramData = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a module's <XmlName path> cannot point outside its ModuleData folder", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { resolveXmlNode } = await imp("model/modules.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mb2mcp-xmlnode-"));
  try {
    const dir = path.join(root, "Modules", "SomeMod");
    fs.mkdirSync(path.join(dir, "ModuleData"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ModuleData", "items.xml"), "<Items/>");
    fs.writeFileSync(path.join(root, "private.xml"), "<Secret/>");
    const mod = { dir };
    assert.equal(resolveXmlNode(mod, { id: "Items", path: "items" }).kind, "file");
    for (const p of ["../../../private", "..\\..\\..\\private", "sub/../../../../private"]) {
      const r = resolveXmlNode(mod, { id: "Items", path: p });
      assert.equal(r.kind, "outside", p);
      assert.equal(r.steps.length, 0, p);
    }
    // A drive letter either stays inside ModuleData (same drive) or is refused (other drive) — never read elsewhere.
    assert.ok(["outside", "missing"].includes(resolveXmlNode(mod, { id: "Items", path: "C:/Windows/win" }).kind));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("forget_history deletes old journal entries and the backups only they used", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { History } = await imp("ops/history.js");
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "mb2mcp-hist-"));
  try {
    const h = new History(data, false);
    const blobs = path.join(data, "history", "blobs");
    fs.mkdirSync(blobs, { recursive: true });
    for (const b of ["old", "shared", "new"]) fs.writeFileSync(path.join(blobs, b), b);
    const entry = (backups) => ({ tool: "t", module: "M", summary: "s", files: backups.map((b, i) => ({ path: `C:\\x${i}`, backup: b, existed: true, afterHash: "h" })), createdDirs: [] });
    h.append(entry(["old", "shared"]));
    h.append(entry(["shared", "new"]));
    // Age the first entry by two days.
    const journal = path.join(data, "history", "journal.jsonl");
    const lines = fs.readFileSync(journal, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    lines[0].time = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    fs.writeFileSync(journal, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const r = h.forget(1);
    assert.deepEqual([r.removed, r.kept], [1, 1]);
    assert.deepEqual(fs.readdirSync(blobs).sort(), ["new", "shared"]); // "old" was only needed by the forgotten edit
    assert.equal(h.entries(10).length, 1);
    assert.equal(h.forget().removed, 1);
    assert.deepEqual(fs.readdirSync(blobs), []);
    assert.equal(h.entries(10).length, 0);
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test("cleanup deletes only the server's own files in the bridge folder", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { cleanupOwnFiles } = await imp("tools/scene.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb2mcp-bridge-"));
  try {
    const mine = ["screenshot_946684800000.png", "screenshot-tmp-12-34.png", "shot.capture.bmp", "x.preview.png", "walk_1_2000-01-01T00-00-00-000Z.json", "dialogs.log", "bridge.log"];
    const keep = ["bridge.json", "autostart.json", "notes.txt", "walk_notes.json", "my_screenshot.png"];
    for (const f of [...mine, ...keep]) fs.writeFileSync(path.join(dir, f), "x");
    fs.mkdirSync(path.join(dir, "screenshot_dir.png"));
    const r = cleanupOwnFiles(dir);
    assert.equal(r.files, mine.length);
    assert.deepEqual(fs.readdirSync(dir).sort(), [...keep, "screenshot_dir.png"].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("window helper compiles with the Windows C# compiler", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows only");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { winHelper } = await imp("scene/windows.js");
  const { findCsc } = await imp("scene/bridge.js");
  if (!findCsc()) return t.skip("csc.exe not found");
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "mb2mcp-helper-"));
  try {
    const exe = await winHelper(data);
    assert.ok(fs.existsSync(exe));
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test("bridge play mode: guarded live editing, real walking, the editor's own entry points", async () => {
  const { BRIDGE_CS } = await imp("scene/bridge-cs.js");
  // Live scene commands refuse to touch the edited scene while play mode replaces it.
  assert.match(BRIDGE_CS, /private Scene RequireScene\(\)[\s\S]{0,400}if \(EditorPlay\(\)\)\s*throw new Exception\("The editor is in play mode/);
  // A mission object left over in edit mode is not play mode (editing must keep working).
  assert.match(BRIDGE_CS, /return EditorPlay\(\) \|\| \(Mission\.Current != null && !MBEditor\.IsEditModeOn\);/);
  // Play starts through the managed entry the Play button reaches and stops like the leave key.
  assert.match(BRIDGE_CS, /GetMethod\("StartMissionForEditor"/);
  assert.match(BRIDGE_CS, /MBEditor\.LeaveEditMissionMode\(\); \/\/ what the leave key does/);
  // The walk test moves the agent with AI and scripted positions, never by teleporting, and gives control back.
  const walk = BRIDGE_CS.slice(BRIDGE_CS.indexOf("private object WalkStart("), BRIDGE_CS.indexOf("private static Dictionary<string, object> WalkReport("));
  assert.ok(walk.length > 2000);
  assert.doesNotMatch(walk, /TeleportToPosition/);
  assert.match(walk, /actor\.Controller = AgentControllerType\.AI;/);
  assert.match(walk, /SetScriptedPosition\(ref wp, false\)/);
  assert.match(walk, /job\.Actor\.Controller = job\.OldController;/);
  assert.doesNotMatch(BRIDGE_CS, /\$\{/);
});

test("mission summary line, unsaved-change tracking and argument checks of the play tools", async () => {
  const S = await imp("tools/scene.js");
  const line = S.missionLine({ editorPlay: true, scene: "siege_review", levels: "siege", state: "Continuing", mode: "StartUp", loaded: true, agents: 3, mainAgent: { index: 7, position: [1, 2, 3], direction: [0, 1, 0], controller: "Player", active: true, mounted: true, health: 100 } });
  assert.match(line, /^Play mode \(editor\): scene 'siege_review' levels 'siege', Continuing, mode StartUp, 3 agents; player #7 at \(1.000, 2.000, 3.000\) \(mounted\), controller Player\./);
  assert.match(line, /Live scene_\* commands wait until play mode ends/);
  assert.equal(S.unsavedLiveEdits("never_edited", null), null);
  const { playTools } = await imp("tools/play.js");
  const { Args } = await imp("util/args.js");
  const mission = playTools.find((t) => t.name === "mission");
  await assert.rejects(async () => mission.handler(new Args({ action: "walk" }), {}), /Give 'points'/);
  await assert.rejects(async () => mission.handler(new Args({ action: "walk", points: [[1, 2]] }), {}), /point 1 must be \[x, y, z\]/);
  await assert.rejects(async () => mission.handler(new Args({ action: "use" }), {}), /'entity' name or 'tag'/);
  for (const t of playTools) {
    assert.equal(t.group, "editor");
    assert.ok(t.description.length > 200, t.name);
  }
});

test("editor bridge never asks the engine for old prefab names", async () => {
  const { BRIDGE_CS, BRIDGE_VERSION } = await imp("scene/bridge-cs.js");
  // GameEntity.GetOldPrefabName() dereferences a null engine pointer on entities created at runtime
  // (CreateEmpty + AddMultiMesh): an access violation that hangs the editor (crash seen in 0.2.0).
  assert.doesNotMatch(BRIDGE_CS, /\.GetOldPrefabName\s*\(/);
  // Prefab names are only queried for entities the bridge did not build from a bare mesh.
  assert.match(BRIDGE_CS, /if \(!_meshEntities\.Contains\(e\.Pointer\)\)\s*\{\s*try \{ string p = e\.GetPrefabName\(\)/);
  assert.match(BRIDGE_CS, new RegExp(`Version = "${BRIDGE_VERSION.replace(/\./g, "\\.")}"`));
  assert.doesNotMatch(BRIDGE_CS, /\$\{/);
});

// ---- asset packages, game logs, module links -------------------------------------------------

function tpacBuffer(records, opts = {}) {
  const u32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const u64 = (v) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v));
    return b;
  };
  const str = (s) => {
    const b = Buffer.from(s, "utf8");
    return Buffer.concat([u32(b.length), b]);
  };
  const rec = ({ type, guid, name, meta = Buffer.alloc(0), segments = [] }) =>
    Buffer.concat([
      Buffer.from(type, "hex"),
      guid,
      u32(1),
      str(name),
      u64(meta.length),
      meta,
      Buffer.alloc(8),
      u32(segments.length),
      ...segments.map((s) => Buffer.concat([u64(0), u64(0), u64(0), s.owner, Buffer.from(s.type, "hex"), u64(0), u32(0), Buffer.from([0])])),
      u32(0),
    ]);
  const table = Buffer.concat(records.map(rec));
  const head = Buffer.concat([Buffer.from("TPAC"), u32(2), Buffer.alloc(16, 0x99), u32(records.length), u64(opts.badSize ? table.length + 7 : table.length)]);
  return { buf: Buffer.concat([head, table, Buffer.alloc(64)]), u32, str };
}

test("asset packages: sub-mesh materials, broken names, scan fallback", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const T = await imp("scene/tpac.js");
  const TYPES = { mesh: "978b8fa07c19ea4bb95b53846cae834e", physics: "0e8e52e8b664614ebae07569c0452aea", material: "9313b01d0269194f83bab37a39830717" };
  const EDIT = "5f98413dd224c14f82e46a6e0da3f4e2";
  const mat = Buffer.alloc(16, 0xab);
  const owner1 = Buffer.alloc(16, 0x11);
  const owner2 = Buffer.alloc(16, 0x22);
  const { u32, str } = tpacBuffer([]);
  // [owner][sub-mesh name][u32][u32 n + n strings][material GUID] per sub-mesh
  const meta = Buffer.concat([Buffer.from("hdr!"), owner1, str("wall_a"), u32(7), u32(0), mat, owner2, str("wall_b"), u32(7), u32(1), str("lod"), Buffer.alloc(16)]);
  const records = [
    { type: TYPES.material, guid: mat, name: "stone_mat" },
    { type: TYPES.mesh, guid: Buffer.alloc(16, 0x33), name: "wall", meta, segments: [{ owner: owner1, type: EDIT }, { owner: owner2, type: EDIT }] },
    { type: TYPES.physics, guid: Buffer.alloc(16, 0x44), name: "bo_wall" },
    { type: TYPES.physics, guid: Buffer.alloc(16, 0x55), name: "bo_wa\u0000\u0000" },
    { type: TYPES.physics, guid: Buffer.alloc(16, 0x66), name: "bo_gate" },
  ];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mb2mcp-tpac-"));
  try {
    const dir = path.join(root, "Mod", "Assets");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "wall_geo.tpac"), tpacBuffer(records).buf);
    const info = T.readTpac(path.join(dir, "wall_geo.tpac"), { meshMaterials: true });
    assert.equal(info.parsed, "table");
    const wall = info.resources.find((r) => r.kind === "mesh");
    assert.deepEqual(wall.materials, [
      { submesh: "wall_a", guid: "ab".repeat(16) },
      { submesh: "wall_b", guid: T.NULL_GUID },
    ]);
    assert.ok(T.hasBrokenName("bo_wa\u0000\u0000"));
    assert.equal(T.displayName("bo_wa\u0000\u0000"), "bo_wa\\x00\\x00");
    assert.equal(T.guidString("ab".repeat(16)), "abababab-abab-abab-abab-abababababab");
    const mod = { id: "Mod", dir: path.join(root, "Mod"), writable: true };
    const catalog = new T.AssetCatalog();
    catalog.ensure([mod]);
    assert.equal(catalog.materialName("ab".repeat(16)), "stone_mat");
    const p = T.checkModulePackages(mod, catalog);
    assert.deepEqual(p.nullMaterials, [{ mesh: "wall", submesh: "wall_b", package: "Assets/wall_geo.tpac" }]);
    assert.equal(p.unknownMaterials.length, 0);
    assert.deepEqual(p.brokenNames.map((x) => x.name), ["bo_wa\u0000\u0000"]);
    assert.deepEqual(p.shapesWithoutMesh.map((x) => x.name), ["bo_gate"]);
    const text = T.describePackageProblems(p).join("\n");
    assert.match(text, /have NO material/);
    assert.match(text, /bo_wa\\x00\\x00/);
    // A table that does not add up falls back to scanning for names (no material check).
    fs.writeFileSync(path.join(dir, "wall_geo.tpac"), tpacBuffer(records, { badSize: true }).buf);
    const scanned = T.readTpac(path.join(dir, "wall_geo.tpac"), { meshMaterials: true });
    assert.equal(scanned.parsed, "scan");
    assert.ok(scanned.resources.some((r) => r.kind === "mesh" && r.name === "wall"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("game logs: launch modules, grouped warnings, watchdog dumps", async () => {
  const G = await imp("scene/gamelog.js");
  assert.deepEqual(G.parseLaunchModules("[12:00:00.000] Command Args: /singleplayer _MODULES_*Native*SandBoxCore*MyMod*_MODULES_\r\n"), ["Native", "SandBoxCore", "MyMod"]);
  assert.equal(G.parseLaunchModules("no args here"), null);
  const sep = "<" + "#".repeat(40) + ">";
  const errors = [
    "Build Version: 1",
    "[12:00:01.000] ",
    sep,
    "",
    "[12:00:01.000] ",
    "CONTENT WARNING: Unable to find material for mesh mymod_0000",
    "[12:00:01.000] #TaleWorlds.Native.pdb@{F6} (1): 0:1",
    "",
    "[12:00:02.000] ",
    sep,
    "",
    "[12:00:02.000] ",
    "CONTENT WARNING: Unable to find material for mesh mymod_0001",
    "[12:00:02.000] #TaleWorlds.Native.pdb@{F6} (1): 0:1",
    "",
    "[12:00:03.000] ",
    sep,
    "",
    "[12:00:03.000] ",
    " WARNING: D:\\Games\\Mount & Blade II Bannerlord\\bin\\Win64_Shipping_wEditor\\TaleWorlds.DotNet.AutoGenerated.dll@100663331@0",
    "",
    "D:\\Games\\Mount & Blade II Bannerlord\\bin\\Win64_Shipping_wEditor\\TaleWorlds.Engine.dll@100665712@0",
    "",
    "D:\\Games\\Mount & Blade II Bannerlord\\bin\\Win64_Shipping_wEditor\\TaleWorlds.ModuleManager.dll@100663388@535",
  ].join("\r\n");
  const parsed = G.parseErrorLog(errors);
  assert.equal(parsed.total, 3);
  assert.deepEqual(
    parsed.groups.map((g) => [g.key, g.count, g.items]),
    [
      ["CONTENT WARNING: Unable to find material for mesh *", 2, ["mymod_0000", "mymod_0001"]],
      ["RGL WARNING (managed stack from TaleWorlds.ModuleManager.dll)", 1, []],
    ],
  );
  const wd = G.parseWatchdogLog(
    ["[DebuggerConfiguration] -td 1234--Unable to find material for mesh mymod_0004", "User canceled dump and report generation!", "[DebuggerConfiguration] -td 1234--Unable to find material for mesh mymod_0005"].join("\n"),
  );
  assert.deepEqual(wd, { requests: 2, canceled: 1, crashes: 0, lastMessage: "Unable to find material for mesh mymod_0005", pending: "Unable to find material for mesh mymod_0005" });
  const lines = G.describeSession({ pid: 1, modules: null, errors: parsed, watchdog: wd, errorLog: "x/rgl_log_errors_1.txt" }, true).join("\n");
  assert.match(lines, /Crash watchdog: collecting a dump for "Unable to find material for mesh mymod_0005"/);
  assert.match(lines, /×2: mymod_0000, mymod_0001/);
  assert.match(lines, /Note: meshes without materials/);
  // A real crash, as the watchdog logs it.
  const crashed = G.parseWatchdogLog("[12:00:04] Crash occurred. Asking for dump\n");
  assert.equal(crashed.crashes, 1);
  assert.match(G.describeSession({ pid: 2, modules: null, errors: null, watchdog: crashed, errorLog: "x" }, false).join("\n"), /recorded a crash of this session/);
});

test("engine messages that are easy to misread get a hint", async () => {
  const G = await imp("scene/gamelog.js");
  assert.deepEqual(G.messageHints(["Loading scene", "Done"]), []);
  assert.match(G.messageHints(["ASSERT: new_listener_frame.o.x >= scene_min_position"]).join(), /editor camera/);
  assert.match(G.messageHints(["rglVec3:943 len_sq >= FLT_MIN"]).join(), /zero-length vector/);
  assert.match(G.messageHints(["Only quads and triangles are supported", "Triangulating body"]).join(), /not a failure/);
  const bake = G.messageHints(["No border probes can be found", "(error log) No border probes can be found ×3"]);
  assert.equal(bake.length, 1); // each hint once
  assert.match(bake[0], /prt_border_probe/);
});

test("modules outside <game>/Modules count only when linked there", async (t) => {
  if (process.platform !== "win32") return t.skip("junctions are a Windows feature");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { linkedIntoGame } = await imp("scene/bridge.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mb2mcp-link-"));
  try {
    const game = path.join(root, "game");
    const mod = path.join(root, "work", "MyMod");
    fs.mkdirSync(path.join(game, "Modules", "Native"), { recursive: true });
    fs.mkdirSync(mod, { recursive: true });
    assert.equal(linkedIntoGame(game, path.join(game, "Modules", "Native")), true);
    assert.equal(linkedIntoGame(game, mod), false);
    fs.symlinkSync(mod, path.join(game, "Modules", "MyModLink"), "junction");
    assert.equal(linkedIntoGame(game, mod), true);
  } finally {
    // Remove the junction itself first so the link target is never traversed.
    try {
      fs.unlinkSync(path.join(root, "game", "Modules", "MyModLink"));
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});
