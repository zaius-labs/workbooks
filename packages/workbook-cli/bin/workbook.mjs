#!/usr/bin/env node
// Workbook CLI — dev / build / init.
//
// Thin dispatcher; the real work is in src/commands/*.

import { fileURLToPath } from "node:url";
import path from "node:path";

const argv = process.argv.slice(2);
const cmd = argv[0];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cmdRoot = path.resolve(HERE, "..", "src", "commands");

async function help() {
  process.stdout.write([
    "workbook — build tool for portable .workbook.html artifacts",
    "",
    "Commands:",
    "  workbook dev [project]     start a Vite dev server with HMR",
    "  workbook build [project]   compile project into dist/<slug>.workbook.html",
    "  workbook encrypt           emit an encrypted <wb-data> element from a file",
    "  workbook init <name>       (todo) scaffold a new workbook project",
    "",
    "Build / dev options:",
    "  --port <n>      dev server port (default 5173)",
    "  --out <dir>     build output dir (default dist)",
    "  --runtime <p>   override path to workbook-runtime checkout (auto-detected)",
    "  --no-wasm       skip inlining wasm + runtime bundle (smaller, dev-only)",
    "",
    "Encrypt options (`workbook encrypt`):",
    "  --in <path>           input file to encrypt",
    "  --out <path>          where to write the <wb-data> element",
    "  --id <data-id>        data block id (the cells' reads= target)",
    "  --mime <mime>         payload mime (text/csv, application/x-sqlite3, …)",
    "  --password <s>        passphrase (visible in `ps`; prefer --password-stdin)",
    "  --password-stdin      read passphrase from stdin (first line)",
    "  --password-file <p>   read passphrase from first line of a file",
    "",
    "Run dev/build inside a project containing workbook.config.js (or pass [project]).",
    "",
  ].join("\n"));
}

function parseFlags(rest) {
  const out = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = rest[i + 1];
      if (k.startsWith("no-")) { out[k.slice(3)] = false; continue; }
      if (next == null || next.startsWith("--")) { out[k] = true; }
      else { out[k] = next; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

try {
  switch (cmd) {
    case "dev": {
      const flags = parseFlags(argv.slice(1));
      const { runDev } = await import(path.join(cmdRoot, "dev.mjs"));
      await runDev({ project: flags._[0] ?? ".", ...flags });
      break;
    }
    case "build": {
      const flags = parseFlags(argv.slice(1));
      const { runBuild } = await import(path.join(cmdRoot, "build.mjs"));
      await runBuild({ project: flags._[0] ?? ".", ...flags });
      break;
    }
    case "encrypt": {
      const flags = parseFlags(argv.slice(1));
      const { runEncrypt } = await import(path.join(cmdRoot, "encrypt.mjs"));
      await runEncrypt(flags);
      break;
    }
    case "init": {
      console.error("workbook init: not yet implemented");
      process.exit(2);
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      await help();
      break;
    default:
      console.error(`workbook: unknown command '${cmd}'`);
      await help();
      process.exit(2);
  }
} catch (err) {
  process.stderr.write(`workbook: ${err?.stack ?? err?.message ?? err}\n`);
  process.exit(1);
}
