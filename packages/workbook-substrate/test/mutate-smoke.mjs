#!/usr/bin/env node
// Smoke test for the substrate mutate API + WAL emitter.

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(HERE, "..", "src");

const harness = `
import { parseSubstrateFromHtml, createMutator, cidOf, opCid } from "${SRC_DIR}/index.ts";

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(\`\${ok ? "✓" : "✗"} \${name}\${detail ? ": " + detail : ""}\`);
  if (ok) pass++; else fail++;
}

// Build a minimal substrate with a 'composition' snapshot, no WAL.
const compBytes = new Uint8Array([1, 2, 3]);
const compCid = await cidOf(compBytes);
const meta = {
  workbook_id: "01J0MUTATE_TEST",
  substrate_version: "v0",
  schema_version: 0,
  compaction_seq: 0,
  snapshot_cid_by_target: { composition: compCid },
};
function b64(bytes) { return Buffer.from(bytes).toString("base64"); }
const html = \`<!DOCTYPE html><html><head>
<script type="application/json" id="wb-meta">\${JSON.stringify(meta)}</script>
<script type="application/octet-stream" id="wb-snapshot:composition" data-cid="\${compCid}" data-format="yjs">\${b64(compBytes)}</script>
<script type="application/json" id="wb-wal">[]</script>
</head><body></body></html>\`;

const file = await parseSubstrateFromHtml(html);
const m = createMutator(file);
check("starting nextSeq=1 (empty WAL)", m.peekNextSeq() === 1);

// Commit two ops
const op1Payload = new Uint8Array([10, 20, 30]);
const op1 = await m.commit("composition", op1Payload);
check("commit 1 returns op", op1.seq === 1);
check("commit 1 parent_cid is snapshot CID", op1.parent_cid === compCid);
check("commit 1 cid recomputable", op1.cid === await opCid(compCid, "composition", 1, op1Payload));
check("WAL has 1 op after first commit", m.file.wal.length === 1);

const op2Payload = new Uint8Array([40, 50]);
const op2 = await m.commit("composition", op2Payload);
check("commit 2 seq monotonic", op2.seq === 2);
check("commit 2 parent_cid = op1.cid", op2.parent_cid === op1.cid);
check("WAL has 2 ops", m.file.wal.length === 2);

// Listener fires
let captured = [];
const unsub = m.onCommit((op) => captured.push(op));
const op3Payload = new Uint8Array([60]);
const op3 = await m.commit("composition", op3Payload);
check("onCommit listener fires", captured.length === 1 && captured[0].seq === 3);
unsub();
const op4Payload = new Uint8Array([70]);
await m.commit("composition", op4Payload);
check("onCommit unsubscribe works", captured.length === 1);

// New target — first op uses zero-CID parent
const op5Payload = new Uint8Array([80]);
const op5 = await m.commit("metadata", op5Payload);
check("new-target first op uses sentinel parent",
  op5.parent_cid === "blake3-" + "0".repeat(32));

console.log(\`\\n\${pass} passed, \${fail} failed\`);
process.exit(fail > 0 ? 1 : 0);
`;

const tmp = `/tmp/wb-substrate-mutate-${process.pid}.mjs`;
writeFileSync(tmp, harness);
try {
  execSync(`tsx ${tmp}`, { stdio: "inherit", env: { ...process.env, PATH: `/tmp/wb-spike-deps/node_modules/.bin:${process.env.PATH}` } });
  unlinkSync(tmp);
} catch (e) {
  unlinkSync(tmp);
  process.exit(1);
}
