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
  apiPut,
  apiDelete,
  putBytes,
  DEFAULT_BROKER,
} from "../util/brokerClient.mjs";

const VERSION = "0.1.0";

export async function runMcp(flags) {
  const sub = flags._?.[0];
  if (sub !== "serve") {
    process.stdout.write(
      [
        "workbook mcp serve [--group <id>]   — start an MCP stdio server",
        "",
        "Without --group: exposes the admin tools (env, groups, publish,",
        "  search, invoke, etc).",
        "",
        "With --group <id>: ALSO advertises every tool exposed by every",
        "  workbook in that group, namespaced as wb__<workbook>__<tool>.",
        "  The agent can call those directly — they're routed through",
        "  workbooks_invoke under the hood.",
        "",
        "Claude Code config (add to ~/.claude/mcp.json):",
        '  { "mcpServers": { "workbooks": { "command": "workbook", "args": ["mcp", "serve"] } } }',
        "",
      ].join("\n"),
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
      description:
        "Workbooks in a group library, with optional filters: full-text query, " +
        "workbook types (spa/notebook/document), and required tags.",
      inputSchema: {
        group_id: z.string(),
        q: z.string().optional().describe("Substring match on title/description/slug/author"),
        types: z.array(z.string()).optional().describe("e.g. ['spa', 'notebook']"),
        tags: z.array(z.string()).optional().describe("All tags must match (AND)"),
        include_revoked: z.boolean().default(false),
      },
    },
    async ({ group_id, q, types, tags, include_revoked }) => {
      try {
        const qs = new URLSearchParams();
        if (q) qs.set("q", q);
        for (const t of types ?? []) qs.append("type", t);
        for (const t of tags ?? []) qs.append("tag", t);
        if (include_revoked) qs.set("include_revoked", "1");
        const suffix = qs.toString() ? `?${qs}` : "";
        return ok(await apiGet(`/v1/groups/${encodeURIComponent(group_id)}/workbooks${suffix}`, await ctx()));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "workbooks_group_tags",
    {
      title: "List group's tag dictionary",
      description: "Returns the group's defined tag dictionary plus the set of tags actually applied to its workbooks.",
      inputSchema: { group_id: z.string() },
    },
    async ({ group_id }) => {
      try {
        return ok(await apiGet(`/v1/groups/${encodeURIComponent(group_id)}/tags`, await ctx()));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "workbooks_group_tag_define",
    {
      title: "Define / update a tag in the group dictionary",
      description: "Adds metadata (label + color) to a tag. Tag ids can contain '/' so Finder mode reads them as paths.",
      inputSchema: {
        group_id: z.string(),
        tag_id: z.string().describe("kebab-case, ascii, slashes ok"),
        label: z.string().optional(),
        color: z.string().optional(),
      },
    },
    async ({ group_id, tag_id, label, color }) => {
      try {
        return ok(await apiPost(
          `/v1/groups/${encodeURIComponent(group_id)}/tags`,
          { tag_id, label, color },
          await ctx(),
        ));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "workbooks_group_tag_delete",
    {
      title: "Remove a tag from the group dictionary",
      description: "Removes the dictionary row only. Workbooks tagged with it keep the tag.",
      inputSchema: { group_id: z.string(), tag_id: z.string() },
    },
    async ({ group_id, tag_id }) => {
      try {
        return ok(await apiDelete(
          `/v1/groups/${encodeURIComponent(group_id)}/tags/${encodeURIComponent(tag_id)}`,
          await ctx(),
        ));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "workbooks_workbook_tags_set",
    {
      title: "Set the tags on a workbook (replace)",
      description: "Replaces the workbook's full tag set. Pass [] to clear.",
      inputSchema: {
        workbook_id: z.string(),
        tags: z.array(z.string()),
      },
    },
    async ({ workbook_id, tags }) => {
      try {
        return ok(await apiPut(
          `/v1/workbooks/${encodeURIComponent(workbook_id)}/tags`,
          { tags },
          await ctx(),
        ));
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
        type: z.string().optional().describe("Workbook type: spa | notebook | document | presentation, or custom"),
        tags: z.array(z.string()).optional().describe("Tag ids to apply at publish"),
        connect: z.record(z.any()).optional().describe(
          "Workbook's `connect:` declaration; overrides the value in workbook.config.mjs",
        ),
      },
    },
    async ({ path, group_id, slug, title, description, type, tags, connect }) => {
      try {
        const html = await fs.readFile(path, "utf8");
        const created = await apiPost(
          "/v1/workbooks/public",
          {
            slug,
            title,
            description,
            connect,
            type,
            tags,
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

  // ── Group views (Phase 2) ──────────────────────────────────────

  server.registerTool(
    "workbooks_group_views",
    {
      title: "List a group's views + config",
      description:
        "Returns the group's feature config and every saved view (group-level + caller's user-level overrides).",
      inputSchema: { group_id: z.string() },
    },
    async ({ group_id }) => {
      try {
        return ok(await apiGet(`/v1/groups/${encodeURIComponent(group_id)}/views`, await ctx()));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "workbooks_group_config_set",
    {
      title: "Set the group's portal config",
      description:
        "Replaces the group's config blob (feature toggles, default view id, tag dictionary visibility, etc). Admin only.",
      inputSchema: { group_id: z.string(), config: z.record(z.any()) },
    },
    async ({ group_id, config }) => {
      try {
        return ok(await apiPut(
          `/v1/groups/${encodeURIComponent(group_id)}/config`,
          config,
          await ctx(),
        ));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "workbooks_group_view_upsert",
    {
      title: "Create or update a group view",
      description:
        "Saves a view (a layout + filter + sort + group_by) under a stable id. " +
        "scope='group' (default) is admin-only and visible to everyone; " +
        "scope='user' is private to the caller. " +
        "Layouts: list, grid, table, kanban, finder, gallery, timeline. " +
        "Filter shape is a JSON object the renderer interprets — typically { all:[…], any:[…], none:[…] } with operator-tagged predicates.",
      inputSchema: {
        group_id: z.string(),
        view_id: z.string().describe("Slug, lower-kebab, unique per (group, scope)"),
        name: z.string(),
        layout: z.enum(["list", "grid", "table", "kanban", "finder", "gallery", "timeline"]),
        scope: z.enum(["group", "user"]).default("group"),
        filter: z.any().optional(),
        sort: z.object({
          by: z.enum(["newest", "alpha", "updated", "views"]),
          dir: z.enum(["asc", "desc"]),
        }).optional(),
        group_by: z.enum(["none", "type", "tag", "author"]).default("none"),
        fields: z.array(z.string()).optional(),
        featured_id: z.string().optional(),
        position: z.number().optional(),
      },
    },
    async (args) => {
      try {
        const { group_id, view_id, ...body } = args;
        return ok(await apiPut(
          `/v1/groups/${encodeURIComponent(group_id)}/views/${encodeURIComponent(view_id)}`,
          body,
          await ctx(),
        ));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "workbooks_group_view_delete",
    {
      title: "Delete a group view",
      description: "Removes a view. scope='group' admin-only; scope='user' deletes the caller's private override.",
      inputSchema: {
        group_id: z.string(),
        view_id: z.string(),
        scope: z.enum(["group", "user"]).default("group"),
      },
    },
    async ({ group_id, view_id, scope }) => {
      try {
        return ok(await apiDelete(
          `/v1/groups/${encodeURIComponent(group_id)}/views/${encodeURIComponent(view_id)}?scope=${scope}`,
          await ctx(),
        ));
      } catch (e) { return fail(e); }
    },
  );

  // ── Search + invoke (workbook-as-MCP, #82) ────────────────────

  server.registerTool(
    "workbooks_search",
    {
      title: "Search workbooks (semantic + filters)",
      description:
        "Full-text or semantic search across a group's workbooks. " +
        "Returns each hit's tools[] catalogue so an agent can route to a " +
        "workbook's exposed tools without a second round-trip. Use " +
        "`vector: true` to force vector search regardless of group config; " +
        "default falls back to substring when the group hasn't enabled " +
        "semantic search.",
      inputSchema: {
        group_id: z.string(),
        query: z.string().optional(),
        types: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        vector: z.boolean().default(false),
      },
    },
    async ({ group_id, query, types, tags, vector }) => {
      try {
        const qs = new URLSearchParams();
        if (query) qs.set("q", query);
        for (const t of types ?? []) qs.append("type", t);
        for (const t of tags ?? []) qs.append("tag", t);
        if (vector) qs.set("vector", "1");
        const suffix = qs.toString() ? `?${qs}` : "";
        return ok(await apiGet(
          `/v1/groups/${encodeURIComponent(group_id)}/workbooks${suffix}`,
          await ctx(),
        ));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "workbooks_tools_list",
    {
      title: "Read a workbook's tool catalogue",
      description:
        "Returns the workbook's declared tools (name, description, input/output schema). " +
        "Use this after `workbooks_search` to introspect a candidate workbook's " +
        "capabilities before invoking.",
      inputSchema: { workbook_id: z.string() },
    },
    async ({ workbook_id }) => {
      try {
        return ok(await apiGet(`/v1/workbooks/${encodeURIComponent(workbook_id)}/tools`, await ctx()));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "workbooks_invoke",
    {
      title: "Invoke a tool exposed by a workbook",
      description:
        "Dispatches `args` to the named tool on the workbook. Today returns an " +
        "`invoke_url` the agent can open to run client-side; server-side execution " +
        "via Cloudflare Worker Loader lands when that capability exits closed beta. " +
        "The response always includes the tool definition (input/output schema) so " +
        "the agent can validate args + parse the result.",
      inputSchema: {
        workbook_id: z.string(),
        tool: z.string().describe("Tool name as advertised by workbooks_tools_list"),
        args: z.any().optional(),
      },
    },
    async ({ workbook_id, tool, args }) => {
      try {
        return ok(await apiPost(
          `/v1/workbooks/${encodeURIComponent(workbook_id)}/invoke`,
          { tool, args },
          await ctx(),
        ));
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

  // Per-group surface (#84). When --group is passed, fetch every
  // workbook in the group and register one MCP tool per (workbook,
  // tool) pair. Names are namespaced wb__<workbook_id>__<tool_name>
  // so collisions are impossible. The implementation routes through
  // the broker's /invoke endpoint — same execution semantics as
  // workbooks_invoke, just with a friendlier tool name for the agent.
  const groupId = flags.group;
  if (groupId) {
    try {
      const r = await apiGet(
        `/v1/groups/${encodeURIComponent(groupId)}/workbooks`,
        await ctx(),
      );
      const wbs = r.workbooks ?? [];
      let registered = 0;
      for (const wb of wbs) {
        if (!Array.isArray(wb.tools) || wb.tools.length === 0) continue;
        if (wb.revoked_at) continue;
        const wbLabel = wb.title ?? wb.slug ?? wb.id;
        for (const tool of wb.tools) {
          if (!tool?.name) continue;
          const mcpName = `wb__${slugifyId(wb.id)}__${tool.name}`;
          const title = `${wbLabel}: ${tool.name}`;
          server.registerTool(
            mcpName,
            {
              title,
              description:
                (tool.description ?? `Invoke '${tool.name}' on the '${wbLabel}' workbook.`) +
                `\n\nWorkbook id: ${wb.id}` +
                (tool.input_schema
                  ? `\nInput schema: ${JSON.stringify(tool.input_schema).slice(0, 800)}`
                  : ""),
              // Generic args — the workbook's true schema lives in
              // tool.input_schema; we accept anything and pass through.
              inputSchema: { args: z.any().optional() },
            },
            async ({ args }) => {
              try {
                return ok(await apiPost(
                  `/v1/workbooks/${encodeURIComponent(wb.id)}/invoke`,
                  { tool: tool.name, args: args ?? null },
                  await ctx(),
                ));
              } catch (e) { return fail(e); }
            },
          );
          registered++;
        }
      }
      // Helpful banner — visible in MCP client logs when the server starts.
      process.stderr.write(
        `[workbooks-mcp] registered ${registered} group-tool(s) from ${wbs.length} workbook(s) in ${groupId}\n`,
      );
    } catch (e) {
      process.stderr.write(
        `[workbooks-mcp] failed to load group ${groupId}: ${(e?.message ?? e)}\n`,
      );
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** Workbook ids contain "-" and "_" already; MCP tool names should be
 *  a stable kebab/snake variant. Strip anything non-alnum/_ and cap
 *  the length so the namespaced tool name fits common MCP limits. */
function slugifyId(id) {
  return String(id).replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 32);
}
