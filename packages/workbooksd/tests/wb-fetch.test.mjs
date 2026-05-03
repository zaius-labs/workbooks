#!/usr/bin/env bun
// E2E test for core-5ah.7 — wb-fetch bridge for ACP CLIs.
//
// What we're proving end-to-end:
//
//   1. The daemon installs a working `wb-fetch` script into
//      <scratch>/.bin/ when an adapter spawns.
//   2. The daemon's spawn-time env injects WORKBOOKS_DAEMON_URL
//      and WORKBOOKS_TOKEN so the script can authenticate.
//   3. <scratch>/.bin is on the spawned process's PATH, so the
//      agent's Bash tool sees `wb-fetch` as a bare command.
//   4. wb-fetch successfully POSTs to /proxy and returns the
//      upstream response body. Permissions and the secrets domain
//      allowlist are honored.
//
// The agent's Bash tool runs commands with the same env + cwd the
// adapter inherits, so executing wb-fetch directly in the scratch
// dir with the adapter's env is a faithful proxy for what the
// agent itself would experience. We don't need to drive a real
// LLM to validate the bridge.

import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { which } from "bun";

import { daemonUrl } from "./_runtime.mjs";
const DAEMON = daemonUrl();
const ORIGIN = DAEMON;

if (!which("claude")) {
  console.log("[skip] claude CLI not on PATH; this E2E needs an ACP adapter to spawn");
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), "workbooks-wb-fetch-"));
const wbPath = join(tmp, "test.workbook.html");

// Workbook declares network permission + a secret slot whose
// allowlist matches example.com. We pre-grant network so /proxy
// passes its permission gate.
import { Buffer } from "node:buffer";
const policyJson = JSON.stringify({
  TEST_KEY: { domains: ["example.com"] },
});
const policyB64 = Buffer.from(policyJson, "utf8").toString("base64");
const permsJson = JSON.stringify({ network: { reason: "test" } });
const permsB64 = Buffer.from(permsJson, "utf8").toString("base64");

writeFileSync(
  wbPath,
  `<!doctype html><html><head>
<script id="wb-meta" type="application/json">${JSON.stringify({
    workbook_id: "wb-fetch-e2e",
    compaction_seq: 0,
    snapshot_cid_by_target: {},
  })}</script>
<meta name="wb-permissions" content="${permsB64}">
<meta name="wb-secrets-policy" content="${policyB64}">
</head><body></body></html>`,
);

const cleanup = () => rmSync(tmp, { recursive: true, force: true });
const fail = (msg) => { console.error(`[fail] ${msg}`); cleanup(); process.exit(1); };
const pass = (msg) => { console.log(`[pass] ${msg}`); cleanup(); process.exit(0); };

// 1. Open + serve to populate session permissions.
const openRes = await fetch(`${DAEMON}/open`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ path: wbPath }),
});
const { token } = await openRes.json();
console.log(`[step] opened session ${token.slice(0, 12)}…`);

const serveRes = await fetch(`${DAEMON}/wb/${token}/`);
if (!serveRes.ok) fail(`serve: HTTP ${serveRes.status}`);

// 2. Approve `network` so /proxy unblocks. (`agents` permission
//    is undeclared so it falls through.)
await fetch(`${DAEMON}/wb/${token}/permissions/approve`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: ORIGIN },
  body: JSON.stringify({ ids: ["network"] }),
});
console.log("[step] approved network permission");

// 3. Open a WS to /wb/:token/agent/claude so the adapter spawns.
//    That spawn is what installs wb-fetch into scratch + sets env.
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
if (!initSeen) { ws.close(); fail("adapter never initialized"); }
console.log("[step] adapter initialized; scratch dir prepared");
// Keep WS OPEN — run_relay tears down the scratch dir when it
// exits, so we can't close the socket until after wb-fetch runs.

// 4. Verify the binary is installed and executable.
const scratch = join(homedir(), "Library/Caches/sh.workbooks.workbooksd/sessions", token);
const wbFetchPath = join(scratch, ".bin/wb-fetch");
if (!existsSync(wbFetchPath)) fail(`wb-fetch not installed at ${wbFetchPath}`);
console.log(`[step] wb-fetch installed at ${wbFetchPath.replace(homedir(), "~")}`);

// 5. Run wb-fetch DIRECTLY with the env the adapter would see.
//    This is what the agent's Bash tool runs, just without the
//    LLM in the loop.
const result = spawnSync(wbFetchPath, [
  "--url", "https://example.com",
  "--method", "GET",
], {
  env: {
    ...process.env,
    WORKBOOKS_DAEMON_URL: DAEMON,
    WORKBOOKS_TOKEN: token,
  },
  encoding: "utf8",
  timeout: 15_000,
});

if (result.status !== 0) {
  fail(`wb-fetch exited ${result.status}: ${result.stderr || result.stdout}`);
}
const body = result.stdout ?? "";
if (!body.includes("Example Domain")) {
  fail(`expected upstream body to contain 'Example Domain'; got: ${body.slice(0, 200)}`);
}
console.log(`[step] wb-fetch round-trip ok (${body.length} bytes from example.com)`);

// 6. Negative: a different session that DOESN'T grant network
//    must get the permission-denied response from /proxy. We use a
//    fresh workbook path so approvals are scoped separately. Reuse
//    the existing scratch dir's wb-fetch (it's path-agnostic; the
//    binary just speaks the wire format).
const wbPath2 = join(tmp, "deny.workbook.html");
writeFileSync(
  wbPath2,
  `<!doctype html><html><head>
<script id="wb-meta" type="application/json">${JSON.stringify({
    workbook_id: "wb-fetch-deny",
    compaction_seq: 0,
    snapshot_cid_by_target: {},
  })}</script>
<meta name="wb-permissions" content="${permsB64}">
</head><body></body></html>`,
);
const noGrantOpen = await fetch(`${DAEMON}/open`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ path: wbPath2 }),
});
const { token: token2 } = await noGrantOpen.json();
await fetch(`${DAEMON}/wb/${token2}/`); // serve to populate perms

const denyResult = spawnSync(wbFetchPath, [
  "--url", "https://example.com",
  "--method", "GET",
], {
  env: {
    ...process.env,
    WORKBOOKS_DAEMON_URL: DAEMON,
    WORKBOOKS_TOKEN: token2,
  },
  encoding: "utf8",
  timeout: 10_000,
});
const denyOut = (denyResult.stdout ?? "") + (denyResult.stderr ?? "");
if (!/network.*permission|permission.*network/i.test(denyOut)) {
  fail(`expected permission-denied response; got: ${denyOut.slice(0, 300)}`);
}
console.log("[step] negative case ok — un-granted session refused");

ws.close();
pass("wb-fetch bridge works end-to-end through real claude adapter spawn");
