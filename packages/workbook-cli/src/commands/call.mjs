// `workbook call <workbook_id> <tool> [--arg key=value...]` —
// Invoke a tool a workbook advertises. Same wire as the
// workbooks_invoke MCP surface; this is the shell-side equivalent
// so a workbook is usable from a terminal just as easily as from
// an AI client.
//
//   workbook call wb_abc123 forecast_revenue --arg q=2 --arg year=2026
//   echo '{"q":2,"year":2026}' | workbook call wb_abc123 forecast_revenue --stdin
//   workbook call wb_abc123 --list           # show the workbook's tool catalogue
//
// Today the broker returns a deep-link URL because server-side
// execution lives behind Cloudflare Worker Loader (closed beta);
// see RESEARCH-cf-execution-primitives.md. When that lands the
// wire stays the same and this command silently graduates to
// real synchronous invocation.

import {
  apiGet,
  apiPost,
  ensureBearer,
  DEFAULT_BROKER,
} from "../util/brokerClient.mjs";

export async function runCall(flags) {
  const action = flags._?.[0];
  if (!action || action === "help" || action === "--help") return printUsage();

  const wbId = action;
  const toolName = flags._?.[1];

  if (flags.list) {
    const bearer = await ensureBearer({ force: flags["force-auth"] });
    const r = await apiGet(`/v1/workbooks/${encodeURIComponent(wbId)}/tools`, {
      bearer, broker: DEFAULT_BROKER,
    });
    if (!r.tools || r.tools.length === 0) {
      process.stdout.write("This workbook doesn't advertise any tools.\n");
      return;
    }
    process.stdout.write(`Tools on ${wbId}${r.title ? ` (${r.title})` : ""}:\n`);
    for (const t of r.tools) {
      const desc = t.description ? `\n      ${t.description}` : "";
      process.stdout.write(`  ${t.name}${desc}\n`);
    }
    return;
  }

  if (!toolName) usage("workbook call <workbook_id> <tool> [--arg k=v]");

  const args = await collectArgs(flags);
  const bearer = await ensureBearer({ force: flags["force-auth"] });
  const r = await apiPost(
    `/v1/workbooks/${encodeURIComponent(wbId)}/invoke`,
    { tool: toolName, args },
    { bearer, broker: DEFAULT_BROKER },
  );
  process.stdout.write(JSON.stringify(r, null, 2) + "\n");
}

async function collectArgs(flags) {
  // --json <obj>      → JSON literal
  // --json-file <p>   → read JSON from a file
  // --stdin           → read JSON from stdin
  // --arg k=v --arg…  → build an object from k=v pairs
  if (flags.json) {
    try { return JSON.parse(flags.json); }
    catch (e) { usage(`--json: invalid JSON (${e.message})`); }
  }
  if (flags["json-file"]) {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(flags["json-file"], "utf8");
    return JSON.parse(raw);
  }
  if (flags.stdin) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const text = Buffer.concat(chunks).toString("utf8").trim();
    return text ? JSON.parse(text) : null;
  }
  const argFlags = flags.arg == null
    ? []
    : Array.isArray(flags.arg)
      ? flags.arg
      : [flags.arg];
  if (argFlags.length === 0) return null;
  const obj = {};
  for (const pair of argFlags) {
    const eq = String(pair).indexOf("=");
    if (eq < 1) usage(`--arg expects key=value (got ${pair})`);
    const k = String(pair).slice(0, eq);
    const raw = String(pair).slice(eq + 1);
    // Try to parse as JSON literal (numbers, booleans, JSON objects).
    // Fall back to raw string if not valid JSON.
    try { obj[k] = JSON.parse(raw); }
    catch { obj[k] = raw; }
  }
  return obj;
}

function usage(msg) {
  if (msg) process.stderr.write(`workbook call: ${msg}\n\n`);
  printUsage();
  process.exit(2);
}

function printUsage() {
  process.stdout.write(
    [
      "workbook call <workbook_id> <tool> [args]",
      "",
      "  workbook call <workbook_id> --list",
      "      Show the workbook's tool catalogue.",
      "",
      "  workbook call <workbook_id> <tool> --arg k=v --arg k2=v2",
      "      Invoke the tool with an object built from --arg pairs.",
      "      Values are parsed as JSON when possible, else passed as strings.",
      "",
      "  workbook call <workbook_id> <tool> --json '{\"k\":1}'",
      "  workbook call <workbook_id> <tool> --json-file args.json",
      "  echo '{\"k\":1}' | workbook call <workbook_id> <tool> --stdin",
      "      Pass a single JSON object as the args.",
      "",
    ].join("\n"),
  );
}
