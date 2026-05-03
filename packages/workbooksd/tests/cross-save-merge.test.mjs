#!/usr/bin/env bun
// E2E for core-5ah.14 — cross-save merge in the portal viewer.
//
// Real-usage scenario: user duplicates a workbook (cp) to a second
// path and edits both copies independently (each daemon-saved
// session writes its own edit-log entry to its own copy). They
// drop both .workbook.html files onto the inspect page. The
// viewer recognizes the shared workbook_id, merges the edit-log
// entries (dedupe by (ts, sha256_after), sort by ts), and surfaces
// fork points where the two copies diverged.
//
// We simulate the user side by:
//   1. Daemon-saving v1 to copyA → edit-log [E1]
//   2. cp copyA → copyB (so copyB starts with edit-log [E1] too)
//   3. Daemon-saving v2 to copyA, agent=human → copyA log [E1, E2a]
//   4. Daemon-saving v2' to copyB, agent=claude → copyB log [E1, E2b]
//   5. Both files now share E1 (common ancestor) and diverge at
//      a fork-point timestamp where their second saves landed.
//
// We then run the same regex-parse + merge logic the inspect page
// runs and assert the merged output:
//   - Total entries: 3 (E1 dedup'd, E2a, E2b separate)
//   - At least one timestamp has > 1 sha (a fork)

import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { daemonUrl } from "./_runtime.mjs";

const DAEMON = daemonUrl();
const ORIGIN = DAEMON;
const fail = (msg) => { console.error(`[fail] ${msg}`); process.exit(1); };
const pass = (msg) => { console.log(`[pass] ${msg}`); process.exit(0); };

const tmp = mkdtempSync(join(tmpdir(), "workbooks-cross-save-"));
const copyA = join(tmp, "v1-a.workbook.html");
const copyB = join(tmp, "v1-b.workbook.html");
const cleanup = () => rmSync(tmp, { recursive: true, force: true });
const exitFail = (msg) => { cleanup(); fail(msg); };
const exitPass = (msg) => { cleanup(); pass(msg); };

function htmlBody(seq, marker) {
  return `<!doctype html><html><head>
<script id="wb-meta" type="application/json">${JSON.stringify({
    workbook_id: "cross-save-e2e",
    compaction_seq: seq,
    snapshot_cid_by_target: {},
  })}</script>
</head><body>${marker}</body></html>`;
}

writeFileSync(copyA, htmlBody(0, "v1"));

// 1. Open + save v1 via the daemon (sets up the first edit log
//    entry E1).
async function openAndSave(path, agent, contentMarker) {
  const { token } = await (await fetch(`${DAEMON}/open`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  })).json();
  const body = readFileSync(path);
  const r = await fetch(`${DAEMON}/wb/${token}/save`, {
    method: "PUT",
    headers: { Origin: ORIGIN, "x-wb-agent": agent },
    body,
  });
  if (!r.ok) throw new Error(`save ${path}: HTTP ${r.status}`);
}

await openAndSave(copyA, "human", "v1");
console.log("[step] copyA saved v1 via daemon (E1 lands in its log)");

// 2. Copy v1 to copyB so they share E1 in their log block. Tiny
//    pause so timestamps would naturally tick on subsequent saves.
copyFileSync(copyA, copyB);
await new Promise((r) => setTimeout(r, 1100));

// In-place edit: read existing HTML (preserves the log block),
// replace the visible body marker, write back. This mirrors what
// a real editor does — daemon's tamper-evident prior-log read
// keeps E1 across this save.
function editMarker(path, fromMarker, toMarker) {
  const cur = readFileSync(path, "utf8");
  const updated = cur.replace(`<body>${fromMarker}</body>`, `<body>${toMarker}</body>`);
  if (updated === cur) throw new Error(`marker ${fromMarker} not found in ${path}`);
  writeFileSync(path, updated);
}

// 3. Diverge copyA: in-place body edit, save through daemon. The
//    daemon reads prior log from disk (which has [E1]) and
//    appends E2a → on-disk log becomes [E1, E2a].
editMarker(copyA, "v1", "v2-from-A");
await openAndSave(copyA, "human", "v2-A");
console.log("[step] copyA forked: v2 saved via human (log: E1, E2a)");

// 4. Diverge copyB the same way: separate body edit + save.
editMarker(copyB, "v1", "v2-from-B");
await openAndSave(copyB, "claude", "v2-B");
console.log("[step] copyB forked: v2' saved via claude (log: E1, E2b)");

// Mirror inspect.js's parse + merge — exact same regex shapes,
// same dedupe key, same fork detection.
function parseEntries(html) {
  const m = html.match(/<script id="wb-edit-log"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  try { return JSON.parse(m[1]); } catch { return []; }
}
function merge(files) {
  const seen = new Map();
  for (const file of files) {
    for (const e of file.entries ?? []) {
      const key = `${e.ts}|${e.sha256_after}`;
      if (!seen.has(key)) {
        seen.set(key, { ...e, _sources: new Set([file.name]) });
      } else {
        seen.get(key)._sources.add(file.name);
      }
    }
  }
  return [...seen.values()].sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
}

const aEntries = parseEntries(readFileSync(copyA, "utf8"));
const bEntries = parseEntries(readFileSync(copyB, "utf8"));
console.log(`[step] copyA has ${aEntries.length} log entries; copyB has ${bEntries.length}`);
if (aEntries.length < 2) exitFail(`copyA expected 2+ entries, got ${aEntries.length}`);
if (bEntries.length < 2) exitFail(`copyB expected 2+ entries, got ${bEntries.length}`);

const merged = merge([
  { name: "v1-a.workbook.html", entries: aEntries },
  { name: "v1-b.workbook.html", entries: bEntries },
]);

// Property 1: shared E1 dedup'd. Both copies start with the same
// (ts, sha) for v1 → exactly one merged entry whose _sources has
// both files.
const sharedV1 = merged.find((e) => (e._sources?.size ?? 0) === 2);
if (!sharedV1) {
  exitFail(
    `expected one merged entry from BOTH files (shared E1); got: ${
      JSON.stringify(merged.map((e) => ({ ts: e.ts, sha: e.sha256_after?.slice(0, 8), n: e._sources?.size })), null, 2)
    }`
  );
}
console.log(`[step] shared v1 entry merged across both files (sources: ${[...sharedV1._sources].join(", ")})`);

// Property 2: total merged entries = 3 (E1 dedup, E2a, E2b).
if (merged.length !== 3) {
  exitFail(`expected 3 merged entries (E1 + 2 forks); got ${merged.length}: ${
    JSON.stringify(merged.map((e) => ({ ts: e.ts, sha: e.sha256_after?.slice(0, 8) })), null, 2)
  }`);
}
console.log(`[step] merged total = 3 (1 shared + 2 forked)`);

// Property 3: at least one fork point — same ts, different sha.
const byTs = new Map();
for (const e of merged) {
  const arr = byTs.get(e.ts) ?? []; arr.push(e); byTs.set(e.ts, arr);
}
const forks = [...byTs.entries()].filter(([_, arr]) => new Set(arr.map((e) => e.sha256_after)).size > 1);
if (forks.length < 1) {
  exitFail(`expected at least one fork (same ts, divergent sha); got 0`);
}
console.log(`[step] ${forks.length} fork point detected at ts=${forks[0][0]}`);

exitPass("cross-save merge: shared ancestor dedup'd, divergent forks surfaced as separate entries");
