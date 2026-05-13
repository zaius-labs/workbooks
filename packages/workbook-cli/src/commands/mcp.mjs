// `workbook mcp serve` — a stdio MCP server that exposes the same
// control-plane operations the `workbook env` / `workbook group`
// subcommands offer, so Claude Code / Cursor / Codex can manage a
// Workbooks Studio account through structured tool calls.
//
// Auth model is identical to the CLI: WORKBOOKS_API_TOKEN takes
// precedence; falls back to the cached browser bearer at
// ~/.config/workbooks/auth.json. If neither is present a tool call
// triggers loopback OAuth — fine in a local dev shell, awkward in
// an IDE, so the README will tell people to run `workbook env list`
// once first to seed the cache.

import fs from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ensureBearer,
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  putBytes,
  DEFAULT_BROKER,
} from "../util/brokerClient.mjs";

const VERSION = "0.1.0";

export async function runMcp(flags) {
  const sub = flags._?.[0];
  if (sub !== "serve") {
    process.stdout.write(
      "workbook mcp serve   — start an MCP stdio server\n" +
        "\nClaude Code config (add to ~/.claude/mcp.json):\n" +
        '  { "mcpServers": { "workbooks": { "command": "workbook", "args": ["mcp", "serve"] } } }\n',
    );
    process.exit(sub ? 2 : 0);
  }

  const server = new McpServer({
    name: "workbooks",
    version: VERSION,
  });

  // Lazy bearer — only run the OAuth flow when a tool call actually
  // needs to hit the broker. Cache so repeat calls in one session
  // don't re-resolve.
  let cachedBearer = null;
  async function bearer() {
    if (cachedBearer) return cachedBearer;
    cachedBearer = await ensureBearer();
    return cachedBearer;
  }
  const ctx = async () => ({ bearer: await bearer(), broker: DEFAULT_BROKER });

  function ok(payload) {
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    };
  }
  function fail(err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }],
    };
  }

  // ── Groups ─────────────────────────────────────────────────────

  server.registerTool(
    "workbooks_groups_list",
    {
      title: "List groups",
      description: "Return every group the authenticated user belongs to, with role.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await apiGet("/v1/groups/me", await ctx()));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "workbooks_group_members",
    {
      title: "List group members",
      description: "Members and pending invites for a group.",
      inputSchema: { group_id: z.string() },
    },
    async ({ group_id }) => {
      try {
        return ok(await apiGet(`/v1/groups/${encodeURIComponent(group_id)}/members`, await ctx()));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "workbooks_group_workbooks",
    {
      title: "List workbooks in a group",
      description: "Workbooks published into a group library.",
      inputSchema: { group_id: z.string() },
    },
    async ({ group_id }) => {
      try {
        return ok(await apiGet(`/v1/groups/${encodeURIComponent(group_id)}/workbooks`, await ctx()));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "workbooks_group_invite",
    {
      title: "Invite a teammate to a group",
      description: "Send a group invite by email. Recipient gets added on next sign-in.",
      inputSchema: {
        group_id: z.string(),
        email: z.string().email(),
        role: z.enum(["admin", "member"]).default("member"),
      },
    },
    async ({ group_id, email, role }) => {
      try {
        return ok(await apiPost(
          `/v1/groups/${encodeURIComponent(group_id)}/invites`,
          { email, role },
          await ctx(),
        ));
      } catch (e) { return fail(e); }
    },
  );

  // ── Env vars ───────────────────────────────────────────────────

  server.registerTool(
    "workbooks_env_list",
    {
      title: "List env vars for a group",
      description: "Returns metadata only — names, scopes, last-used. Never plaintext values.",
      inputSchema: { group_id: z.string() },
    },
    async ({ group_id }) => {
      try {
        return ok(await apiGet(`/v1/groups/${encodeURIComponent(group_id)}/env`, await ctx()));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "workbooks_env_set",
    {
      title: "Add / replace an env var",
      description:
        "Store a value the broker can splice into outbound calls from workbooks in this group. " +
        "Workbook authors declare destinations + splice rules via `connect:` in workbook.config.mjs.",
      inputSchema: {
        group_id: z.string(),
        name: z.string().describe("UPPER_SNAKE_CASE, max 64 chars"),
        value: z.string(),
        workbook_id: z.string().optional().describe("If set, scopes the var to one workbook"),
      },
    },
    async ({ group_id, name, value, workbook_id }) => {
      try {
        const body = workbook_id
          ? { name, value, scope: "workbook", workbook_id }
          : { name, value, scope: "group" };
        return ok(await apiPost(
          `/v1/groups/${encodeURIComponent(group_id)}/env`,
          body,
          await ctx(),
        ));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "workbooks_env_rotate",
    {
      title: "Rotate an env var value",
      description: "Change the stored value of an existing env var. Same name + scope.",
      inputSchema: {
        group_id: z.string(),
        env_var_id: z.string(),
        value: z.string(),
      },
    },
    async ({ group_id, env_var_id, value }) => {
      try {
        return ok(await apiPatch(
          `/v1/groups/${encodeURIComponent(group_id)}/env/${encodeURIComponent(env_var_id)}`,
          { value },
          await ctx(),
        ));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "workbooks_env_delete",
    {
      title: "Revoke an env var",
      description: "Soft-revokes the var. Workbooks using it start failing immediately.",
      inputSchema: {
        group_id: z.string(),
        env_var_id: z.string(),
      },
    },
    async ({ group_id, env_var_id }) => {
      try {
        return ok(await apiDelete(
          `/v1/groups/${encodeURIComponent(group_id)}/env/${encodeURIComponent(env_var_id)}`,
          await ctx(),
        ));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "workbooks_env_import",
    {
      title: "Bulk import env vars",
      description: "Add many vars at once (like pasting a .env). Skips existing names unless replace=true.",
      inputSchema: {
        group_id: z.string(),
        entries: z.array(z.object({ name: z.string(), value: z.string() })),
        workbook_id: z.string().optional(),
        replace: z.boolean().default(false),
      },
    },
    async ({ group_id, entries, workbook_id, replace }) => {
      try {
        const body = {
          entries,
          replace,
          ...(workbook_id ? { scope: "workbook", workbook_id } : { scope: "group" }),
        };
        return ok(await apiPost(
          `/v1/groups/${encodeURIComponent(group_id)}/env/bulk`,
          body,
          await ctx(),
        ));
      } catch (e) { return fail(e); }
    },
  );

  // ── Publishing / usage ─────────────────────────────────────────

  server.registerTool(
    "workbooks_publish",
    {
      title: "Publish a built .html workbook",
      description:
        "Uploads a compiled workbook artifact and returns its share URL. " +
        "The file at `path` must already exist (run `workbook build` first).",
      inputSchema: {
        path: z.string().describe("Absolute or cwd-relative path to a built .html file"),
        group_id: z.string().optional().describe("Publish into a group library (members-only)"),
        slug: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        connect: z.record(z.any()).optional().describe(
          "Workbook's `connect:` declaration; overrides the value in workbook.config.mjs",
        ),
      },
    },
    async ({ path, group_id, slug, title, description, connect }) => {
      try {
        const html = await fs.readFile(path, "utf8");
        const created = await apiPost(
          "/v1/workbooks/public",
          {
            slug,
            title,
            description,
            connect,
            group_id: group_id ?? null,
          },
          await ctx(),
        );
        await putBytes(
          `/v1/workbooks/${encodeURIComponent(created.id)}/artifact`,
          html,
          await ctx(),
        );
        return ok({
          id: created.id,
          share_url: created.share_url,
          studio_url: `https://studio.workbooks.sh/workbooks/${created.id}`,
        });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "workbooks_workbook_views",
    {
      title: "Per-viewer usage for a workbook",
      description: "List who has opened a workbook and how often. Author or group admin only.",
      inputSchema: { workbook_id: z.string() },
    },
    async ({ workbook_id }) => {
      try {
        return ok(await apiGet(`/v1/workbooks/${encodeURIComponent(workbook_id)}/views`, await ctx()));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "workbooks_workbook_revoke",
    {
      title: "Revoke a workbook",
      description: "Marks a workbook revoked. Subsequent fetches of the artifact 410.",
      inputSchema: { workbook_id: z.string() },
    },
    async ({ workbook_id }) => {
      try {
        return ok(await apiPost(
          `/v1/workbooks/${encodeURIComponent(workbook_id)}/revoke`,
          {},
          await ctx(),
        ));
      } catch (e) { return fail(e); }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
