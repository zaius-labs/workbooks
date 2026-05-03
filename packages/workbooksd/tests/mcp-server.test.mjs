#!/usr/bin/env bun
// E2E for core-5ah.11 — MCP server.
//
// What we're proving: when the daemon spawns an ACP adapter, it
// installs <scratch>/.bin/wb-mcp-server alongside wb-fetch. The
// MCP server speaks JSON-RPC 2.0 over stdio (the protocol claude
// / codex use to consume MCP tools), advertises a `wb_fetch`
// tool, and successfully translates calls into /proxy requests
// honoring the same permission gates wb-fetch uses.
//
// We drive the server directly (no LLM in the loop) — that's
// what claude/codex would do internally. Tests:
//   A. Script is installed + executable post-spawn
//   B. initialize handshake returns serverInfo + capabilities
//   C. tools/list returns the wb_fetch schema
//   D. tools/call wb_fetch hits /proxy and round-trips the body
//   E. tools/call without permissions surfaces the daemon's
//      403 as a structured MCP error

import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { which } from "bun";
import { daemonUrl } from "./_runtime.mjs";

const DAEMON = daemonUrl();
const ORIGIN = DAEMON;
const fail = (msg) => { console.error(`[fail] ${msg}`); process.exit(1); };
const pass = (msg) => { console.log(`[pass] ${msg}`); process.exit(0); };

if (!which("claude")) {
  console.log("[skip] claude not on PATH; this E2E needs an adapter spawn to install wb-mcp-server");
  process.exit(0);
}
if (!which("node")) {
  console.log("[skip] node not on PATH; the MCP server requires Node 18+");
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), "workbooks-mcp-"));
const wbPath = join(tmp, "test.workbook.html");
const policyB64 = Buffer.from(JSON.stringify({})).toString("base64");
const permsB64 = Buffer.from(JSON.stringify({ network: { reason: "mcp test" } })).toString("base64");
writeFileSync(
  wbPath,
  `<!doctype html><html><head>
<script id="wb-meta" type="application/json">${JSON.stringify({
    workbook_id: "mcp-e2e",
    compaction_seq: 0,
    snapshot_cid_by_target: {},
  })}</script>
<meta name="wb-permissions" content="${permsB64}">
<meta name="wb-secrets-policy" content="${policyB64}">
</head><body></body></html>`,
);

const cleanup = () => rmSync(tmp, { recursive: true, force: true });
const exitFail = (msg) => { cleanup(); fail(msg); };
const exitPass = (msg) => { cleanup(); pass(msg); };

// 1. Open + serve to populate session perms.
const { token } = await (await fetch(`${DAEMON}/open`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ path: wbPath }),
})).json();
await fetch(`${DAEMON}/wb/${token}/`);
await fetch(`${DAEMON}/wb/${token}/permissions/approve`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: ORIGIN },
  body: JSON.stringify({ ids: ["network"] }),
});

// 2. Spawn adapter so the daemon installs the MCP server in
//    <scratch>/.bin. Keep the WS open during the test (otherwise
//    run_relay's exit cleans up the scratch dir).
const wsUrl = `${DAEMON.replace(/^http/, "ws")}/wb/${token}/agent/claude`;
const ws = new WebSocket(wsUrl, { headers: { Origin: ORIGIN } });
let initSeen = false;
ws.addEventListener("open", () => {
  ws.send(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {} },
  }) + "\n");
});
ws.addEventListener("message", (ev) => {
  for (const line of ev.data.split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id === 1 && msg.result) initSeen = true;
    } catch {}
  }
});
const dl = Date.now() + 25_000;
while (!initSeen && Date.now() < dl) await new Promise((r) => setTimeout(r, 200));
if (!initSeen) { ws.close(); exitFail("adapter never initialized"); }

// A. Script is installed + executable.
const scratch = join(homedir(), "Library/Caches/sh.workbooks.workbooksd/sessions", token);
const mcpPath = join(scratch, ".bin/wb-mcp-server");
if (!existsSync(mcpPath)) { ws.close(); exitFail(`wb-mcp-server not installed at ${mcpPath}`); }
console.log(`[step] A ok — wb-mcp-server installed`);

// 3. Spawn the MCP server with the daemon env. Drive via stdin /
//    parse JSON-RPC frames from stdout. Keep WS open the whole
//    time (scratch dir exists only while WS lives).
const proc = spawn("node", [mcpPath], {
  env: { ...process.env, WORKBOOKS_DAEMON_URL: DAEMON, WORKBOOKS_TOKEN: token },
  stdio: ["pipe", "pipe", "pipe"],
});
proc.stderr.on("data", (b) => process.stderr.write(`[mcp-stderr] ${b}`));

const responses = new Map();           // id → resolve
let outBuf = "";
proc.stdout.on("data", (chunk) => {
  outBuf += chunk.toString();
  let nl;
  while ((nl = outBuf.indexOf("\n")) >= 0) {
    const line = outBuf.slice(0, nl).trim();
    outBuf = outBuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && responses.has(msg.id)) {
      const r = responses.get(msg.id);
      responses.delete(msg.id);
      r(msg);
    }
  }
});

let nextId = 100;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    responses.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (responses.has(id)) {
        responses.delete(id);
        reject(new Error(`rpc ${method} timed out`));
      }
    }, 15_000);
  });
}

// B. initialize.
const initRes = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "wb-mcp-e2e", version: "1" },
});
if (initRes.error) { proc.kill(); ws.close(); exitFail(`initialize: ${initRes.error.message}`); }
if (initRes.result?.serverInfo?.name !== "workbooks") {
  proc.kill(); ws.close();
  exitFail(`unexpected serverInfo: ${JSON.stringify(initRes.result?.serverInfo)}`);
}
console.log(`[step] B ok — initialize handshake (server=${initRes.result.serverInfo.name} v${initRes.result.serverInfo.version})`);

// C. tools/list.
const listRes = await rpc("tools/list", {});
if (listRes.error) { proc.kill(); ws.close(); exitFail(`tools/list: ${listRes.error.message}`); }
const tools = listRes.result?.tools ?? [];
const wbFetch = tools.find((t) => t.name === "wb_fetch");
if (!wbFetch) { proc.kill(); ws.close(); exitFail(`wb_fetch tool not advertised; got: ${tools.map((t) => t.name).join(", ")}`); }
if (!wbFetch.inputSchema?.properties?.url) { proc.kill(); ws.close(); exitFail("wb_fetch input schema missing 'url'"); }
console.log(`[step] C ok — tools/list (${tools.length} tool, schema valid)`);

// D. tools/call wb_fetch — should round-trip example.com.
const callRes = await rpc("tools/call", {
  name: "wb_fetch",
  arguments: { url: "https://example.com", method: "GET" },
});
if (callRes.error) { proc.kill(); ws.close(); exitFail(`tools/call: ${callRes.error.message}`); }
const block = callRes.result?.content?.[0];
if (block?.type !== "text") { proc.kill(); ws.close(); exitFail(`unexpected content shape: ${JSON.stringify(callRes.result)}`); }
const env = JSON.parse(block.text);
if (env.status !== 200) { proc.kill(); ws.close(); exitFail(`upstream status ${env.status}, expected 200`); }
if (!String(env.body).includes("Example Domain")) {
  proc.kill(); ws.close();
  exitFail(`body missing 'Example Domain' marker; got: ${String(env.body).slice(0, 200)}`);
}
console.log(`[step] D ok — wb_fetch round-tripped example.com (${String(env.body).length} bytes)`);

// E. New session WITHOUT the network grant — same MCP server,
//    different token, daemon should refuse the /proxy call and
//    we should see it as an MCP error.
const wbPath2 = join(tmp, "deny.workbook.html");
writeFileSync(
  wbPath2,
  `<!doctype html><html><head>
<script id="wb-meta" type="application/json">${JSON.stringify({
    workbook_id: "mcp-deny",
    compaction_seq: 0,
    snapshot_cid_by_target: {},
  })}</script>
<meta name="wb-permissions" content="${permsB64}">
</head><body></body></html>`,
);
const r2 = await (await fetch(`${DAEMON}/open`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ path: wbPath2 }),
})).json();
await fetch(`${DAEMON}/wb/${r2.token}/`);

const proc2 = spawn("node", [mcpPath], {
  env: { ...process.env, WORKBOOKS_DAEMON_URL: DAEMON, WORKBOOKS_TOKEN: r2.token },
  stdio: ["pipe", "pipe", "pipe"],
});
proc2.stderr.on("data", () => {});  // discard
const r2Responses = new Map();
let r2Buf = "";
proc2.stdout.on("data", (b) => {
  r2Buf += b.toString();
  let nl;
  while ((nl = r2Buf.indexOf("\n")) >= 0) {
    const line = r2Buf.slice(0, nl).trim();
    r2Buf = r2Buf.slice(nl + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (m.id !== undefined && r2Responses.has(m.id)) { r2Responses.get(m.id)(m); r2Responses.delete(m.id); }
    } catch {}
  }
});
function rpc2(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    r2Responses.set(id, resolve);
    proc2.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (r2Responses.has(id)) { r2Responses.delete(id); reject(new Error("timeout")); } }, 15_000);
  });
}
await rpc2("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: {} });
const denyRes = await rpc2("tools/call", {
  name: "wb_fetch",
  arguments: { url: "https://example.com" },
});
proc2.kill(); proc.kill(); ws.close();
if (!denyRes.error) exitFail(`expected error for un-granted network; got success: ${JSON.stringify(denyRes.result).slice(0, 200)}`);
if (!/network.*permission|permission.*network|403/i.test(denyRes.error.message)) {
  exitFail(`expected permission-denied error; got: ${denyRes.error.message}`);
}
console.log(`[step] E ok — un-granted session surfaces permission-denied as MCP error`);

exitPass("MCP server installed, JSON-RPC handshake + tools/list + tools/call all round-trip");
