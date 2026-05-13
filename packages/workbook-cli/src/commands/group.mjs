// `workbook group` — list groups, invite teammates, see members.
//
//   workbook group list
//   workbook group members --group <id>
//   workbook group invite <email> --group <id> [--role admin|member]
//   workbook group workbooks --group <id>

import {
  apiGet,
  apiPost,
  ensureBearer,
  DEFAULT_BROKER,
} from "../util/brokerClient.mjs";

export async function runGroup(flags) {
  const action = flags._?.[0];
  if (!action || action === "help" || action === "--help") return printUsage();
  const bearer = await ensureBearer({ force: flags["force-auth"] });
  const ctx = { bearer, broker: DEFAULT_BROKER };

  switch (action) {
    case "list":      return listGroups(ctx);
    case "members":   return listMembers(flags, ctx);
    case "workbooks": return listWorkbooks(flags, ctx);
    case "invite":    return invite(flags, ctx);
    case "help":      return printUsage();
    default:          usage(`unknown subcommand '${action}'`);
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
  const r = await apiGet(`/v1/groups/${encodeURIComponent(groupId)}/workbooks`, ctx);
  const wbs = r.workbooks ?? [];
  if (wbs.length === 0) {
    process.stdout.write("No workbooks in this group.\n");
    return;
  }
  for (const w of wbs) {
    const title = w.title ?? w.slug ?? "(untitled)";
    const status = w.revoked_at ? " [revoked]" : "";
    process.stdout.write(`  ${w.id}  ${title}${status}\n`);
  }
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
      "  workbooks  --group <id>               workbooks published to the group",
      "  invite <email> --group <id> [--role admin|member]",
      "                                        send an email invite",
      "",
    ].join("\n"),
  );
}
