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
    "workbook — build tool for portable .html artifacts",
    "",
    "Commands:",
    "  workbook dev [project]     start a Vite dev server with HMR",
    "  workbook build [project]   compile project into dist/<slug>.html",
    "  workbook check [project]   lint a workbook source tree (--reporter=json for tools)",
    "  workbook export pdf <html> --out <file.pdf>",
    "                            render a presentation workbook to static PDF",
    "  workbook explain <rule>    show rationale + fix for a check rule",
    "  workbook encrypt           emit an encrypted <wb-data> element from a file",
    "  workbook seal              wrap a workbook in a Workbooks Studio envelope",
    "  workbook unseal            (testing) decrypt a sealed workbook with a known DEK",
    "  workbook inspect <path>    show metadata of a sealed workbook (no decryption)",
    "  workbook keygen            generate an Ed25519 author keypair for signing",
    "  workbook init <name>       scaffold a new workbook project (--template=spa|presentation)",
    "  workbook unbundle <html>   extract embedded source bundle from a built .html",
    "  workbook publish <html>    upload a built .html and get a workbooks.sh/w/<id> URL",
    "  workbook env <action>      manage group env vars (list/set/rotate/delete/import)",
    "  workbook group <action>    list groups, invite teammates, see members",
    "  workbook mcp serve         expose CLI actions as MCP tools for Claude / Cursor / Codex",
    "  workbook call <id> <tool>  invoke a tool exposed by a workbook (--list to introspect)",
    "  workbook workgroup <action> manage a group's portal config end-to-end (pull/push)",
    "",
    "Build / dev options:",
    "  --port <n>      dev server port (default 5173)",
    "  --out <dir>     build output dir (default dist)",
    "  --runtime <p>   override path to workbook-runtime checkout (auto-detected)",
    "  --no-wasm       skip inlining wasm + runtime bundle (smaller, dev-only)",
    "  --no-bundle     skip embedding the gzipped source bundle (default ON for",
    "                  unencrypted builds; recipients can `workbook unbundle`",
    "                  the .html to recover the source)",
    "  --bundle-git    include the .git/ directory in the source bundle (off",
    "                  by default — git histories can balloon the artifact)",
    "  --encrypt       wrap the artifact in a passphrase lock screen (age-v1).",
    "                  Pair with --password-stdin / --password-file or set",
    "                  the env var declared by encrypt.passwordEnv in",
    "                  workbook.config.mjs (default WORKBOOK_PASSWORD).",
    "                  Dev mode uses encrypt.devPassword if set.",
    "",
    "Encrypt options (`workbook encrypt`):",
    "  --in <path>           input file to encrypt",
    "  --out <path>          where to write the <wb-data> element",
    "  --id <data-id>        data block id (the cells' reads= target)",
    "  --mime <mime>         payload mime (text/csv, application/x-sqlite3, …)",
    "  --password <s>        passphrase (visible in `ps`; prefer --password-stdin)",
    "  --password-stdin      read passphrase from stdin (first line)",
    "  --password-file <p>   read passphrase from first line of a file",
    "  --recipient <age1…>   X25519 recipient (repeatable). Combine with",
    "                        --password to allow either unlock path. (Phase D)",
    "  --recipient-file <p>  first line of <p> as a recipient (repeatable)",
    "  --sign-key <b64>      Ed25519 priv key (base64) for signing — pairs with",
    "                        the runtime's expectedAuthorPubkey for tamper-evidence",
    "  --sign-key-file <p>   read sign key from first line of a file",
    "",
    "Keygen options (`workbook keygen`):",
    "  --type <kind>         'signing' (default, Ed25519) or 'x25519' (age recipient)",
    "  --out <basename>      writes <basename>.priv (0600) + <basename>.pub (0644)",
    "",
    "Run dev/build inside a project containing workbook.config.js (or pass [project]).",
    "",
  ].join("\n"));
}

// Flags that may appear multiple times (`--recipient age1... --recipient age1...`).
// On repeat, values accumulate into an array instead of clobbering.
const MULTI_VALUE_FLAGS = new Set(["recipient", "recipient-file", "tag", "arg"]);

// Flags that NEVER take a value — always boolean. Without this, the
// next positional arg is mistakenly consumed as the flag's value
// (e.g. `--encrypt examples/stocks` sets encrypt='examples/stocks').
const BOOLEAN_FLAGS = new Set(["encrypt", "password-stdin", "force"]);

function parseFlags(rest) {
  const out = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      // Support both `--key value` and `--key=value`.
      const eq = a.indexOf("=");
      let k;
      let value;
      if (eq !== -1) {
        k = a.slice(2, eq);
        value = a.slice(eq + 1);
      } else {
        k = a.slice(2);
        if (k.startsWith("no-")) { out[k.slice(3)] = false; continue; }
        if (BOOLEAN_FLAGS.has(k)) { value = true; }
        else {
          const next = rest[i + 1];
          value = (next == null || next.startsWith("--")) ? true : (i++, next);
        }
      }
      if (MULTI_VALUE_FLAGS.has(k)) {
        if (out[k] === undefined) out[k] = [];
        else if (!Array.isArray(out[k])) out[k] = [out[k]];
        out[k].push(value);
      } else {
        out[k] = value;
      }
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
    case "seal": {
      const flags = parseFlags(argv.slice(1));
      const { runSeal } = await import(path.join(cmdRoot, "seal.mjs"));
      await runSeal(flags);
      break;
    }
    case "unseal": {
      const flags = parseFlags(argv.slice(1));
      const { runUnseal } = await import(path.join(cmdRoot, "unseal.mjs"));
      await runUnseal(flags);
      break;
    }
    case "inspect": {
      const flags = parseFlags(argv.slice(1));
      const { runInspect } = await import(path.join(cmdRoot, "inspect.mjs"));
      await runInspect(flags);
      break;
    }
    case "keygen": {
      const flags = parseFlags(argv.slice(1));
      const { runKeygen } = await import(path.join(cmdRoot, "keygen.mjs"));
      await runKeygen(flags);
      break;
    }
    case "check": {
      const flags = parseFlags(argv.slice(1));
      const { runCheck } = await import(path.join(cmdRoot, "check.mjs"));
      await runCheck({ project: flags._[0] ?? ".", ...flags });
      break;
    }
    case "export": {
      const flags = parseFlags(argv.slice(1));
      const { runExport } = await import(path.join(cmdRoot, "export.mjs"));
      await runExport(flags);
      break;
    }
    case "explain": {
      const flags = parseFlags(argv.slice(1));
      const { runExplain } = await import(path.join(cmdRoot, "explain.mjs"));
      await runExplain(flags);
      break;
    }
    case "init": {
      const flags = parseFlags(argv.slice(1));
      const { runInit } = await import(path.join(cmdRoot, "init.mjs"));
      await runInit(flags);
      break;
    }
    case "unbundle": {
      const flags = parseFlags(argv.slice(1));
      const { runUnbundle } = await import(path.join(cmdRoot, "unbundle.mjs"));
      await runUnbundle(flags);
      break;
    }
    case "publish": {
      const flags = parseFlags(argv.slice(1));
      const { runPublish } = await import(path.join(cmdRoot, "publish.mjs"));
      await runPublish(flags);
      break;
    }
    case "env": {
      const flags = parseFlags(argv.slice(1));
      const { runEnv } = await import(path.join(cmdRoot, "env.mjs"));
      await runEnv(flags);
      break;
    }
    case "group": {
      const flags = parseFlags(argv.slice(1));
      const { runGroup } = await import(path.join(cmdRoot, "group.mjs"));
      await runGroup(flags);
      break;
    }
    case "mcp": {
      const flags = parseFlags(argv.slice(1));
      const { runMcp } = await import(path.join(cmdRoot, "mcp.mjs"));
      await runMcp(flags);
      break;
    }
    case "call": {
      const flags = parseFlags(argv.slice(1));
      const { runCall } = await import(path.join(cmdRoot, "call.mjs"));
      await runCall(flags);
      break;
    }
    case "workgroup": {
      const flags = parseFlags(argv.slice(1));
      const { runWorkgroup } = await import(path.join(cmdRoot, "workgroup.mjs"));
      await runWorkgroup(flags);
      break;
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
