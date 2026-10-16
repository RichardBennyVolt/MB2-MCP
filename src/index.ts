#!/usr/bin/env node
import { loadConfig, parseArgs } from "./config.js";
import { printConfig, runDoctor } from "./cli.js";
import { log, startServer } from "./server.js";
import { VERSION } from "./version.js";

const USAGE = `mb2-mcp ${VERSION} — MCP server for Mount & Blade II: Bannerlord mod editing

Usage:
  node dist/index.js [serve] [options]     start the MCP server on stdio (default)
  node dist/index.js doctor [options]      check the environment
  node dist/index.js config [claude|codex|dsh|json|all]   print client configuration

Options (or environment variables):
  --game-dir <dir>       MB2_GAME_DIR       game folder (auto-detected from Steam/Epic/GOG/Xbox)
  --module-dirs <a;b>    MB2_MODULE_DIRS    extra folders containing your modules (writable)
  --no-workshop          MB2_WORKSHOP=0     do not index Steam Workshop modules
  --readonly             MB2_READONLY=1     disable all writes
  --data-dir <dir>       MB2_DATA_DIR       history/backup folder (default %LOCALAPPDATA%\\mb2-mcp)
  --max-output <chars>   MB2_MAX_OUTPUT     cap per tool result (default 40000)
                         MB2_DEBUG=1        log tool timings to stderr
`;

async function main(): Promise<void> {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const cmd = positional[0] ?? "serve";
  if (opts.help || cmd === "help" || cmd === "--help") {
    process.stdout.write(USAGE);
    return;
  }
  const config = loadConfig(opts);
  switch (cmd) {
    case "serve":
      await startServer(config);
      return;
    case "doctor":
      process.stdout.write((await runDoctor(config)) + "\n");
      return;
    case "config":
      process.stdout.write(printConfig(positional[1] ?? "all", config));
      return;
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return;
    default:
      process.stderr.write(`Unknown command '${cmd}'.\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  log("fatal", e);
  process.exit(1);
});
