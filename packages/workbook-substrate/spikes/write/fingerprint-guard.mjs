#!/usr/bin/env node
// Spike 2 — fingerprint guard algorithm.
//
// Confirms: a runtime-side cache (FSA file handle, OPFS shadow buffer)
// keyed by (workbook_id, file_content_fingerprint) cannot contaminate
// a foreign workbook AND cannot revive stale state after the file has
// been modified externally.
//
// Run: node fingerprint-guard.mjs

import { createHash } from "node:crypto";

function blake3_32(s) {
  // Spike: SHA-256 truncated. Real substrate uses Blake3.
  return "blake3-" + createHash("sha256").update(s).digest("hex").slice(0, 32);
}

// Fake KV store representing IndexedDB. Keys here are NEVER user data —
// they store {fileHandle, opfsShadow, lastFingerprint} kinds of metadata.
class CacheStore {
  constructor() { this.entries = new Map(); }
  put(workbook_id, fingerprint, value) {
    this.entries.set(`${workbook_id}:${fingerprint}`, value);
  }
  get(workbook_id, fingerprint) {
    return this.entries.get(`${workbook_id}:${fingerprint}`);
  }
  // The substrate's read path:
  //   1. Look up by exact (workbook_id, fingerprint) tuple.
  //   2. If miss, no fallback — return undefined.
  // Conflation impossible because workbook_id key has no aliasing.
  lookup(workbook_id, fingerprint) {
    return this.get(workbook_id, fingerprint);
  }
  size() { return this.entries.size; }
}

// "Open a workbook file" simulator — given a file's contents (snapshot
// bytes serialized), compute its identity tuple.
function identifyWorkbook({ workbook_id, snapshotBytes }) {
  const fingerprint = blake3_32(snapshotBytes);
  return { workbook_id, fingerprint };
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ": " + detail : ""}`);
  if (ok) pass++; else fail++;
}

// ─── Scenario 1: Open workbook A, edit, close. Reopen the same file. ────
{
  const cache = new CacheStore();
  const file = {
    workbook_id: "01J0AAAAAAAAAAAAAAAAAAAAAAAA",
    snapshotBytes: "snapshot-state-v1",
  };
  const id = identifyWorkbook(file);
  cache.put(id.workbook_id, id.fingerprint, { handle: "fake-fsa-handle-A" });

  // Reopen — same file unchanged. Expect cache hit.
  const reopened = cache.lookup(id.workbook_id, id.fingerprint);
  check("reopen unchanged file: cache hit", reopened?.handle === "fake-fsa-handle-A");
}

// ─── Scenario 2: Open workbook B (different UUID, similar contents). ────
{
  const cache = new CacheStore();
  const fileA = {
    workbook_id: "01J0AAAAAAAAAAAAAAAAAAAAAAAA",
    snapshotBytes: "snapshot-state-v1",
  };
  const fileB = {
    workbook_id: "01J0BBBBBBBBBBBBBBBBBBBBBBBB",
    snapshotBytes: "snapshot-state-v1",  // identical content, different UUID
  };
  const idA = identifyWorkbook(fileA);
  const idB = identifyWorkbook(fileB);
  cache.put(idA.workbook_id, idA.fingerprint, { handle: "handle-A", state: "alice's state" });

  // Open B: fingerprint coincidentally matches A's, but UUID differs.
  const lookup = cache.lookup(idB.workbook_id, idB.fingerprint);
  check("open foreign workbook with same content: NO cache leak",
    lookup === undefined,
    `cache.size=${cache.size()} entries; lookup result=${lookup ? "FOUND (BAD)" : "miss (good)"}`);
}

// ─── Scenario 3: File modified externally between sessions. ─────────────
{
  const cache = new CacheStore();
  const original = {
    workbook_id: "01J0CCCCCCCCCCCCCCCCCCCCCCCC",
    snapshotBytes: "snapshot-state-v1",
  };
  const id1 = identifyWorkbook(original);
  cache.put(id1.workbook_id, id1.fingerprint, { handle: "handle-orig" });

  // Someone (you on another machine, a friend, an external tool) modifies
  // the file. Same UUID; new content.
  const modified = {
    workbook_id: "01J0CCCCCCCCCCCCCCCCCCCCCCCC",
    snapshotBytes: "snapshot-state-v2-MODIFIED",
  };
  const id2 = identifyWorkbook(modified);

  // Open the modified file: cache miss.
  const lookup = cache.lookup(id2.workbook_id, id2.fingerprint);
  check("open externally-modified file: NO stale cache",
    lookup === undefined,
    `id1.fingerprint=${id1.fingerprint.slice(0,16)}... id2.fingerprint=${id2.fingerprint.slice(0,16)}...`);
}

// ─── Scenario 4: Compaction emits new file → fingerprint changes ──────
// During the same session, after a compaction, the file's content
// fingerprint changes. The runtime must update its own cache key to the
// new fingerprint immediately, so the NEXT open (after any tab close)
// finds the cache.
{
  const cache = new CacheStore();
  const before = {
    workbook_id: "01J0DDDDDDDDDDDDDDDDDDDDDDDD",
    snapshotBytes: "pre-compact-snapshot+15-wal-ops",
  };
  const idBefore = identifyWorkbook(before);
  cache.put(idBefore.workbook_id, idBefore.fingerprint, { handle: "handle-D" });

  // Compaction happens; file is rewritten with fresh snapshot, empty WAL.
  const after = {
    workbook_id: "01J0DDDDDDDDDDDDDDDDDDDDDDDD",
    snapshotBytes: "post-compact-snapshot",
  };
  const idAfter = identifyWorkbook(after);

  // Runtime must MIGRATE the cache entry from old fingerprint to new
  // fingerprint atomically with the compaction commit.
  const oldEntry = cache.lookup(idBefore.workbook_id, idBefore.fingerprint);
  cache.put(idAfter.workbook_id, idAfter.fingerprint, oldEntry);
  cache.entries.delete(`${idBefore.workbook_id}:${idBefore.fingerprint}`);

  // Reopen post-compaction: cache hit at new fingerprint.
  const reopened = cache.lookup(idAfter.workbook_id, idAfter.fingerprint);
  check("post-compaction reopen: cache key migrated",
    reopened?.handle === "handle-D" && cache.size() === 1);

  // And old fingerprint is GONE — no orphan entries.
  const stale = cache.lookup(idBefore.workbook_id, idBefore.fingerprint);
  check("old fingerprint cleaned up", stale === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
