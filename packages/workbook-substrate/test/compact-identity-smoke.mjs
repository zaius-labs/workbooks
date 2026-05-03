#!/usr/bin/env node
// Smoke test for compactor + identity guard.

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(HERE, "..", "src");

const harness = `
import {
  parseSubstrateFromHtml, createMutator, compact, shouldCompact,
  cidOf, opCid,
  identityKeyOf, MemoryIdentityStore, migrateIdentity, gcOrphans,
} from "${SRC_DIR}/index.ts";

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(\`\${ok ? "✓" : "✗"} \${name}\${detail ? ": " + detail : ""}\`);
  if (ok) pass++; else fail++;
}

// Build a substrate with snapshot + 3 WAL ops on "composition"
const compBytes = new Uint8Array([1, 2, 3]);
const compCid = await cidOf(compBytes);
const meta = {
  workbook_id: "01J0COMPACT_TEST",
  substrate_version: "v0",
  schema_version: 0,
  compaction_seq: 0,
  snapshot_cid_by_target: { composition: compCid },
};
function b64(b) { return Buffer.from(b).toString("base64"); }
const html0 = \`<!DOCTYPE html><html><head>
<script type="application/json" id="wb-meta">\${JSON.stringify(meta)}</script>
<script type="application/octet-stream" id="wb-snapshot:composition" data-cid="\${compCid}" data-format="yjs">\${b64(compBytes)}</script>
<script type="application/json" id="wb-wal">[]</script>
</head></html>\`;

const file0 = await parseSubstrateFromHtml(html0);
const m = createMutator(file0);

// Seed 3 ops
await m.commit("composition", new Uint8Array([10, 11]));
await m.commit("composition", new Uint8Array([20, 21, 22]));
await m.commit("composition", new Uint8Array([30]));

check("WAL has 3 ops pre-compaction", m.file.wal.length === 3);

// shouldCompact at 3 ops + small snapshot — wal bytes (6) > snapshot bytes * 0.2 (0.6) so YES
check("shouldCompact triggers when WAL grows past threshold", shouldCompact(m.file));

// Compact: encoder produces a new "snapshot bytes" deterministic from
// the inputs. Real runtime uses Y.encodeStateAsUpdateV2 / sqlite_serialize.
const compacted = await compact(m.file, {
  encode: async (target, snap, ops) => {
    // Deterministic merge: concat snap + each op payload
    const total = (snap?.bytes.length ?? 0) + ops.reduce((s, o) => s + o.payload.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    if (snap) { out.set(snap.bytes, o); o += snap.bytes.length; }
    for (const op of ops) { out.set(op.payload, o); o += op.payload.length; }
    return out;
  },
});

check("compact bumps compaction_seq", compacted.meta.compaction_seq === 1);
check("compact clears WAL", compacted.wal.length === 0);
check("compact has snapshot for 'composition'", compacted.snapshots.has("composition"));
check("compact's snapshot CID is in meta",
  compacted.meta.snapshot_cid_by_target.composition === compacted.snapshots.get("composition").cid);
check("fingerprint changed after compaction",
  compacted.fingerprint !== file0.fingerprint);

// Mutator can swap to compacted state
m.replaceFile(compacted);
check("mutator post-replaceFile WAL is empty", m.file.wal.length === 0);
check("mutator nextSeq starts at 1 again", m.peekNextSeq() === 1);

// Identity guard
const store = new MemoryIdentityStore();
const k0 = identityKeyOf(file0);
const k1 = identityKeyOf(compacted);

await store.set(k0, { handle: "old-handle" });
check("store has 1 entry post-set", store.size() === 1);

await migrateIdentity(store, k0, k1);
check("migrate: old key gone", await store.get(k0) === undefined);
check("migrate: new key holds value", (await store.get(k1))?.handle === "old-handle");
check("store still has 1 entry", store.size() === 1);

// Orphan GC
await store.set({ workbook_id: "STRANGER", fingerprint: "blake3-aaaa00000000000000000000000000aa" }, { handle: "orphan" });
check("store has 2 entries", store.size() === 2);

const deleted = await gcOrphans(store, new Set(["01J0COMPACT_TEST"]));
check("gcOrphans deletes 1", deleted === 1);
check("store back to 1", store.size() === 1);

console.log(\`\\n\${pass} passed, \${fail} failed\`);
process.exit(fail > 0 ? 1 : 0);
`;

const tmp = `/tmp/wb-substrate-compact-${process.pid}.mjs`;
writeFileSync(tmp, harness);
try {
  execSync(`tsx ${tmp}`, { stdio: "inherit", env: { ...process.env, PATH: `/tmp/wb-spike-deps/node_modules/.bin:${process.env.PATH}` } });
  unlinkSync(tmp);
} catch (e) {
  unlinkSync(tmp);
  process.exit(1);
}
