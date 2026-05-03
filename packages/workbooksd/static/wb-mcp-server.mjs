#!/usr/bin/env node
// wb-mcp-server — Workbooks MCP server for external ACP CLIs.
//
// Spawned as a stdio subprocess by an MCP-aware host (claude /
// codex / any client supporting the Model Context Protocol).
// Speaks JSON-RPC 2.0 over newline-delimited stdin/stdout per the
// MCP wire format. Translates structured tool calls into HTTP
// requests against the local workbooks daemon, using the same
// permission gates + secrets policy as the wb-fetch bash shim.
//
// Why a structured MCP server in addition to the shell shim:
//
//   • Tool calls have schemas. The agent gets type validation +
//     auto-complete from its host, not just "shell tool blob."
//   • Error surface is JSON-RPC, not curl exit codes.
//   • One MCP server can advertise many tools — wb.fetch is the
//     v1 starter; more land as needed (composition, assets).
//
// Wire env (set by the daemon on adapter spawn, identical to
// the shim's contract):
//
//   WORKBOOKS_DAEMON_URL   http://127.0.0.1:<bound-port>
//   WORKBOOKS_TOKEN        32-hex session token
//
// Compatibility: pure Node 18+ (ESM, top-level await), no deps.
// Falls back to stderr logging if env is unset — host sees
// initialize fail with a clear reason rather than mysterious
// silence.

import { stdin, stdout, stderr, env } from "node:process";

const DAEMON = env.WORKBOOKS_DAEMON_URL;
const TOKEN = env.WORKBOOKS_TOKEN;

// MCP protocol version we implement. Hosts negotiate via
// initialize; we accept anything reasonable and report this.
const PROTOCOL_VERSION = "2024-11-05";

// The single tool exposed today. Schema follows the MCP
// ToolDefinition shape — `name`, `description`, `inputSchema`
// (JSON Schema). Hosts surface this to the model.
const TOOLS = [
  {
    name: "wb_fetch",
    description:
      "Fetch a URL through the workbooks daemon's secrets-aware HTTPS proxy. " +
      "Use this whenever the workbook needs to call an external API: the daemon " +
      "splices in keychain-stored secrets, enforces the per-workbook host " +
      "allowlist, and never exposes raw key material. Equivalent to the " +
      "wb-fetch bash shim, but with a structured response.",
    inputSchema: {
      type: "object",
      properties: {
        url:    { type: "string",  description: "Absolute https:// URL to call." },
        method: { type: "string",  description: "HTTP method.", default: "GET" },
        headers:{ type: "object",  description: "Request headers." },
        body:   { type: "string",  description: "Request body (utf-8)." },
        secret_id: {
          type: "string",
          description:
            "Optional keychain-stored secret to splice into the auth header. " +
            "The daemon enforces this secret's domain allowlist before adding it.",
        },
        auth_header: {
          type: "string",
          description: "Header name to put the secret in. Defaults to 'Authorization'.",
        },
        auth_prefix: {
          type: "string",
          description: "Prefix to prepend to the secret value, e.g. 'Bearer ' or 'Key '.",
        },
      },
      required: ["url"],
    },
  },
];

// ── stdio JSON-RPC plumbing ───────────────────────────────────

let buf = "";
stdin.setEncoding("utf8");
stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    handle(line).catch((e) => stderr.write(`[wb-mcp] handler crashed: ${e?.stack ?? e}\n`));
  }
});
stdin.on("end", () => process.exit(0));

function send(obj) {
  stdout.write(JSON.stringify(obj) + "\n");
}
function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function sendError(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
}

// ── method dispatch ───────────────────────────────────────────

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); }
  catch (e) { return sendError(null, -32700, "Parse error: " + e.message); }
  const { id, method, params } = msg ?? {};
  // Notifications (no id) — fire & forget.
  if (id === undefined && method !== "notifications/initialized") {
    return; // unknown notification; ignore
  }
  try {
    switch (method) {
      case "initialize":         return sendResult(id, await onInitialize(params));
      case "tools/list":         return sendResult(id, await onToolsList());
      case "tools/call":         return sendResult(id, await onToolsCall(params));
      case "ping":               return sendResult(id, {});
      case "notifications/initialized": return;  // sent post-handshake
      default:
        if (id !== undefined) sendError(id, -32601, `method not found: ${method}`);
        return;
    }
  } catch (e) {
    if (id !== undefined) sendError(id, -32603, e?.message ?? String(e));
  }
}

async function onInitialize(params) {
  // Echo back the host's protocol version when reasonable; if
  // they ask for something we don't speak, default to ours and
  // let them downgrade.
  const requested = params?.protocolVersion;
  return {
    protocolVersion: requested ?? PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: {
      name: "workbooks",
      version: "0.1.2",
    },
  };
}

async function onToolsList() {
  return { tools: TOOLS };
}

async function onToolsCall(params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  if (name === "wb_fetch") return wbFetch(args);
  throw new Error(`unknown tool: ${name}`);
}

// ── tool implementations ──────────────────────────────────────

async function wbFetch(args) {
  if (!DAEMON || !TOKEN) {
    throw new Error(
      "WORKBOOKS_DAEMON_URL / WORKBOOKS_TOKEN not set. " +
      "Run wb-mcp-server from inside a daemon-spawned session.",
    );
  }
  if (typeof args.url !== "string" || !args.url) {
    throw new Error("'url' is required");
  }

  const reqBody = {
    url: args.url,
    method: args.method ?? "GET",
    headers: args.headers ?? {},
    auth: args.secret_id
      ? {
          secret_id: args.secret_id,
          header: args.auth_header ?? "Authorization",
          prefix: args.auth_prefix ?? "",
        }
      : null,
    ...(args.body !== undefined ? { body: args.body } : {}),
  };

  const res = await fetch(`${DAEMON}/wb/${TOKEN}/proxy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: DAEMON },
    body: JSON.stringify(reqBody),
  });

  // Non-200 from the daemon is a permission deny / bad URL / etc.
  // Surface the daemon's plain-text reason as an MCP tool error
  // so the model sees structured failure rather than a 500.
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`daemon ${res.status}: ${text}`);
  }

  const env = await res.json();
  // MCP tool result is `{ content: [...] }`. Content blocks are
  // text/image/resource. We return text — the model can parse the
  // body itself if it's JSON.
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            status: env.status,
            headers: env.headers,
            body: env.body,
            body_b64: env.body_b64,
          },
          null,
          2,
        ),
      },
    ],
  };
}
