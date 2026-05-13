// `workbook group` — list groups, invite teammates, manage tags.
//
//   workbook group list
//   workbook group members   --group <id>
//   workbook group invite <email> --group <id> [--role admin|member]
//   workbook group workbooks --group <id> [--q <query>] [--type <t>...] [--tag <t>...]
//   workbook group tags      --group <id>
//   workbook group tag-add   --group <id> <tag-id> [--label <s>] [--color <s>]
//   workbook group tag-rm    --group <id> <tag-id>
//
// Workbook-scoped tag membership:
//   workbook group tag-workbook  --workbook <id> --tag <a> --tag <b>  (replace set)

import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  apiPut,
  ensureBearer,
  DEFAULT_BROKER,
} from "../util/brokerClient.mjs";

export async function runGroup(flags) {
  const action = flags._?.[0];
  if (!action || action === "help" || action === "--help") return printUsage();
  const bearer = await ensureBearer({ force: flags["force-auth"] });
  const ctx = { bearer, broker: DEFAULT_BROKER };

  switch (action) {
    case "list":         return listGroups(ctx);
    case "members":      return listMembers(flags, ctx);
    case "workbooks":    return listWorkbooks(flags, ctx);
    case "invite":       return invite(flags, ctx);
    case "tags":         return listTags(flags, ctx);
    case "tag-add":      return addTag(flags, ctx);
    case "tag-rm":       return rmTag(flags, ctx);
    case "tag-workbook": return tagWorkbook(flags, ctx);
    case "view":         return viewSub(flags, ctx);
    case "config":       return configSub(flags, ctx);
    case "help":         return printUsage();
    default:             usage(`unknown subcommand '${action}'`);
  }
}

// ── views ────────────────────────────────────────────────────────────

async function viewSub(flags, ctx) {
  const groupId = requireGroup(flags);
  const op = flags._?.[1];
  switch (op) {
    case "list":   return viewList(groupId, ctx);
    case "pull":   return viewPull(groupId, flags, ctx);
    case "push":   return viewPush(groupId, flags, ctx);
    case "delete":
    case "rm":     return viewDelete(groupId, flags, ctx);
    default:       usage("workbook group view <list|pull|push|delete> --group <id>");
  }
}

async function viewList(groupId, ctx) {
  const r = await apiGet(`/v1/groups/${encodeURIComponent(groupId)}/views`, ctx);
  const views = r.views ?? [];
  if (views.length === 0) {
    process.stdout.write("No views defined.\n");
    return;
  }
  for (const v of views) {
    const star = v.id === r.config?.default_view_id ? "★ " : "  ";
    process.stdout.write(
      `${star}${v.id.padEnd(20)} ${v.layout.padEnd(9)} ${v.scope.padEnd(6)} ${v.name}\n`,
    );
  }
}

async function viewPull(groupId, flags, ctx) {
  const r = await apiGet(`/v1/groups/${encodeURIComponent(groupId)}/views`, ctx);
  const out = flags.out ?? `views.mjs`;
  const body = `// Group views for ${groupId}.
// Edit, then push back with:
//   workbook group view push --group ${groupId} ${out}

/** @type {import('@work.books/cli').GroupLayout} */
export default ${JSON.stringify(
    { config: r.config ?? null, views: r.views },
    null,
    2,
  )};
`;
  const fs = await import("node:fs/promises");
  await fs.writeFile(out, body);
  process.stdout.write(`Wrote ${out}\n`);
}

async function viewPush(groupId, flags, ctx) {
  const file = flags._?.[2];
  if (!file) usage("workbook group view push <layout.mjs> --group <id>");
  const url = `file://${(await import("node:path")).default.resolve(file)}`;
  const mod = await import(url);
  const layout = mod.default ?? mod;

  if (layout.config) {
    await apiPut(`/v1/groups/${encodeURIComponent(groupId)}/config`, layout.config, ctx);
  }

  for (const v of layout.views ?? []) {
    if (!v.id) {
      process.stderr.write(`  skip: view missing id\n`);
      continue;
    }
    await apiPut(
      `/v1/groups/${encodeURIComponent(groupId)}/views/${encodeURIComponent(v.id)}`,
      v,
      ctx,
    );
    process.stdout.write(`  pushed ${v.id} (${v.layout}, scope=${v.scope ?? "group"})\n`);
  }
}

async function viewDelete(groupId, flags, ctx) {
  const id = flags._?.[2];
  if (!id) usage("workbook group view delete <id> --group <id>");
  const scope = flags.scope === "user" ? "user" : "group";
  await apiDelete(
    `/v1/groups/${encodeURIComponent(groupId)}/views/${encodeURIComponent(id)}?scope=${scope}`,
    ctx,
  );
  process.stdout.write(`Deleted ${id}.\n`);
}

// ── config ───────────────────────────────────────────────────────────

async function configSub(flags, ctx) {
  const groupId = requireGroup(flags);
  const op = flags._?.[1];
  switch (op) {
    case "get": {
      const r = await apiGet(`/v1/groups/${encodeURIComponent(groupId)}/views`, ctx);
      process.stdout.write(JSON.stringify(r.config ?? {}, null, 2) + "\n");
      return;
    }
    case "set": {
      const file = flags._?.[2];
      if (!file) usage("workbook group config set <config.json> --group <id>");
      const fs = await import("node:fs/promises");
      const raw = await fs.readFile(file, "utf8");
      const cfg = JSON.parse(raw);
      await apiPut(`/v1/groups/${encodeURIComponent(groupId)}/config`, cfg, ctx);
      process.stdout.write("Config updated.\n");
      return;
    }
    default:
      usage("workbook group config <get|set> --group <id>");
  }
}

async function listGroups(ctx) {
  const r = await apiGet("/v1/groups/me", ctx);
  const groups = r.groups ?? [];
  if (groups.length === 0) {
    process.stdout.write("You aren't in any groups yet.\n");
    return;
  }
  const widest = Math.max(...groups.map((g) => g.name.length), 4);
  process.stdout.write(`${"NAME".padEnd(widest)}  ROLE     ID\n`);
  for (const g of groups) {
    process.stdout.write(
      `${g.name.padEnd(widest)}  ${g.role.padEnd(7)}  ${g.id}\n`,
    );
  }
}

async function listMembers(flags, ctx) {
  const groupId = requireGroup(flags);
  const r = await apiGet(`/v1/groups/${encodeURIComponent(groupId)}/members`, ctx);
  const members = r.members ?? [];
  const invites = r.invites ?? [];
  process.stdout.write(`Members (${members.length}):\n`);
  for (const m of members) {
    process.stdout.write(`  ${m.role.padEnd(7)} ${m.email ?? m.sub}\n`);
  }
  if (invites.length > 0) {
    process.stdout.write(`\nPending invites (${invites.length}):\n`);
    for (const i of invites) {
      process.stdout.write(`  ${i.role.padEnd(7)} ${i.email}\n`);
    }
  }
}

async function listWorkbooks(flags, ctx) {
  const groupId = requireGroup(flags);
  const qs = new URLSearchParams();
  if (flags.q) qs.set("q", flags.q);
  for (const t of toArray(flags.type)) qs.append("type", t);
  for (const t of toArray(flags.tag)) qs.append("tag", t);
  if (flags["include-revoked"]) qs.set("include_revoked", "1");
  const path =
    `/v1/groups/${encodeURIComponent(groupId)}/workbooks` +
    (qs.toString() ? `?${qs}` : "");
  const r = await apiGet(path, ctx);
  const wbs = r.workbooks ?? [];
  if (wbs.length === 0) {
    process.stdout.write("No workbooks match.\n");
    return;
  }
  for (const w of wbs) {
    const title = w.title ?? w.slug ?? "(untitled)";
    const type = w.type ? ` [${w.type}]` : "";
    const tags = w.tags?.length ? `  #${w.tags.join(" #")}` : "";
    const status = w.revoked_at ? " (revoked)" : "";
    process.stdout.write(`  ${w.id}  ${title}${type}${tags}${status}\n`);
  }
}

async function listTags(flags, ctx) {
  const groupId = requireGroup(flags);
  const r = await apiGet(`/v1/groups/${encodeURIComponent(groupId)}/tags`, ctx);
  const dict = r.dictionary ?? [];
  const inUse = new Set(r.in_use ?? []);
  if (dict.length === 0 && inUse.size === 0) {
    process.stdout.write("No tags yet.\n");
    return;
  }
  const all = new Set([...dict.map((d) => d.tag_id), ...inUse]);
  for (const id of [...all].sort()) {
    const d = dict.find((x) => x.tag_id === id);
    const label = d?.label ? `  ${d.label}` : "";
    const used = inUse.has(id) ? "" : "  (defined, not in use)";
    process.stdout.write(`  ${id}${label}${used}\n`);
  }
}

async function addTag(flags, ctx) {
  const groupId = requireGroup(flags);
  const tag_id = flags._?.[1];
  if (!tag_id) usage("workbook group tag-add <tag-id> --group <id>");
  await apiPost(
    `/v1/groups/${encodeURIComponent(groupId)}/tags`,
    { tag_id, label: flags.label ?? null, color: flags.color ?? null },
    ctx,
  );
  process.stdout.write(`Added tag ${tag_id}.\n`);
}

async function rmTag(flags, ctx) {
  const groupId = requireGroup(flags);
  const tag_id = flags._?.[1];
  if (!tag_id) usage("workbook group tag-rm <tag-id> --group <id>");
  await apiDelete(
    `/v1/groups/${encodeURIComponent(groupId)}/tags/${encodeURIComponent(tag_id)}`,
    ctx,
  );
  process.stdout.write(`Removed tag ${tag_id} from dictionary.\n`);
}

async function tagWorkbook(flags, ctx) {
  const wbId = flags.workbook ?? flags.w;
  if (!wbId) usage("workbook group tag-workbook --workbook <id> --tag <a> [--tag <b>]");
  const tags = toArray(flags.tag);
  await apiPut(
    `/v1/workbooks/${encodeURIComponent(wbId)}/tags`,
    { tags },
    ctx,
  );
  process.stdout.write(`Set tags on ${wbId}: ${tags.length ? tags.join(", ") : "(cleared)"}\n`);
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

async function invite(flags, ctx) {
  const email = flags._?.[1];
  if (!email) usage("workbook group invite <email> --group <id>");
  const groupId = requireGroup(flags);
  const role = flags.role === "admin" ? "admin" : "member";
  const r = await apiPost(
    `/v1/groups/${encodeURIComponent(groupId)}/invites`,
    { email, role },
    ctx,
  );
  process.stdout.write(`Invited ${email} as ${role} (invite ${r.id}).\n`);
}

function requireGroup(flags) {
  const groupId = flags.group ?? flags.g;
  if (!groupId) usage("--group <id> is required");
  return groupId;
}

function usage(msg) {
  if (msg) process.stderr.write(`workbook group: ${msg}\n\n`);
  printUsage();
  process.exit(2);
}

function printUsage() {
  process.stdout.write(
    [
      "workbook group <subcommand>",
      "",
      "Subcommands:",
      "  list                                  groups you belong to",
      "  members    --group <id>               roster + pending invites",
      "  workbooks  --group <id> [--q <s>] [--type <t>] [--tag <t>]",
      "                                        list workbooks; filter by query, type, tag",
      "  invite <email> --group <id> [--role admin|member]",
      "                                        send an email invite",
      "  tags       --group <id>               tag dictionary + tags in use",
      "  tag-add <id> --group <id> [--label <s>] [--color <s>]",
      "                                        define a tag in the dictionary",
      "  tag-rm  <id> --group <id>             remove a tag from the dictionary",
      "  tag-workbook --workbook <id> --tag <a> [--tag <b>]",
      "                                        replace the workbook's tag set",
      "  view list   --group <id>              show all views (★ marks default)",
      "  view pull   --group <id> [--out views.mjs]",
      "                                        dump views + config to a file you can edit",
      "  view push   <views.mjs> --group <id>  upsert views from a file",
      "  view delete <id> --group <id> [--scope user|group]",
      "  config get  --group <id>              show feature toggles + defaults",
      "  config set  <config.json> --group <id>  replace config blob",
      "",
    ].join("\n"),
  );
}
