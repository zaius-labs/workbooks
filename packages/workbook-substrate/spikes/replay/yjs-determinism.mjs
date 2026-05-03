#!/usr/bin/env node
// Spike 3: yjs replay determinism + integrity chain
//
// Confirms:
//   1. A sequence of yjs updates, when replayed against a fresh Y.Doc,
//      reaches an identical CRDT state regardless of the order in which
//      updates are applied (yjs's defining property — but verifying it
//      against the substrate's WAL framing is the spike's actual ask).
//   2. Substrate's parent-CID chain detects mid-WAL corruption.
//   3. Substrate's trailing-op recovery detects an unsealed last op.
//   4. Compaction (Y.encodeStateAsUpdateV2 from any replay) yields
//      bit-identical bytes given the same in-memory state.
//
// Run from /tmp/wb-spike-deps where yjs is installed:
//   node /path/to/yjs-determinism.mjs

import * as Y from "yjs";
import { createHash } from "node:crypto";

function blake3_32(bytes) {
  // SHA-256 truncated for spike parity (real substrate uses Blake3).
  return "blake3-" + createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

function makeOp({ seq, target, parentCid, payload }) {
  // CID is over (parent_cid || target || seq || payload), matching
  // SUBSTRATE_FORMAT_V0.md §3.
  const seqBytes = Buffer.alloc(8);
  seqBytes.writeBigUInt64BE(BigInt(seq));
  const cid = blake3_32(Buffer.concat([
    Buffer.from(parentCid),
    Buffer.from(target),
    seqBytes,
    Buffer.from(payload),
  ]));
  return { seq, target, parent_cid: parentCid, cid, payload_b64: Buffer.from(payload).toString("base64") };
}

function verifyOp(op) {
  const seqBytes = Buffer.alloc(8);
  seqBytes.writeBigUInt64BE(BigInt(op.seq));
  const payload = Buffer.from(op.payload_b64, "base64");
  const expected = blake3_32(Buffer.concat([
    Buffer.from(op.parent_cid),
    Buffer.from(op.target),
    seqBytes,
    payload,
  ]));
  return expected === op.cid;
}

function verifyChain(snapshotCid, ops, target) {
  let prev = snapshotCid;
  for (const op of ops) {
    if (op.target !== target) continue;
    if (op.parent_cid !== prev) return { ok: false, brokeAt: op.seq };
    if (!verifyOp(op)) return { ok: false, brokeAt: op.seq, kind: "cid-mismatch" };
    prev = op.cid;
  }
  return { ok: true };
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ": " + detail : ""}`);
  if (ok) pass++; else fail++;
}

// ─── Test 1: yjs replay determinism ────────────────────────────
{
  // Generate a sequence of edits on doc A
  const docA = new Y.Doc();
  const textA = docA.getText("composition");
  const mapA = docA.getMap("settings");
  const updates = [];
  let lastState = Y.encodeStateAsUpdateV2(docA);

  function captureUpdate(label) {
    const s = Y.encodeStateAsUpdateV2(docA);
    const diff = Y.diffUpdateV2(s, lastState);
    updates.push({ label, payload: diff });
    lastState = s;
  }

  textA.insert(0, "hello ");
  captureUpdate("insert hello");
  textA.insert(6, "world");
  captureUpdate("insert world");
  mapA.set("title", "demo");
  captureUpdate("set title=demo");
  textA.delete(0, 5);
  captureUpdate("delete first 5 chars");
  mapA.set("title", "renamed");
  captureUpdate("set title=renamed");

  const finalSnapshot = Y.encodeStateAsUpdateV2(docA);
  const finalText = textA.toString();
  const finalTitle = mapA.get("title");

  // Replay 1: in-order
  const docB = new Y.Doc();
  for (const u of updates) Y.applyUpdateV2(docB, u.payload);
  check("yjs replay in-order matches",
    docB.getText("composition").toString() === finalText &&
    docB.getMap("settings").get("title") === finalTitle);

  // Replay 2: shuffled (yjs is commutative)
  const docC = new Y.Doc();
  const shuffled = [...updates].sort(() => Math.random() - 0.5);
  for (const u of shuffled) Y.applyUpdateV2(docC, u.payload);
  check("yjs replay shuffled matches (commutativity)",
    docC.getText("composition").toString() === finalText &&
    docC.getMap("settings").get("title") === finalTitle);

  // Replay 3: encodeStateAsUpdateV2 from B and C should equal each other
  const fpB = Y.encodeStateAsUpdateV2(docB);
  const fpC = Y.encodeStateAsUpdateV2(docC);
  check("yjs encoded state bit-equal across replay orders",
    Buffer.compare(Buffer.from(fpB), Buffer.from(fpC)) === 0,
    `b=${fpB.length}B c=${fpC.length}B`);
}

// ─── Test 2: parent-CID chain integrity ────────────────────────
{
  const snapshotCid = blake3_32(Buffer.from("snapshot-zero"));
  const ops = [];
  let prev = snapshotCid;
  for (let i = 1; i <= 100; i++) {
    const op = makeOp({
      seq: i,
      target: "composition",
      parentCid: prev,
      payload: Buffer.from(`op-${i}`),
    });
    ops.push(op);
    prev = op.cid;
  }

  // Healthy chain
  const r1 = verifyChain(snapshotCid, ops, "composition");
  check("healthy chain verifies", r1.ok);

  // Tampered middle: change one op's payload without updating CID
  const tampered = ops.map((o, i) =>
    i === 50 ? { ...o, payload_b64: Buffer.from("tampered").toString("base64") } : o);
  const r2 = verifyChain(snapshotCid, tampered, "composition");
  check("mid-stream tamper detected", !r2.ok && r2.brokeAt === 51,
    `broke at seq=${r2.brokeAt} kind=${r2.kind}`);

  // Reordered: swap two ops — parent_cid mismatch should detect
  const reordered = [...ops];
  [reordered[20], reordered[40]] = [reordered[40], reordered[20]];
  const r3 = verifyChain(snapshotCid, reordered, "composition");
  check("reordering detected", !r3.ok);
}

// ─── Test 3: trailing-op recovery ──────────────────────────────
{
  const snapshotCid = blake3_32(Buffer.from("snapshot-zero"));
  const ops = [];
  let prev = snapshotCid;
  for (let i = 1; i <= 10; i++) {
    const op = makeOp({
      seq: i,
      target: "composition",
      parentCid: prev,
      payload: Buffer.from(`op-${i}`),
    });
    ops.push(op);
    prev = op.cid;
  }
  // Simulate interrupted write: trailing op has wrong CID
  const corruptTail = { ...ops.pop(), cid: "blake3-deadbeef" + "0".repeat(24) };
  const withCorruptTail = [...ops, corruptTail];

  // Recovery policy: discard trailing op if its CID fails verification.
  const recovered = withCorruptTail.slice();
  while (recovered.length > 0 && !verifyOp(recovered[recovered.length - 1])) {
    recovered.pop();
  }

  check("trailing corrupt op discarded", recovered.length === 9,
    `recovered ${recovered.length} of 10 ops`);
  const r = verifyChain(snapshotCid, recovered, "composition");
  check("recovered chain still valid", r.ok);
}

// ─── Test 4: compaction determinism ───────────────────────────
{
  const docA = new Y.Doc();
  docA.getText("c").insert(0, "abc");
  docA.getMap("m").set("k", 1);

  // Capture as a single state update
  const stateA = Y.encodeStateAsUpdateV2(docA);

  // Replay into a fresh doc
  const docB = new Y.Doc();
  Y.applyUpdateV2(docB, stateA);
  const stateB = Y.encodeStateAsUpdateV2(docB);

  // Compaction = encodeStateAsUpdateV2 from current state. Should be
  // bit-identical to the source given identical doc state.
  check("compaction bit-stable across instances",
    Buffer.compare(Buffer.from(stateA), Buffer.from(stateB)) === 0,
    `${stateA.length}B vs ${stateB.length}B`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
