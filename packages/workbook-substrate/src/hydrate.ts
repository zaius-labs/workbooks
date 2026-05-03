// Hydration helpers for substrate snapshots + WAL.
//
// The substrate parser delivers raw bytes per target. The runtime
// chooses how to apply those bytes per format. These helpers cover the
// two formats v0 ships with: yjs (Y.encodeStateAsUpdateV2 bytes) and
// sqlite (raw DB bytes + Sessions changesets).
//
// Callers can also write their own hydrators for custom targets — the
// substrate doesn't care, it just delivers the structured data.

import type { SubstrateFile, Snapshot, WalOp } from "./types";

// ── yjs ──────────────────────────────────────────────────────────

/** Apply a yjs target's snapshot + WAL to a Y.Doc.
 *
 *  Caller passes `Y` as the yjs module so this file doesn't take a
 *  hard dep on yjs (substrate is engine-agnostic; the runtime that
 *  actually uses yjs imports it). */
export interface YjsLike {
  Doc: new () => YDocLike;
  applyUpdateV2: (doc: YDocLike, bytes: Uint8Array) => void;
}
export interface YDocLike {}

export function hydrateYjsTarget(
  Y: YjsLike,
  doc: YDocLike,
  file: SubstrateFile,
  target: string,
): { applied: number } {
  let applied = 0;
  const snap = file.snapshots.get(target);
  if (snap && snap.format === "yjs") {
    Y.applyUpdateV2(doc, snap.bytes);
    applied++;
  }
  for (const op of file.wal) {
    if (op.target !== target) continue;
    Y.applyUpdateV2(doc, op.payload);
    applied++;
  }
  return { applied };
}

// ── sqlite ───────────────────────────────────────────────────────

/** Apply a sqlite target's snapshot (raw DB bytes) + WAL (Sessions
 *  changesets) to a fresh SQLite Database handle.
 *
 *  Caller provides `sqlite3` (the @sqlite.org/sqlite-wasm Sqlite3Static)
 *  and a per-target conflict policy. */
export interface SqliteLike {
  capi: any;
  wasm: any;
  oo1: any;
}

export interface HydrateSqliteOptions {
  /** The DB handle the bytes will be loaded into. The hydrator does
   *  the deserialize call against this DB. */
  db: any;
  /** Conflict policy callback. Return one of OMIT(0), REPLACE(1),
   *  ABORT(2). Default policy: DATA→REPLACE, NOTFOUND→OMIT,
   *  CONFLICT/CONSTRAINT/FK→ABORT. */
  onConflict?: (eConflict: number, target: string) => 0 | 1 | 2;
}

export const DEFAULT_SQLITE_CONFLICT_POLICY = (eConflict: number): 0 | 1 | 2 => {
  // Codes from sqlite3.h:
  //   SQLITE_CHANGESET_DATA       = 1  → REPLACE (preserve incoming author intent)
  //   SQLITE_CHANGESET_NOTFOUND   = 2  → OMIT    (target row gone; nothing to do)
  //   SQLITE_CHANGESET_CONFLICT   = 3  → ABORT   (PK collision; structural)
  //   SQLITE_CHANGESET_CONSTRAINT = 4  → ABORT   (constraint violation)
  //   SQLITE_CHANGESET_FOREIGN_KEY= 5  → ABORT   (FK violation)
  switch (eConflict) {
    case 1: return 1;
    case 2: return 0;
    default: return 2;
  }
};

/** Hydrate a SQLite target from its substrate snapshot + WAL.
 *
 *  Strategy:
 *  1. If there's a snapshot, deserialize it into the DB via
 *     sqlite3_deserialize (loads bytes wholesale).
 *  2. Replay each WAL op (Sessions changeset) via sqlite3changeset_apply,
 *     using the configured conflict policy. */
export function hydrateSqliteTarget(
  sqlite3: SqliteLike,
  file: SubstrateFile,
  target: string,
  opts: HydrateSqliteOptions,
): { applied: number } {
  const { db } = opts;
  const onConflict = opts.onConflict ?? DEFAULT_SQLITE_CONFLICT_POLICY;
  const { capi, wasm } = sqlite3;
  let applied = 0;

  const snap = file.snapshots.get(target);
  if (snap && snap.format === "sqlite") {
    // sqlite3_deserialize copies the bytes; the DB owns memory afterward.
    const pBytes = wasm.alloc(snap.bytes.length);
    wasm.heap8u().set(snap.bytes, pBytes);
    const rc = capi.sqlite3_deserialize(
      db.pointer ?? db,
      "main",
      pBytes,
      snap.bytes.length,
      snap.bytes.length,
      capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
    );
    if (rc !== 0) throw new Error(`sqlite3_deserialize failed rc=${rc}`);
    applied++;
  }

  for (const op of file.wal) {
    if (op.target !== target) continue;
    const pCs = wasm.alloc(op.payload.length);
    wasm.heap8u().set(op.payload, pCs);
    const pHandler = wasm.installFunction("ipip", (_pCtx: number, eConflict: number) => {
      return onConflict(eConflict, target);
    });
    const rc = capi.sqlite3changeset_apply(
      db.pointer ?? db,
      op.payload.length, pCs,
      0, pHandler, 0,
    );
    wasm.dealloc(pCs);
    wasm.uninstallFunction(pHandler);
    if (rc !== 0) {
      throw new Error(`sqlite3changeset_apply failed at seq=${op.seq} rc=${rc}`);
    }
    applied++;
  }

  return { applied };
}
