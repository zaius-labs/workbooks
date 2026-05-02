#!/usr/bin/env bun
// Generate a real test fixture for the portal viewer at
// workbooks.sh/inspect: a saved workbook with an edit log
// chain (multiple agents) AND a c2pa sidecar. The user opens
// the inspect page locally and drops both files to validate
// the page renders correctly end-to-end.
//
// Run with:
//   bun run vendor/workbooks/packages/workbooksd/tests/portal-fixture.mjs
//
// Outputs paths to the generated fixture pair.

import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";

const DAEMON = "http://127.0.0.1:47119";
const ORIGIN = DAEMON;
const FIXTURE_DIR = process.env.FIXTURE_DIR ??
  mkdtempSync(join(tmpdir(), "workbooks-portal-fixture-"));
const wbPath = join(FIXTURE_DIR, "demo.workbook.html");
const sidecarPath = `${wbPath}.c2pa`;

const policyB64 = Buffer.from(JSON.stringify({})).toString("base64");
const permsB64 = Buffer.from(JSON.stringify({
  c2pa: { reason: "sign saves with content credentials" },
})).toString("base64");

function wbHtml(seq) {
  return `<!doctype html><html><head>
<meta charset="utf-8" />
<title>Demo workbook · portal fixture</title>
<script id="wb-meta" type="application/json">${JSON.stringify({
    workbook_id: "portal-demo-2026-05",
    compaction_seq: seq,
    snapshot_cid_by_target: {},
  })}</script>
<meta name="wb-permissions" content="${permsB64}">
</head><body>
<h1>Demo workbook</h1>
<p>This file was saved through workbooksd ${seq} time(s) — the
edit log + sidecar are the artifacts the inspect page reads.</p>
</body></html>`;
}

writeFileSync(wbPath, wbHtml(0));

const { token } = await (await fetch(`${DAEMON}/open`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ path: wbPath }),
})).json();
await fetch(`${DAEMON}/wb/${token}/`);
await fetch(`${DAEMON}/wb/${token}/permissions/approve`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: ORIGIN },
  body: JSON.stringify({ ids: ["c2pa"] }),
});

// Three saves with three different agents to populate the timeline.
async function save(seq, agent) {
  const body = readFileSync(wbPath); // re-read so prior log block is included
  await fetch(`${DAEMON}/wb/${token}/save`, {
    method: "PUT",
    headers: { Origin: ORIGIN, "x-wb-agent": agent },
    body,
  });
  // bump compaction_seq for the next save's body
  writeFileSync(wbPath, readFileSync(wbPath, "utf8")
    .replace(/"compaction_seq":\d+/, `"compaction_seq":${seq + 1}`));
}

await save(0, "human");
await save(1, "claude");
await save(2, "codex");

// Wait briefly for the c2pa sidecar (signed in spawn_blocking).
const dl = Date.now() + 5000;
while (Date.now() < dl) {
  try { statSync(sidecarPath); break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

console.log("\nFixture generated:");
console.log(`  workbook:  ${wbPath}`);
try {
  const sidecarSize = statSync(sidecarPath).size;
  console.log(`  sidecar:   ${sidecarPath}  (${sidecarSize} bytes)`);
} catch {
  console.log(`  sidecar:   (not generated — c2pa permission may not be approved)`);
}
console.log("\nServe the inspect page locally:");
console.log("  cd apps/workbooks-site/dist && python3 -m http.server 8765");
console.log("  open http://localhost:8765/inspect/");
console.log("\nThen drop both files on the dropzone.");
