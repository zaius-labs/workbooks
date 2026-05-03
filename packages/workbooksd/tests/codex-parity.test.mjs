#!/usr/bin/env bun
// E2E for core-5ah.9 — Codex CLI parity.
//
// Asserts the Codex adapter is end-to-end equivalent to Claude
// for the surfaces we've shipped this run:
//   - Adapter spawn + ACP initialize
//   - wb-fetch installation into <scratch>/.bin/
//   - WORKBOOKS_DAEMON_URL / WORKBOOKS_TOKEN env injection
//   - Binary asset round-trip via the file watcher
//   - /proxy permission gate honored via wb-fetch
//
// We don't drive the LLM end of either adapter — we just spawn
// the adapter, exercise the daemon-mediated surfaces, and assert
// they behave the same way. That's parity at the integration
// layer, which is where every previous bug surfaced.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { which } from "bun";

import { daemonUrl } from "./_runtime.mjs";
const DAEMON = daemonUrl();
const ORIGIN = DAEMON;
const ADAPTER = "codex";

if (!which(ADAPTER)) {
  console.log(`[skip] ${ADAPTER} CLI not on PATH`);
  process.exit(0);
}

const PNG = Buffer.from([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,
  0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,
  0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,
  0x08,0x06,0x00,0x00,0x00,0x1f,0x15,0xc4,
  0x89,0x00,0x00,0x00,0x0a,0x49,0x44,0x41,
  0x54,0x78,0x9c,0x63,0x00,0x01,0x00,0x00,
  0x05,0x00,0x01,0x0d,0x0a,0x2d,0xb4,0x00,
  0x00,0x00,0x00,0x49,0x45,0x4e,0x44,0xae,
  0x42,0x60,0x82,
]);

const tmp = mkdtempSync(join(tmpdir(), `workbooks-${ADAPTER}-parity-`));
const wbPath = join(tmp, "test.workbook.html");

const policyJson = JSON.stringify({ TEST_KEY: { domains: ["example.com"] } });
const permsJson = JSON.stringify({ network: { reason: "test" } });
const policyB64 = Buffer.from(policyJson).toString("base64");
const permsB64 = Buffer.from(permsJson).toString("base64");

writeFileSync(
  wbPath,
  `<!doctype html><html><head>
<script id="wb-meta" type="application/json">${JSON.stringify({
    workbook_id: `${ADAPTER}-parity-e2e`,
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

const { token } = await (await fetch(`${DAEMON}/open`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ path: wbPath }),
})).json();
await fetch(`${DAEMON}/wb/${token}/`); // serve to populate session perms
await fetch(`${DAEMON}/wb/${token}/permissions/approve`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: ORIGIN },
  body: JSON.stringify({ ids: ["network"] }),
});
console.log(`[step] session ${token.slice(0, 12)}… opened, network approved`);

const wsUrl = `${DAEMON.replace(/^http/, "ws")}/wb/${token}/agent/${ADAPTER}`;
const ws = new WebSocket(wsUrl, { headers: { Origin: ORIGIN } });

let initSeen = false;
let initPayload = null;
let pngFrame = null;

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
      if (msg.id === 1 && msg.result) {
        initSeen = true;
        initPayload = msg.result;
      }
      if (msg.method === "_relay/file-changed" && msg.params?.path === "render-001.png") {
        pngFrame = msg.params;
      }
    } catch {}
  }
});

const dl = Date.now() + 30_000;
while (!initSeen && Date.now() < dl) await new Promise((r) => setTimeout(r, 200));
if (!initSeen) { ws.close(); fail(`${ADAPTER} never initialized`); }
console.log(`[step] adapter ready: ${initPayload?.agentInfo?.name} v${initPayload?.agentInfo?.version}`);

// 1. wb-fetch installed in scratch
const scratch = join(homedir(), "Library/Caches/sh.workbooks.workbooksd/sessions", token);
const wbFetchPath = join(scratch, ".bin/wb-fetch");
if (!existsSync(wbFetchPath)) { ws.close(); fail("wb-fetch not installed"); }
console.log("[step] 1. wb-fetch installed");

// 2. wb-fetch round-trip works via the daemon's /proxy
const fetchRes = spawnSync(wbFetchPath, [
  "--url", "https://example.com",
  "--method", "GET",
], {
  env: { ...process.env, WORKBOOKS_DAEMON_URL: DAEMON, WORKBOOKS_TOKEN: token },
  encoding: "utf8",
  timeout: 15_000,
});
if (fetchRes.status !== 0 || !(fetchRes.stdout ?? "").includes("Example Domain")) {
  ws.close();
  fail(`wb-fetch round-trip failed: status=${fetchRes.status} stderr=${(fetchRes.stderr || "").slice(0, 200)}`);
}
console.log("[step] 2. wb-fetch round-trip ok");

// 3. Binary asset round-trip — same PNG drop as the claude test
mkdirSync(scratch, { recursive: true });
writeFileSync(join(scratch, "render-001.png"), PNG);
const dl2 = Date.now() + 5000;
while (!pngFrame && Date.now() < dl2) await new Promise((r) => setTimeout(r, 100));
ws.close();
if (!pngFrame) fail("PNG drop produced no binary file-changed frame");
if (pngFrame.binary !== true) fail(`expected binary:true, got ${pngFrame.binary}`);
if (pngFrame.mime !== "image/png") fail(`expected mime image/png, got ${pngFrame.mime}`);
const decoded = Buffer.from(pngFrame.content_b64, "base64");
if (decoded.length !== PNG.length) fail(`size mismatch: ${decoded.length} vs ${PNG.length}`);
for (let i = 0; i < PNG.length; i++) {
  if (decoded[i] !== PNG[i]) fail(`byte ${i} mismatch`);
}
console.log("[step] 3. binary round-trip ok (byte-identical)");

pass(`${ADAPTER} parity confirmed across wb-fetch + asset round-trip + permission-gated /proxy`);
