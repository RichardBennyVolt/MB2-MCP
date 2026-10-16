import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { decodeUtf8Lenient } from "./util/text.js";

/**
 * Bridge to System.Xml on the .NET Framework through Windows PowerShell 5.1.
 *
 * Bannerlord itself loads data with System.Xml (XmlReader + XSD validation, XslCompiledTransform
 * for .xslt patches). Running the exact same classes gives results identical to the game, which a
 * JavaScript XSLT/XSD implementation could not guarantee.
 */

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[System.Threading.Thread]::CurrentThread.CurrentUICulture = [System.Globalization.CultureInfo]::InvariantCulture
Add-Type -AssemblyName System.Web.Extensions
$ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$ser.MaxJsonLength = [int]::MaxValue
$ser.RecursionLimit = 512
$job = $ser.DeserializeObject([System.IO.File]::ReadAllText($env:MB2_JOB, [System.Text.Encoding]::UTF8))
$utf8 = New-Object System.Text.UTF8Encoding($false)
$schemaCache = @{}
$xsltCache = @{}

function New-ReaderSettings([bool]$ignoreComments) {
  $s = New-Object System.Xml.XmlReaderSettings
  $s.IgnoreComments = $ignoreComments
  $s.DtdProcessing = [System.Xml.DtdProcessing]::Ignore
  return ,$s
}

function Load-Doc([string]$path) {
  $fs = [System.IO.File]::OpenRead($path)
  try {
    $reader = [System.Xml.XmlReader]::Create($fs, (New-ReaderSettings $true))
    $doc = New-Object System.Xml.XmlDocument
    $doc.Load($reader)
    $reader.Close()
  } finally { $fs.Dispose() }
  return ,$doc
}

function Save-Doc([System.Xml.XmlDocument]$doc, [string]$path) {
  $ws = New-Object System.Xml.XmlWriterSettings
  $ws.Indent = $true
  $ws.IndentChars = "  "
  $ws.Encoding = $utf8
  $w = [System.Xml.XmlWriter]::Create($path, $ws)
  try { $doc.Save($w) } finally { $w.Close() }
}

function Get-SchemaSet([string]$xsd) {
  if ($schemaCache.ContainsKey($xsd)) { return ,$schemaCache[$xsd] }
  $set = New-Object System.Xml.Schema.XmlSchemaSet
  $fs = [System.IO.File]::OpenRead($xsd)
  try {
    $r = [System.Xml.XmlReader]::Create($fs)
    $null = $set.Add($null, $r)
    $r.Close()
  } finally { $fs.Dispose() }
  $set.Compile()
  $schemaCache[$xsd] = $set
  return ,$set
}

function Get-ModuleRoot([string]$path) {
  $dir = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($path))
  $d = $dir
  for ($i = 0; $i -lt 8 -and $d; $i++) {
    if ([System.IO.File]::Exists([System.IO.Path]::Combine($d, 'SubModule.xml'))) { return $d }
    $d = [System.IO.Path]::GetDirectoryName($d)
  }
  return $dir
}

# xsl:import / xsl:include may only name files inside the stylesheet's own module: no URLs, network shares or other
# folders, so checking someone else's mod never makes this machine contact another host (or hand it Windows credentials).
function Assert-LocalImports([string]$path, [string]$root, [int]$depth) {
  if ($depth -gt 16) { throw "XSLT imports nest too deeply at $path" }
  $doc = Load-Doc $path
  $ns = New-Object System.Xml.XmlNamespaceManager($doc.NameTable)
  $ns.AddNamespace('xsl', 'http://www.w3.org/1999/XSL/Transform')
  $base = New-Object System.Uri([System.IO.Path]::GetFullPath($path))
  $prefix = $root.TrimEnd('\') + '\'
  foreach ($n in @($doc.SelectNodes('//xsl:import | //xsl:include', $ns))) {
    $href = $n.GetAttribute('href')
    if (-not $href) { continue }
    $uri = $null
    if (-not [System.Uri]::TryCreate($base, $href, [ref]$uri) -or -not $uri.IsFile -or $uri.IsUnc) {
      throw "Refusing xsl:$($n.LocalName) href='$href' in $($path): only files inside the module folder can be imported."
    }
    $target = [System.IO.Path]::GetFullPath($uri.LocalPath)
    if (-not $target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing xsl:$($n.LocalName) href='$href' in $($path): it points outside the module folder."
    }
    Assert-LocalImports $target $root ($depth + 1)
  }
}

function Get-Xslt([string]$path) {
  if ($xsltCache.ContainsKey($path)) { return ,$xsltCache[$path] }
  Assert-LocalImports $path (Get-ModuleRoot $path) 0
  $x = New-Object System.Xml.Xsl.XslCompiledTransform
  $fs = [System.IO.File]::OpenRead($path)
  try {
    $r = [System.Xml.XmlReader]::Create($fs, (New-ReaderSettings $false), (New-Object System.Uri([System.IO.Path]::GetFullPath($path))).AbsoluteUri) # base URI: relative imports resolve next to the stylesheet
    $x.Load($r, [System.Xml.Xsl.XsltSettings]::Default, (New-Object System.Xml.XmlUrlResolver))
    $r.Close()
  } finally { $fs.Dispose() }
  $xsltCache[$path] = $x
  return ,$x
}

function Apply-Xslt($xslt, [System.Xml.XmlDocument]$doc) {
  $out = New-Object System.Xml.XmlDocument
  $w = $out.CreateNavigator().AppendChild()
  $reader = New-Object System.Xml.XmlNodeReader($doc)
  try { $xslt.Transform([System.Xml.XmlReader]$reader, [System.Xml.XmlWriter]$w) } finally { $w.Close() }
  return ,$out
}

function Merge-Docs([System.Xml.XmlDocument]$a, [System.Xml.XmlDocument]$b) {
  foreach ($n in @($b.DocumentElement.ChildNodes)) {
    if ($n.NodeType -eq [System.Xml.XmlNodeType]::Element) { $null = $a.DocumentElement.AppendChild($a.ImportNode($n, $true)) }
  }
}

function Get-ErrInfo($ex) {
  $info = @{ message = $ex.Message; line = 0; col = 0 }
  $e = $ex
  while ($e -ne $null) {
    if ($e -is [System.Xml.XmlException] -or $e -is [System.Xml.Xsl.XsltException] -or $e -is [System.Xml.Schema.XmlSchemaException]) {
      $info.message = $e.Message
      $info.line = $e.LineNumber
      $info.col = $e.LinePosition
      break
    }
    $e = $e.InnerException
  }
  if ($info.line -eq 0 -and $ex.InnerException -ne $null) { $info.message = $ex.InnerException.Message }
  return $info
}

function Invoke-Xsd($task) {
  $errs = New-Object System.Collections.ArrayList
  $settings = New-ReaderSettings $true
  $settings.ValidationType = [System.Xml.ValidationType]::Schema
  $settings.Schemas = Get-SchemaSet $task['xsd']
  $settings.ValidationFlags = $settings.ValidationFlags -bor [System.Xml.Schema.XmlSchemaValidationFlags]::ReportValidationWarnings
  $handler = [System.Xml.Schema.ValidationEventHandler]({
    param($sender, $e)
    if ($errs.Count -lt 200) { $null = $errs.Add(@{ severity = $e.Severity.ToString(); line = $e.Exception.LineNumber; col = $e.Exception.LinePosition; message = $e.Message }) }
  }.GetNewClosure())
  $settings.add_ValidationEventHandler($handler)
  $fs = [System.IO.File]::OpenRead($task['xml'])
  try {
    $reader = [System.Xml.XmlReader]::Create($fs, $settings)
    try { while ($reader.Read()) { } }
    catch { $info = Get-ErrInfo $_.Exception; $null = $errs.Add(@{ severity = 'Error'; line = $info.line; col = $info.col; message = $info.message }) }
    finally { $reader.Close() }
  } finally { $fs.Dispose() }
  return @{ errors = $errs.ToArray() }
}

function Invoke-Chain($task) {
  $steps = $task['steps']
  $doc = $null
  for ($i = 0; $i -lt $steps.Count; $i++) {
    $st = $steps[$i]
    if ($st['snapshotBefore'] -and $doc -ne $null) { Save-Doc $doc $st['snapshotBefore'] }
    if ($doc -eq $null) {
      if (-not $st['xml']) { continue }
      try { $doc = Load-Doc $st['xml'] } catch { $i2 = Get-ErrInfo $_.Exception; throw "Cannot load $($st['xml']) (line $($i2.line)): $($i2.message)" }
    } else {
      if ($st['xslt']) {
        try { $doc = Apply-Xslt (Get-Xslt $st['xslt']) $doc }
        catch { $i2 = Get-ErrInfo $_.Exception; throw "XSLT $($st['xslt']) failed (line $($i2.line)): $($i2.message)" }
      }
      if ($st['xml']) {
        try { $other = Load-Doc $st['xml'] } catch { $i2 = Get-ErrInfo $_.Exception; throw "Cannot load $($st['xml']) (line $($i2.line)): $($i2.message)" }
        Merge-Docs $doc $other
      }
    }
    if ($st['snapshotAfter'] -and $doc -ne $null) { Save-Doc $doc $st['snapshotAfter'] }
  }
  if ($task['out'] -and $doc -ne $null) { Save-Doc $doc $task['out'] }
  return @{ ok = $true }
}

$results = New-Object System.Collections.ArrayList
foreach ($task in $job['tasks']) {
  $r = @{ id = $task['id']; ok = $true }
  try {
    switch ($task['op']) {
      'xsd' { $r.result = Invoke-Xsd $task }
      'chain' { $r.result = Invoke-Chain $task }
      'xslt-compile' { $null = Get-Xslt $task['xslt']; $r.result = @{ ok = $true } }
      'load' { $null = Load-Doc $task['xml']; $r.result = @{ ok = $true } }
      default { throw "Unknown op $($task['op'])" }
    }
  } catch {
    $info = Get-ErrInfo $_.Exception
    $r.ok = $false
    $r.error = $info.message
    $r.line = $info.line
    $r.col = $info.col
  }
  $null = $results.Add($r)
}
[System.IO.File]::WriteAllText($env:MB2_OUT, $ser.Serialize($results.ToArray()), $utf8)
`;

export interface DotnetIssue {
  severity: string;
  line: number;
  col: number;
  message: string;
}

export type DotnetTask =
  | { op: "xsd"; xml: string; xsd: string }
  | { op: "xslt-compile"; xslt: string }
  | { op: "load"; xml: string }
  | {
      op: "chain";
      steps: Array<{ xml: string | null; xslt: string | null; snapshotBefore?: string; snapshotAfter?: string }>;
      out?: string;
    };

export interface DotnetResult {
  id: number;
  ok: boolean;
  error?: string;
  line?: number;
  col?: number;
  result?: { errors?: DotnetIssue[]; ok?: boolean };
}

let scriptPathCache: string | null = null;

function scriptPath(dataDir: string): string {
  if (scriptPathCache && fs.existsSync(scriptPathCache)) return scriptPathCache;
  const hash = crypto.createHash("sha1").update(PS_SCRIPT).digest("hex").slice(0, 10);
  const dir = path.join(dataDir, "bin");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `xmltools-${hash}.ps1`);
  if (!fs.existsSync(p)) fs.writeFileSync(p, "\ufeff" + PS_SCRIPT, "utf8");
  scriptPathCache = p;
  return p;
}

export function findPowerShell(override: string | null): string | null {
  if (override) return fs.existsSync(override) ? override : null;
  if (process.platform !== "win32") return null;
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.windir || "C:\\Windows";
  const p = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fs.existsSync(p) ? p : null;
}

export class DotnetBridge {
  private counter = 0;
  constructor(
    private readonly dataDir: string,
    private readonly psOverride: string | null,
  ) {}

  available(): boolean {
    return findPowerShell(this.psOverride) !== null;
  }

  unavailableReason(): string {
    return process.platform === "win32"
      ? "Windows PowerShell (powershell.exe) was not found; set MB2_POWERSHELL to its full path."
      : "XSD validation and XSLT preview use the .NET Framework through Windows PowerShell and are only available on Windows.";
  }

  /** Our own temp folder: some MCP clients (e.g. Codex) start servers without TEMP/TMP. */
  private tmpDir(): string {
    const dir = path.join(this.dataDir, "tmp");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Environment for powershell.exe with the variables Windows tools rely on, even if the client stripped them. */
  private childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
    const ps = findPowerShell(this.psOverride);
    const winDir = env.SystemRoot || env.SYSTEMROOT || env.windir || (ps ? path.resolve(ps, "..", "..", "..", "..") : "C:\\Windows");
    env.SystemRoot ??= winDir;
    env.windir ??= winDir;
    env.TEMP ??= this.tmpDir();
    env.TMP ??= env.TEMP;
    return env;
  }

  /** Runs tasks in one PowerShell process. Paths must be absolute. */
  async run(tasks: DotnetTask[], timeoutMs = 120000): Promise<DotnetResult[]> {
    const ps = findPowerShell(this.psOverride);
    if (!ps) throw new Error(this.unavailableReason());
    if (tasks.length === 0) return [];
    const tmpDir = this.tmpDir();
    const stamp = `${process.pid}-${Date.now()}-${++this.counter}`;
    const jobFile = path.join(tmpDir, `job-${stamp}.json`);
    const outFile = path.join(tmpDir, `out-${stamp}.json`);
    fs.writeFileSync(jobFile, JSON.stringify({ tasks: tasks.map((t, i) => ({ id: i, ...t })) }), "utf8");
    const script = scriptPath(this.dataDir);
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          ps,
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
          {
            windowsHide: true,
            timeout: timeoutMs,
            maxBuffer: 16 * 1024 * 1024,
            encoding: "buffer",
            env: this.childEnv({ MB2_JOB: jobFile, MB2_OUT: outFile }),
          },
          (err, _stdout, stderr) => {
            if (fs.existsSync(outFile)) return resolve();
            const msg = decodeUtf8Lenient(Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr ?? ""))).trim();
            reject(new Error(`PowerShell helper failed${err ? ` (${err.message.split("\n")[0]})` : ""}${msg ? `: ${msg.slice(0, 1500)}` : ""}`));
          },
        );
      });
      const raw = fs.readFileSync(outFile, "utf8").replace(/^\ufeff/, "");
      const parsed = JSON.parse(raw) as unknown;
      const list = (Array.isArray(parsed) ? parsed : [parsed]) as DotnetResult[];
      for (const r of list) {
        if (r.result && r.result.errors && !Array.isArray(r.result.errors)) r.result.errors = [r.result.errors as unknown as DotnetIssue];
      }
      return list.sort((a, b) => a.id - b.id);
    } finally {
      for (const f of [jobFile, outFile]) {
        try {
          fs.rmSync(f, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }

  tempPath(name: string): string {
    return path.join(this.tmpDir(), `${process.pid}-${Date.now()}-${++this.counter}-${name}`);
  }
}
