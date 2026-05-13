// `workbook env` — manage group environment variables from the CLI.
//
//   workbook env list   --group <id>
//   workbook env set    <NAME> <VALUE>  --group <id> [--workbook <id>]
//   workbook env rotate <id>            --group <id>
//   workbook env delete <id>            --group <id>
//   workbook env import <.env-file>     --group <id> [--workbook <id>] [--replace]
//
// `--workbook <id>` scopes the var to one workbook within the group;
// omitting it = group-wide. `set NAME` is upper-cased to UPPER_SNAKE
// before hitting the broker.

import fs from "node:fs/promises";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  ensureBearer,
  DEFAULT_BROKER,
} from "../util/brokerClient.mjs";

export async function runEnv(flags) {
  const action = flags._?.[0];
  if (!action || action === "help" || action === "--help") return printUsage();

  const groupId = flags.group ?? flags.g;
  if (!groupId) usage("--group <id> is required");

  const bearer = await ensureBearer({ force: flags["force-auth"] });
  const ctx = { bearer, broker: DEFAULT_BROKER };

  switch (action) {
    case "list":   return list(groupId, ctx);
    case "set":    return set(groupId, flags, ctx);
    case "rotate": return rotate(groupId, flags, ctx);
    case "delete":
    case "rm":     return del(groupId, flags, ctx);
    case "import": return importDotenv(groupId, flags, ctx);
    default:       usage(`unknown subcommand '${action}'`);
  }
}

async function list(groupId, ctx) {
  const r = await apiGet(`/v1/groups/${encodeURIComponent(groupId)}/env`, ctx);
  const vars = r.env_vars ?? [];
  if (vars.length === 0) {
    process.stdout.write("No env vars set.\n");
    return;
  }
  const maxName = Math.max(...vars.map((v) => v.name.length), 4);
  process.stdout.write(
    `${"NAME".padEnd(maxName)}  SCOPE       LAST USED\n`,
  );
  for (const v of vars) {
    const scope = v.scope === "workbook" ? "workbook" : "group";
    const last = v.last_used_at
      ? new Date(v.last_used_at * 1000).toISOString().slice(0, 10)
      : "never";
    process.stdout.write(
      `${v.name.padEnd(maxName)}  ${scope.padEnd(10)}  ${last}\n`,
    );
  }
}

async function set(groupId, flags, ctx) {
  const name = flags._?.[1];
  const value = flags._?.[2];
  if (!name || !value) usage("workbook env set <NAME> <VALUE> --group <id>");

  const body = {
    name,
    value,
    ...scopeBody(flags),
  };
  const r = await apiPost(`/v1/groups/${encodeURIComponent(groupId)}/env`, body, ctx);
  process.stdout.write(`Added ${r.name} (${r.scope}${r.workbook_id ? ` ${r.workbook_id}` : ""})\n`);
}

async function rotate(groupId, flags, ctx) {
  const id = flags._?.[1];
  let value = flags.value;
  if (!id) usage("workbook env rotate <env-var-id> --group <id> [--value <new>]");
  if (!value) {
    value = await readPasswordFromStdin();
    if (!value) usage("--value <new> is required (or pipe via stdin)");
  }
  await apiPatch(
    `/v1/groups/${encodeURIComponent(groupId)}/env/${encodeURIComponent(id)}`,
    { value },
    ctx,
  );
  process.stdout.write(`Rotated ${id}\n`);
}

async function del(groupId, flags, ctx) {
  const id = flags._?.[1];
  if (!id) usage("workbook env delete <env-var-id> --group <id>");
  await apiDelete(`/v1/groups/${encodeURIComponent(groupId)}/env/${encodeURIComponent(id)}`, ctx);
  process.stdout.write(`Revoked ${id}\n`);
}

async function importDotenv(groupId, flags, ctx) {
  const file = flags._?.[1];
  if (!file) usage("workbook env import <.env-file> --group <id>");
  const text = await fs.readFile(file, "utf8");
  const entries = parseDotenv(text);
  if (entries.length === 0) {
    process.stdout.write("No entries found in file.\n");
    return;
  }
  const r = await apiPost(
    `/v1/groups/${encodeURIComponent(groupId)}/env/bulk`,
    {
      entries,
      replace: flags.replace === true,
      ...scopeBody(flags),
    },
    ctx,
  );
  const results = r.results ?? [];
  const created = results.filter((x) => x.status === "created").length;
  const rotated = results.filter((x) => x.status === "rotated").length;
  const skipped = results.filter((x) => x.status === "skipped");
  process.stdout.write(
    `Imported ${created} new, rotated ${rotated}, skipped ${skipped.length}.\n`,
  );
  for (const s of skipped) {
    process.stdout.write(`  · ${s.name}: ${s.reason ?? "skipped"}\n`);
  }
}

function scopeBody(flags) {
  const wb = flags.workbook ?? flags.w;
  if (wb) return { scope: "workbook", workbook_id: wb };
  return { scope: "group" };
}

function parseDotenv(text) {
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!name || !value) continue;
    out.push({ name, value });
  }
  return out;
}

async function readPasswordFromStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function usage(msg) {
  if (msg) process.stderr.write(`workbook env: ${msg}\n\n`);
  printUsage();
  process.exit(2);
}

function printUsage() {
  process.stdout.write(
    [
      "workbook env <subcommand> --group <id>",
      "",
      "Subcommands:",
      "  list                              show all env vars in the group",
      "  set <NAME> <VALUE>                add or replace an env var",
      "  rotate <env-var-id> --value <v>   change the stored value",
      "  delete <env-var-id>               revoke an env var",
      "  import <.env-file>                bulk-import from a dotenv file",
      "",
      "Common flags:",
      "  --group <id>      required group id",
      "  --workbook <id>   scope to a single workbook (overrides group value)",
      "  --replace         on import: rotate existing names instead of skipping",
      "  --force-auth      ignore the cached bearer and re-run loopback OAuth",
      "",
      "Auth: set WORKBOOKS_API_TOKEN=wbat_... for headless / CI use,",
      "      or run any command interactively to trigger browser sign-in.",
      "",
    ].join("\n"),
  );
}
