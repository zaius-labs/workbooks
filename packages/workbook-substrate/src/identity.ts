// Substrate identity guard.
//
// The conflation guard keeps browser-side caches (FSA file handles, OPFS
// shadow buffers, anything else a transport keeps) keyed by:
//
//     key = `${workbook_id}:${file_content_fingerprint}`
//
// Both halves are required:
//
//   - workbook_id (from <wb-meta>) is baked at build time and never
//     changes for the lineage of a workbook. Two byte-identical files
//     with different workbook_ids are SEPARATE workbooks; opening one
//     must not see the other's cache.
//
//   - file_content_fingerprint = blake3_32 of canonicalized snapshot
//     CIDs. Changes any time the file's snapshot bytes change (compact,
//     external edit, etc.). Same workbook_id with stale fingerprint
//     means the cache is out of date — discard, hydrate from file.
//
// This module wraps a generic KV store with this guard. Any browser-
// side persistence (IndexedDB for FSA handles, Cache API for blob
// shadows, etc.) plugs in via the Store interface.

import type { Cid, WorkbookId, SubstrateFile } from "./types";

export interface IdentityKey {
  workbook_id: WorkbookId;
  fingerprint: Cid;
}

export function identityKeyOf(file: SubstrateFile): IdentityKey {
  return { workbook_id: file.meta.workbook_id, fingerprint: file.fingerprint };
}

export function keyString(k: IdentityKey): string {
  return `${k.workbook_id}:${k.fingerprint}`;
}

/** Pluggable KV interface — implementations may target IndexedDB,
 *  localStorage, an in-memory Map (for tests), etc.
 *
 *  Important: keys must be the EXACT (workbook_id, fingerprint) tuple.
 *  Implementations may not "fall back" to partial-key lookups. */
export interface IdentityStore<T = unknown> {
  get(k: IdentityKey): Promise<T | undefined>;
  set(k: IdentityKey, value: T): Promise<void>;
  delete(k: IdentityKey): Promise<void>;
  /** Optional: enumerate. Used only by GC passes. */
  list?(): AsyncIterable<{ key: IdentityKey; value: T }>;
}

/** In-memory store for tests. Not for production use — production wraps
 *  IndexedDB inside a Worker or via idb-keyval. */
export class MemoryIdentityStore<T = unknown> implements IdentityStore<T> {
  private map = new Map<string, T>();

  async get(k: IdentityKey): Promise<T | undefined> {
    return this.map.get(keyString(k));
  }
  async set(k: IdentityKey, value: T): Promise<void> {
    this.map.set(keyString(k), value);
  }
  async delete(k: IdentityKey): Promise<void> {
    this.map.delete(keyString(k));
  }
  async *list(): AsyncIterable<{ key: IdentityKey; value: T }> {
    for (const [s, value] of this.map) {
      const [workbook_id, fingerprint] = s.split(":", 2) as [string, string];
      yield { key: { workbook_id, fingerprint }, value };
    }
  }
  /** Test-only: total entry count. */
  size(): number { return this.map.size; }
}

/** Atomically migrate a cache entry from an old (workbook_id, fp) to a
 *  new (workbook_id, fp). Used by the compaction commit path: when the
 *  new file successfully persists, the cache key migrates so the next
 *  open hits cache.
 *
 *  If the old key is absent, the new key is simply set (with whatever
 *  default the caller provides) — this handles the "first compaction
 *  ever for this file" case. */
export async function migrateIdentity<T>(
  store: IdentityStore<T>,
  from: IdentityKey,
  to: IdentityKey,
  defaultValueIfMissing?: T,
): Promise<void> {
  const existing = await store.get(from);
  if (existing !== undefined) {
    await store.set(to, existing);
    await store.delete(from);
  } else if (defaultValueIfMissing !== undefined) {
    await store.set(to, defaultValueIfMissing);
  }
}

/** GC orphans: delete cache entries whose workbook_id no longer matches
 *  any opened workbook in the current session.
 *
 *  Call sparingly — at session start, on visible quota pressure, or in
 *  an idle hook. */
export async function gcOrphans<T>(
  store: IdentityStore<T>,
  liveWorkbookIds: Set<WorkbookId>,
): Promise<number> {
  if (!store.list) return 0;
  let deleted = 0;
  for await (const { key } of store.list()) {
    if (!liveWorkbookIds.has(key.workbook_id)) {
      await store.delete(key);
      deleted++;
    }
  }
  return deleted;
}
