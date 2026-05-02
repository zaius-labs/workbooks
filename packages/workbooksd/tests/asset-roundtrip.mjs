#!/usr/bin/env bun
// E2E test for core-5ah.6 — agent → workbook asset round-trip.
//
// Drives a real daemon + a real ACP adapter (claude). Opens a
// session, waits for the adapter to spawn (which kicks off the
// notify-rs watcher), drops a PNG into the per-session scratch
// dir, and asserts the daemon emits a `_relay/file-changed`
// frame with `binary: true`, valid base64 content, and a
// PNG mime guess. Skips if `claude` isn't on PATH.
//
// Real usage we're modeling: claude / codex run a tool that
// produces a PNG (e.g. fal.ai img2img) and writes it into cwd.
// The watcher wakes up, the daemon serializes the bytes as a
// binary file-changed frame, the browser routes that into the
// asset store. This test exercises the daemon side end-to-end;
// the browser-side handling is verified separately by the
// colorwave build (the `assets.addFromFile(File)` path is
// already covered by the existing assets unit tests).

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { which } from "bun";

const DAEMON = "http://127.0.0.1:47119";
const ORIGIN = DAEMON;

if (!which("claude")) {
  console.log("[skip] claude CLI not on PATH; this E2E needs an ACP adapter to spawn the watcher");
  process.exit(0);
}

// 4-byte PNG signature + minimal IHDR. Real bytes the watcher
// will read; UTF-8 decode fails, hence the binary path triggers.
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const tmp = mkdtempSync(join(tmpdir(), "workbooks-asset-roundtrip-"));
const wbPath = join(tmp, "test.workbook.html");
writeFileSync(
  wbPath,
  `<!doctype html><html><head>
<script id="wb-meta" type="application/json">${JSON.stringify({
    workbook_id: "asset-roundtrip-e2e",
    compaction_seq: 0,
    snapshot_cid_by_target: {},
  })}</script>
</head><body></body></html>`,
);

const failExit = (msg) => {
  console.error(`[fail] ${msg}`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
};

const passExit = (msg) => {
  console.log(`[pass] ${msg}`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
};

// 1. /open — get a token bound to our test workbook.
const openRes = await fetch(`${DAEMON}/open`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ path: wbPath }),
});
if (!openRes.ok) failExit(`/open: HTTP ${openRes.status}`);
const { token } = await openRes.json();
console.log(`[step] opened session ${token.slice(0, 12)}…`);

// 2. WS to /wb/:token/agent/claude. The daemon will spawn the
//    claude adapter; once spawned, the file-watcher in the same
//    handler starts emitting on writes inside the scratch dir.
const wsUrl = `${DAEMON.replace(/^http/, "ws")}/wb/${token}/agent/claude`;
const ws = new WebSocket(wsUrl, {
  headers: { Origin: ORIGIN },
});

let initSeen = false;
let fileChanged = null;

ws.addEventListener("open", () => {
  console.log("[step] websocket open; sending ACP initialize");
  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    }) + "\n",
  );
});

ws.addEventListener("message", (ev) => {
  const text = typeof ev.data === "string" ? ev.data : "";
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 1 && msg.result) {
      initSeen = true;
      console.log(`[step] adapter ready: ${msg.result.agentInfo?.name} v${msg.result.agentInfo?.version}`);
      // Drop the binary asset NOW — watcher is up.
      const scratch = join(
        homedir(),
        "Library/Caches/sh.workbooks.workbooksd/sessions",
        token,
      );
      mkdirSync(scratch, { recursive: true });
      const target = join(scratch, "render-001.png");
      writeFileSync(target, PNG_BYTES);
      console.log(`[step] dropped ${PNG_BYTES.length}-byte PNG at ${target.replace(homedir(), "~")}`);
    } else if (msg.method === "_relay/file-changed") {
      const p = msg.params ?? {};
      if (p.path === "render-001.png") {
        fileChanged = p;
      }
    }
  }
});

ws.addEventListener("error", (e) => {
  console.error(`[ws-error] ${e.message ?? e}`);
});

// Wait up to 30s for the round-trip (adapter cold-spawn can be
// slow on first run when npm has to fetch the shim).
const deadline = Date.now() + 30_000;
while (!fileChanged && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 250));
}

ws.close();

if (!initSeen) failExit("adapter never initialized");
if (!fileChanged) failExit("no _relay/file-changed for render-001.png within 30s");

// Assertions on the binary frame shape.
if (fileChanged.binary !== true) failExit(`expected binary:true, got binary:${fileChanged.binary}`);
if (typeof fileChanged.content_b64 !== "string" || !fileChanged.content_b64.length) failExit("content_b64 missing or empty");
if (fileChanged.mime !== "image/png") failExit(`expected mime image/png, got ${fileChanged.mime}`);
if (fileChanged.size !== PNG_BYTES.length) failExit(`expected size ${PNG_BYTES.length}, got ${fileChanged.size}`);

// Decode and compare bytes.
const decoded = Buffer.from(fileChanged.content_b64, "base64");
if (decoded.length !== PNG_BYTES.length) failExit(`decoded length mismatch: ${decoded.length} vs ${PNG_BYTES.length}`);
for (let i = 0; i < PNG_BYTES.length; i++) {
  if (decoded[i] !== PNG_BYTES[i]) failExit(`byte ${i} mismatch: 0x${decoded[i].toString(16)} vs 0x${PNG_BYTES[i].toString(16)}`);
}

passExit(
  `binary file-change frame round-tripped: path=${fileChanged.path} mime=${fileChanged.mime} size=${fileChanged.size} bytes match`,
);
