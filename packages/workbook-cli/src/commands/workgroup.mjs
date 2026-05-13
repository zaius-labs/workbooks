// `workbook workgroup pull|push` — round-trips a group's full portal
// config (#81). One canonical .mjs file holds:
//   - identity (name, description, icon)
//   - feature toggles
//   - tag dictionary
//   - views (saved filter+layout combinations)
//   - default view
//   - env-var declarations (names only, never values)
//   - source-bundle policy
//   - per-group MCP advertisement
//
// The agent edits the file, runs `push`, the broker fans out to
// the same endpoints Studio uses (PUT /config, PUT /views/:id,
// POST /tags, etc.). Single source of truth without inventing a
// new authoring surface — every field maps to an existing endpoint.

import path from "node:path";
import fs from "node:fs/promises";
import {
  apiGet,
  apiPost,
  apiPut,
  apiDelete,
  ensureBearer,
  DEFAULT_BROKER,
} from "../util/brokerClient.mjs";

export async function runWorkgroup(flags) {
  const action = flags._?.[0];
  if (!action || action === "help" || action === "--help") return printUsage();

  const groupId = flags.group ?? flags.g;
  if (!groupId) usage("--group <id> is required");

  const bearer = await ensureBearer({ force: flags["force-auth"] });
  const ctx = { bearer, broker: DEFAULT_BROKER };

  switch (action) {
    case "pull": return pull(groupId, flags, ctx);
    case "push": return push(groupId, flags, ctx);
    default:     usage(`unknown subcommand '${action}'`);
  }
}

async function pull(groupId, flags, ctx) {
  // Parallel fetch: group meta, views+config, tag dict, env declarations.
  const [group, views, tags, env] = await Promise.all([
    apiGet(`/v1/groups/${encodeURIComponent(groupId)}`, ctx),
    apiGet(`/v1/groups/${encodeURIComponent(groupId)}/views`, ctx),
    apiGet(`/v1/groups/${encodeURIComponent(groupId)}/tags`, ctx),
    apiGet(`/v1/groups/${encodeURIComponent(groupId)}/env`, ctx).catch(() => null),
  ]);

  const workgroup = {
    $schema: "https://workbooks.sh/schemas/workgroup-v1.json",
    identity: {
      slug: group.slug,
      name: group.name,
      description: group.description ?? null,
      icon:
        group.icon_kind === "emoji" && group.icon
          ? { kind: "emoji", value: group.icon }
          : group.icon_kind === "image"
            ? { kind: "image" }
            : { kind: "initials" },
    },
    config: views.config ?? null,
    tags: tags.dictionary ?? [],
    views: views.views ?? [],
    envVars: {
      // Names only — values stay on the broker. CLI/Studio set them
      // via `workbook env set`. Keeping just the declared names here
      // makes the file safe to commit.
      declared: (env?.env_vars ?? []).map((v) => v.name),
    },
    sourceBundle: {
      // Defaults; broker doesn't enforce these yet (task #85).
      stripGitForClients: true,
      stripGitForAuthor: false,
    },
    mcp: {
      // Discovery hint for `workbook mcp serve --group <id>` —
      // doesn't change broker behavior.
      enabled: true,
      autoAdvertise: true,
    },
  };

  const out = flags.out ?? "workgroup.mjs";
  const body =
    `// Workbook portal config for group "${group.name}" (${groupId}).\n` +
    `// Edit, then upload with:\n` +
    `//   workbook workgroup push --group ${groupId} ${out}\n` +
    `//\n` +
    `// Env-var VALUES are not stored in this file — they live on the\n` +
    `// broker and are managed separately via \`workbook env set\` or the\n` +
    `// workbooks_env_set MCP tool. This file only declares which env\n` +
    `// names a workbook in this group is expected to consume.\n` +
    `\n` +
    `/** @type {import('@work.books/cli').Workgroup} */\n` +
    `export default ${JSON.stringify(workgroup, null, 2)};\n`;

  await fs.writeFile(out, body);
  process.stdout.write(`Wrote ${out}\n`);
}

async function push(groupId, flags, ctx) {
  const file = flags._?.[1];
  if (!file) usage("workbook workgroup push <workgroup.mjs> --group <id>");

  const url = `file://${path.resolve(file)}`;
  const mod = await import(url);
  const wg = mod.default ?? mod;

  // 1. Portal config (feature toggles, default view id, etc).
  if (wg.config) {
    await apiPut(`/v1/groups/${encodeURIComponent(groupId)}/config`, wg.config, ctx);
    process.stdout.write("  config → broker\n");
  }

  // 2. Tag dictionary (additive — we don't delete unknown tags so
  //    a tool's accidental omission doesn't strip metadata).
  for (const t of wg.tags ?? []) {
    if (!t?.tag_id) continue;
    await apiPost(
      `/v1/groups/${encodeURIComponent(groupId)}/tags`,
      { tag_id: t.tag_id, label: t.label, color: t.color },
      ctx,
    );
    process.stdout.write(`  tag → ${t.tag_id}\n`);
  }

  // 3. Views.
  for (const v of wg.views ?? []) {
    if (!v?.id) {
      process.stderr.write(`  skip view: missing id\n`);
      continue;
    }
    await apiPut(
      `/v1/groups/${encodeURIComponent(groupId)}/views/${encodeURIComponent(v.id)}`,
      v,
      ctx,
    );
    process.stdout.write(`  view → ${v.id} (${v.layout})\n`);
  }

  // 4. Env-var declarations — names only. The broker already enforces
  //    that workbook authors declare connect: blocks for any env vars
  //    they call out to. We don't preemptively create empty rows; the
  //    `declared` list documents intent and shows up in the Studio's
  //    settings page so admins know what to populate.
  if (wg.envVars?.declared) {
    process.stdout.write(
      `  envVars (declared, values managed separately): ${wg.envVars.declared.join(", ") || "(none)"}\n`,
    );
  }

  process.stdout.write("\nDone.\n");
}

function usage(msg) {
  if (msg) process.stderr.write(`workbook workgroup: ${msg}\n\n`);
  printUsage();
  process.exit(2);
}

function printUsage() {
  process.stdout.write(
    [
      "workbook workgroup <subcommand> --group <id>",
      "",
      "  pull [--out workgroup.mjs]    write the group's full config to a file",
      "  push <workgroup.mjs>          upload edits back to the broker",
      "",
    ].join("\n"),
  );
}
