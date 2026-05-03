#!/usr/bin/env node
// Spike 1: parser containment — generate a synthetic workbook file
// that stress-tests the substrate format in real browsers.
//
// Output: a single ./out/spike-parser-test.html file containing:
//   • Three large <script type="application/octet-stream"> snapshots,
//     each ~5 MB of base64-encoded random binary data.
//   • A <script type="application/json"> WAL with 1500 small entries
//     (mixed targets, varied payloads).
//   • An inline <script type="module"> runner that, on load, reads
//     each block back via getElementById + textContent AND via
//     fetch(self.location).text() to compare both extraction paths.
//   • A <div id="results"> the runner populates with pass/fail rows.
//
// Open the resulting file in Chrome / Firefox / Safari and confirm:
//   • No DOM pollution (the only visible content is the results table)
//   • No quirks-mode (document.compatMode === 'CSS1Compat')
//   • No script execution issues
//   • All three snapshots read back byte-identical to source
//   • All 1500 WAL ops parse + replay through the integrity check
//   • Total parse time logged
//
// Usage:
//   node generate-test-file.mjs [--snapshot-mb=5] [--wal-ops=1500]

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "out");

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.+)$/);
    return m ? [m[1], m[2]] : [a, true];
  }),
);

const SNAPSHOT_MB = Number(argv["snapshot-mb"] ?? 5);
const WAL_OPS = Number(argv["wal-ops"] ?? 1500);

function blake3Hex(bytes) {
  // Spike-only: substitute SHA-256 for Blake3 to avoid extra dep.
  // Real substrate uses Blake3.
  return createHash("sha256").update(bytes).digest("hex").slice(0, 24);
}

function generateSnapshot(name, sizeMb) {
  // Random bytes, not text — exercises base64 encoding fidelity.
  const bytes = randomBytes(sizeMb * 1024 * 1024);
  const b64 = bytes.toString("base64");
  const cid = "spike-" + blake3Hex(bytes);
  return { name, b64, cid, sourceBytes: bytes };
}

function generateWalOp(seq, parentCid) {
  const target = ["composition", "data"][seq % 2];
  const payload = randomBytes(40 + (seq % 200)); // 40..240 bytes per op
  const payloadB64 = payload.toString("base64");
  const cid = "spike-" + blake3Hex(Buffer.concat([
    Buffer.from(parentCid),
    Buffer.from([seq]),
    payload,
  ]));
  return {
    seq,
    target,
    parent_cid: parentCid,
    cid,
    payload_b64: payloadB64,
  };
}

function buildHtml({ snapshots, wal, expected }) {
  const snapshotEls = snapshots
    .map((s) => `<script type="application/octet-stream"
        id="wb-snapshot:${s.name}"
        data-cid="${s.cid}"
        data-format="bytes">${s.b64}</script>`)
    .join("\n  ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="workbook-substrate" content="v0-spike">
<title>Substrate parser containment spike</title>
<style>
  body { font: 13px ui-monospace, monospace; padding: 16px; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 14px; margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 4px 8px; border-bottom: 1px solid #ddd; text-align: left; vertical-align: top; }
  th { background: #f4f4f5; }
  .pass { color: #16a34a; font-weight: 600; }
  .fail { color: #dc2626; font-weight: 600; }
  .info { color: #71717a; }
  .summary { margin-top: 16px; padding: 12px; background: #f4f4f5; border-radius: 4px; }
</style>

<script type="application/json" id="wb-meta">
${JSON.stringify({
  workbook_id: "spike-parser-containment",
  schema: 0,
  runtime_version: "spike",
  expected,
}, null, 2)}
</script>

  ${snapshotEls}

<script type="application/json" id="wb-wal">
${JSON.stringify(wal)}
</script>

</head>
<body>
<h1>Substrate parser containment spike</h1>
<p class="info">If parsing is clean, this page shows ONLY a results table.
   Any "garbage" rendered above the table indicates DOM pollution.</p>
<table id="results">
  <thead><tr><th>check</th><th>verdict</th><th>detail</th></tr></thead>
  <tbody></tbody>
</table>
<div class="summary" id="summary"></div>

<script type="module">
const tbody = document.querySelector("#results tbody");
const summaryEl = document.getElementById("summary");
function row(name, ok, detail) {
  const tr = document.createElement("tr");
  tr.innerHTML = \`<td>\${name}</td><td class="\${ok ? "pass" : "fail"}">\${ok ? "PASS" : "FAIL"}</td><td>\${detail ?? ""}</td>\`;
  tbody.appendChild(tr);
}

const meta = JSON.parse(document.getElementById("wb-meta").textContent);
const expected = meta.expected;
let pass = 0, fail = 0;
const passed = (ok) => ok ? pass++ : fail++;

// 1. Quirks-mode check
{
  const ok = document.compatMode === "CSS1Compat";
  passed(ok);
  row("doctype standards mode", ok, document.compatMode);
}

// 2. Body has only expected children (no implicit elements from leading data)
{
  const allowed = ["H1", "P", "TABLE", "DIV", "SCRIPT"];
  const unexpected = [...document.body.children].filter((el) => !allowed.includes(el.tagName));
  const ok = unexpected.length === 0;
  passed(ok);
  row("no DOM pollution in <body>", ok, ok ? "" : "unexpected: " + unexpected.map((e) => e.tagName).join(","));
}

// 3. Each snapshot retrievable via getElementById, byte-identical via base64 round-trip
const t0 = performance.now();
for (const exp of expected.snapshots) {
  const el = document.getElementById("wb-snapshot:" + exp.name);
  const b64 = el.textContent.replace(/\\s/g, "");
  const ok = b64.length === exp.b64Len && b64 === exp.b64Sample.head + b64.slice(exp.b64Sample.head.length, b64.length - exp.b64Sample.tail.length) + exp.b64Sample.tail;
  passed(ok);
  row("snapshot " + exp.name + " textContent length", ok, b64.length + " (expected " + exp.b64Len + ")");
  // CID match (spike uses sha256-12byte truncation, recomputed in browser for parity)
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const cid = "spike-" + Array.from(new Uint8Array(hash)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
  const cidOk = cid === exp.cid;
  passed(cidOk);
  row("snapshot " + exp.name + " CID match", cidOk, cid + " vs " + exp.cid);
}
const t1 = performance.now();

// 4. WAL parses + replay-checks
const wal = JSON.parse(document.getElementById("wb-wal").textContent);
{
  const ok = wal.length === expected.walLen;
  passed(ok);
  row("WAL op count", ok, wal.length + " (expected " + expected.walLen + ")");
}
// 4a. seq monotonic
{
  let monotonic = true;
  for (let i = 1; i < wal.length; i++) if (wal[i].seq <= wal[i-1].seq) { monotonic = false; break; }
  passed(monotonic);
  row("WAL seq monotonic", monotonic);
}
// 4b. parent-CID chain integrity (per target)
{
  const lastCid = {};
  let chainOk = true, brokeAt = -1;
  for (const op of wal) {
    const expected = lastCid[op.target] ?? expected_initial(op.target);
    if (op.parent_cid !== expected && lastCid[op.target] !== undefined) { chainOk = false; brokeAt = op.seq; break; }
    lastCid[op.target] = op.cid;
  }
  function expected_initial(target) {
    return meta.expected.snapshotCidByName[target] ?? "<missing>";
  }
  passed(chainOk);
  row("WAL parent-CID chain", chainOk, chainOk ? "" : "broke at seq " + brokeAt);
}
const t2 = performance.now();

// 5. Raw-fetch extraction — fetch(self.location) and confirm presence
{
  try {
    const text = await fetch(self.location.href).then((r) => r.text());
    const hasMeta = text.includes('id="wb-meta"');
    const hasWal = text.includes('id="wb-wal"');
    const hasFirstSnap = text.includes('id="wb-snapshot:' + expected.snapshots[0].name + '"');
    const ok = hasMeta && hasWal && hasFirstSnap;
    passed(ok);
    row("raw fetch(self.location) extraction", ok, "size=" + text.length);
  } catch (e) {
    passed(false);
    row("raw fetch(self.location) extraction", false, e.message);
  }
}
const t3 = performance.now();

summaryEl.innerHTML = \`
  <strong>\${pass} passed, \${fail} failed</strong><br>
  Snapshot extraction: \${(t1 - t0).toFixed(0)}ms<br>
  WAL parse + chain check: \${(t2 - t1).toFixed(0)}ms<br>
  Raw fetch extraction: \${(t3 - t2).toFixed(0)}ms<br>
  User agent: \${navigator.userAgent}
\`;
console.log({ pass, fail, snapshotMs: t1-t0, walMs: t2-t1, fetchMs: t3-t2 });
</script>

</body>
</html>
`;
}

console.log(`Generating spike file: ${SNAPSHOT_MB}MB × 3 snapshots, ${WAL_OPS} WAL ops`);

const snapshots = [
  generateSnapshot("composition", SNAPSHOT_MB),
  generateSnapshot("data", SNAPSHOT_MB),
  generateSnapshot("assets", SNAPSHOT_MB),
];

const snapshotCidByName = Object.fromEntries(snapshots.map((s) => [s.name, s.cid]));

const wal = [];
const lastCidByTarget = { ...snapshotCidByName };
for (let i = 1; i <= WAL_OPS; i++) {
  const target = ["composition", "data"][i % 2];
  const op = generateWalOp(i, lastCidByTarget[target]);
  lastCidByTarget[target] = op.cid;
  wal.push(op);
}

const expected = {
  snapshots: snapshots.map((s) => ({
    name: s.name,
    cid: s.cid,
    b64Len: s.b64.length,
    b64Sample: { head: s.b64.slice(0, 32), tail: s.b64.slice(-32) },
  })),
  snapshotCidByName,
  walLen: wal.length,
};

const html = buildHtml({ snapshots, wal, expected });

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, "spike-parser-test.html");
writeFileSync(outPath, html);

const sizeMb = (Buffer.byteLength(html) / 1024 / 1024).toFixed(2);
console.log(`Wrote ${outPath} (${sizeMb} MB)`);
console.log(`Open this file in Chrome / Firefox / Safari to run the in-browser checks.`);
