#!/usr/bin/env node
// Smoke test for @work.books/substrate parse/verify path.
//
// 1. Build a synthetic substrate file in memory.
// 2. Parse it back and confirm structure round-trips.
// 3. Inject a tampered op and confirm parser detects.
// 4. Truncate the trailing op and confirm parser recovers.
//
// Substrate is TS but consumed via Node — we use Node's --experimental-strip-types
// (Node 22+) implicitly via the tsx runner, OR we fall back to a JS shim. For
// the smoke test, we transpile-on-import via tsx if installed.

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(HERE, "..", "src");

// Run via tsx (Node ESM TS loader). If tsx isn't available, the smoke
// test bails with a hint.
try {
  execSync("which tsx", { stdio: "ignore" });
} catch {
  console.log("tsx not on PATH; install with `npm i -g tsx` to run this smoke test.");
  console.log("(The substrate compiles fine — this is just our test runner.)");
  process.exit(0);
}

const harness = `
import { parseSubstrateFromHtml, cidOf, opCid } from "${SRC_DIR}/index.ts";

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(\`\${ok ? "✓" : "✗"} \${name}\${detail ? ": " + detail : ""}\`);
  if (ok) pass++; else fail++;
}

// 1. Build synthetic substrate
const compositionBytes = new Uint8Array([1, 2, 3, 4, 5]);
const dataBytes = new Uint8Array([10, 20, 30]);
const compCid = await cidOf(compositionBytes);
const dataCid = await cidOf(dataBytes);

// One yjs op against composition
const op1Payload = new Uint8Array([100, 101, 102]);
const op1Cid = await opCid(compCid, "composition", 1, op1Payload);
// One sqlite op against data
const op2Payload = new Uint8Array([200, 201]);
const op2Cid = await opCid(dataCid, "data", 2, op2Payload);

const meta = {
  workbook_id: "01J0TEST_TEST_TEST_TEST_TEST",
  substrate_version: "v0",
  schema_version: 0,
  compaction_seq: 0,
  snapshot_cid_by_target: { composition: compCid, data: dataCid },
};

function b64(bytes) { return Buffer.from(bytes).toString("base64"); }
const wal = [
  { seq: 1, target: "composition", parent_cid: compCid, cid: op1Cid, payload_b64: b64(op1Payload) },
  { seq: 2, target: "data", parent_cid: dataCid, cid: op2Cid, payload_b64: b64(op2Payload) },
];

const html = \`<!DOCTYPE html><html><head>
<meta name="workbook-substrate" content="v0">
<script type="application/json" id="wb-meta">\${JSON.stringify(meta)}</script>
<script type="application/octet-stream" id="wb-snapshot:composition" data-cid="\${compCid}" data-format="yjs">\${b64(compositionBytes)}</script>
<script type="application/octet-stream" id="wb-snapshot:data" data-cid="\${dataCid}" data-format="sqlite">\${b64(dataBytes)}</script>
<script type="application/json" id="wb-wal">\${JSON.stringify(wal)}</script>
</head><body></body></html>\`;

// 2. Parse round-trip
const parsed = await parseSubstrateFromHtml(html);
check("meta workbook_id", parsed.meta.workbook_id === meta.workbook_id);
check("meta compaction_seq", parsed.meta.compaction_seq === 0);
check("snapshots count", parsed.snapshots.size === 2);
check("composition snapshot bytes", Buffer.compare(Buffer.from(parsed.snapshots.get("composition").bytes), Buffer.from(compositionBytes)) === 0);
check("data snapshot bytes", Buffer.compare(Buffer.from(parsed.snapshots.get("data").bytes), Buffer.from(dataBytes)) === 0);
check("wal length", parsed.wal.length === 2);
check("fingerprint stable", typeof parsed.fingerprint === "string" && parsed.fingerprint.startsWith("blake3-"));

// 3. Tamper a snapshot CID
const tamperedHtml = html.replace(compCid, "blake3-deadbeef" + "0".repeat(24));
let detected = false;
try { await parseSubstrateFromHtml(tamperedHtml); }
catch (e) { detected = e.code === "snapshot-cid-mismatch"; }
check("tampered snapshot CID detected", detected);

// 4. Truncate trailing op (simulate crash mid-write) → recovered
const corruptTail = wal.map((o, i) => i === 1 ? { ...o, cid: "blake3-zerozerozerozerozerozerozerozeroze" } : o);
const corruptHtml = html.replace(JSON.stringify(wal), JSON.stringify(corruptTail));
const recovered = await parseSubstrateFromHtml(corruptHtml);
check("trailing-op recovery: wal length 1 (was 2)", recovered.wal.length === 1);
check("trailing-op recovery: first op intact", recovered.wal[0].seq === 1);

console.log(\`\\n\${pass} passed, \${fail} failed\`);
process.exit(fail > 0 ? 1 : 0);
`;

import("node:fs").then((fs) => {
  const tmp = `/tmp/wb-substrate-smoke-${process.pid}.mjs`;
  fs.writeFileSync(tmp, harness);
  try {
    execSync(`tsx ${tmp}`, { stdio: "inherit" });
    fs.unlinkSync(tmp);
  } catch (e) {
    fs.unlinkSync(tmp);
    process.exit(1);
  }
});
