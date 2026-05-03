#!/usr/bin/env bun
// E2E for core-5ah.8 — re-seed echo suppression.
//
// Scenario being prevented:
//   1. Browser pre-seeds composition.html before each prompt.
//   2. Watcher fires for the daemon's own write.
//   3. Browser receives _relay/file-changed and re-applies the
//      same value to the composition store.
//   4. iframe player rebuilds visibly — a flicker the user sees.
//
// What this test asserts:
//
//   A. Files written by the daemon via /agent/seed do NOT trigger
//      file-changed frames within ~SEED_ECHO_WINDOW_MS (1s).
//   B. Files written DIRECTLY into scratch (i.e. by the agent's
//      Bash tool) DO trigger file-changed frames — the
//      suppression is targeted, not blanket.
//   C. After the echo window expires, a fresh write to the same
//      path goes through normally.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { which } from "bun";

import { daemonUrl } from "./_runtime.mjs";
const DAEMON = daemonUrl();
const ORIGIN = DAEMON;

if (!which("claude")) {
  console.log("[skip] claude not on PATH; this E2E needs an adapter to spawn the watcher");
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), "workbooks-seed-echo-"));
const wbPath = join(tmp, "test.workbook.html");
writeFileSync(
  wbPath,
  `<!doctype html><html><head>
<script id="wb-meta" type="application/json">${JSON.stringify({
    workbook_id: "seed-echo-e2e",
    compaction_seq: 0,
    snapshot_cid_by_target: {},
  })}</script>
</head><body></body></html>`,
);

const cleanup = () => rmSync(tmp, { recursive: true, force: true });
const fail = (msg) => { console.error(`[fail] ${msg}`); cleanup(); process.exit(1); };
const pass = (msg) => { console.log(`[pass] ${msg}`); cleanup(); process.exit(0); };

const { token } = await (await fetch(`${DAEMON}/open`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ path: wbPath }),
})).json();
console.log(`[step] opened session ${token.slice(0, 12)}…`);

const wsUrl = `${DAEMON.replace(/^http/, "ws")}/wb/${token}/agent/claude`;
const ws = new WebSocket(wsUrl, { headers: { Origin: ORIGIN } });

/** @type {Array<{ts:number, path:string}>} */
const fileChanges = [];
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
      if (msg.method === "_relay/file-changed") {
        fileChanges.push({ ts: Date.now(), path: msg.params?.path });
      }
    } catch {}
  }
});

const initDl = Date.now() + 25_000;
while (!initSeen && Date.now() < initDl) await new Promise((r) => setTimeout(r, 200));
if (!initSeen) { ws.close(); fail("adapter never initialized"); }
console.log("[step] adapter ready, watcher running");

// Wait for any startup churn (the adapter may touch a few files
// during init) to settle before running our assertions.
await new Promise((r) => setTimeout(r, 500));
const baseline = fileChanges.length;
console.log(`[step] startup churn: ${baseline} file-changes, baseline locked`);

// A. Seed a file via the daemon endpoint. Watcher should NOT
//    surface it because it was just written by the daemon.
const seedRes = await fetch(`${DAEMON}/wb/${token}/agent/seed`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: ORIGIN },
  body: JSON.stringify({
    files: { "composition.html": "<!doctype html><html><body>seeded</body></html>" },
  }),
});
if (!seedRes.ok) { ws.close(); fail(`/agent/seed: HTTP ${seedRes.status}`); }
// Wait through the echo window to confirm no notification fires.
await new Promise((r) => setTimeout(r, 800));
const afterSeed = fileChanges.length;
const seedEchoes = fileChanges.slice(baseline).filter((c) => c.path === "composition.html");
if (seedEchoes.length > 0) {
  ws.close();
  fail(`expected 0 file-changes for seeded path within echo window; got ${seedEchoes.length}: ${JSON.stringify(seedEchoes)}`);
}
console.log("[step] A ok — seed write produced no echo frame");

// B. Write directly to scratch, simulating the agent's Bash
//    tool dropping a file. This is NOT a daemon write, so it
//    must surface as a file-changed.
const scratch = join(homedir(), "Library/Caches/sh.workbooks.workbooksd/sessions", token);
const agentFile = join(scratch, "agent-output.txt");
writeFileSync(agentFile, "the agent wrote this");
let appearsAfter = afterSeed;
const dlB = Date.now() + 3000;
while (Date.now() < dlB) {
  await new Promise((r) => setTimeout(r, 100));
  if (fileChanges.some((c) => c.ts > 0 && c.path === "agent-output.txt")) {
    appearsAfter = fileChanges.length;
    break;
  }
}
if (!fileChanges.some((c) => c.path === "agent-output.txt")) {
  ws.close();
  fail("agent-direct write did NOT produce a file-changed frame");
}
console.log("[step] B ok — agent-direct write surfaced normally");

// C. After the echo window expires, re-seed the same path. Wait
//    through the window first, then verify the frame fires this
//    time (the marker has expired).
await new Promise((r) => setTimeout(r, 1100));
fileChanges.length = appearsAfter; // truncate so we only count from here

// Bypass /agent/seed and write directly — equivalent to the
// agent doing it. We're testing that nothing's stuck in the
// suppression map after the window passes.
writeFileSync(join(scratch, "composition.html"), "<!doctype html><html><body>v2</body></html>");
let cFrame = false;
const dlC = Date.now() + 3000;
while (Date.now() < dlC) {
  await new Promise((r) => setTimeout(r, 100));
  if (fileChanges.some((c) => c.path === "composition.html")) {
    cFrame = true;
    break;
  }
}
ws.close();
if (!cFrame) fail("post-window write to composition.html did NOT surface");
console.log("[step] C ok — suppression window expired correctly");

pass("seed-echo suppression: daemon's own writes silenced, agent-direct writes still surface");
