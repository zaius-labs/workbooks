// Substrate mutation API + WAL emitter.
//
// Holds the in-memory state of a workbook substrate (meta + snapshots +
// WAL) and exposes commit(target, deltaBytes) that:
//   1. Computes the next seq number
//   2. Computes the parent CID (last seen for that target, or snapshot CID)
//   3. Computes the op CID via opCidInputs/cidOf
//   4. Appends to the in-memory WAL
//   5. Returns the new WalOp for transport to persist
//
// Persistence (writing to disk) is the transport's job — see
// transport.ts. The mutator is pure data manipulation.
//
// Auto-binding helpers attach to a yjs Y.Doc or a SQLite Sessions object
// and route their delta events into commit() automatically.

import type { SubstrateFile, WalOp, Cid } from "./types";
import { cidOfSync, opCidInputs } from "./cid";

export interface SubstrateMutator {
  /** Live view of the substrate's data. Mutations through commit()
   *  reflect here immediately. */
  readonly file: SubstrateFile;
  /** Append a new op to the WAL. Synchronous bookkeeping; the returned
   *  op describes what was appended. The transport observes via
   *  onCommit() and persists. */
  commit(target: string, payload: Uint8Array): Promise<WalOp>;
  /** Subscribe to commits — fires synchronously inside commit() after
   *  the WAL has been updated. Multiple subscribers allowed. Returns an
   *  unsubscribe function. */
  onCommit(fn: CommitListener): () => void;
  /** Replace the file (used by compaction — emits a new snapshot, clears
   *  WAL, bumps compaction_seq). */
  replaceFile(next: SubstrateFile): void;
  /** Get the next seq number that would be emitted. Useful for tests. */
  peekNextSeq(): number;
}

export type CommitListener = (op: WalOp) => void;

/** Construct a mutator over an existing parsed substrate file. */
export function createMutator(initial: SubstrateFile): SubstrateMutator {
  let file = initial;
  let nextSeq = (initial.wal[initial.wal.length - 1]?.seq ?? 0) + 1;
  // Per-target last CID (snapshot CID or last op's CID for that target).
  const lastCidByTarget = new Map<string, Cid>();
  for (const [target, cid] of Object.entries(file.meta.snapshot_cid_by_target)) {
    lastCidByTarget.set(target, cid);
  }
  for (const op of file.wal) {
    lastCidByTarget.set(op.target, op.cid);
  }

  const listeners = new Set<CommitListener>();

  return {
    get file() { return file; },

    async commit(target: string, payload: Uint8Array): Promise<WalOp> {
      // Use the snapshot CID if this is the first op for this target,
      // or the last seen op's CID otherwise. New target with no snapshot
      // gets a sentinel "blake3-" + zeros — runtime should treat this
      // case as "implicit empty snapshot."
      //
      // CRITICAL: read parent_cid, compute new cid, and update
      // lastCidByTarget all SYNCHRONOUSLY. The CID computation goes
      // through cidOfSync (no await) so concurrent commit() calls —
      // which arrive whenever Y.Doc fires multiple updateV2 events in
      // a tick — don't race on lastCidByTarget. The async commit()
      // signature is preserved so callers can still await for the
      // returned op + transport listeners; the body is sync until
      // post-update.
      const parentCid = lastCidByTarget.get(target)
        ?? "blake3-" + "0".repeat(32);
      const seq = nextSeq++;
      const cid = cidOfSync(opCidInputs(parentCid, target, seq, payload));
      const op: WalOp = {
        seq,
        target,
        parent_cid: parentCid,
        cid,
        ts: new Date().toISOString(),
        payload,
      };
      file.wal.push(op);
      lastCidByTarget.set(target, cid);
      for (const fn of listeners) {
        try { fn(op); } catch (e) { console.warn("substrate commit listener threw:", e); }
      }
      return op;
    },

    onCommit(fn: CommitListener): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    replaceFile(next: SubstrateFile): void {
      file = next;
      nextSeq = (next.wal[next.wal.length - 1]?.seq ?? 0) + 1;
      lastCidByTarget.clear();
      for (const [target, cid] of Object.entries(next.meta.snapshot_cid_by_target)) {
        lastCidByTarget.set(target, cid);
      }
      for (const op of next.wal) {
        lastCidByTarget.set(op.target, op.cid);
      }
    },

    peekNextSeq(): number {
      return nextSeq;
    },
  };
}

// ── auto-binding: yjs ───────────────────────────────────────────

export interface YjsBindOptions {
  /** Y namespace — the yjs module. Caller imports yjs and passes it. */
  Y: any;
  /** The Y.Doc to observe. */
  doc: any;
  /** Substrate target name (default: "composition"). */
  target?: string;
}

/** Auto-emit a substrate WAL op for every Y.Doc update. Returns an
 *  unbind function. */
export function bindYjsAutoEmit(
  mutator: SubstrateMutator,
  opts: YjsBindOptions,
): () => void {
  const target = opts.target ?? "composition";
  // CRITICAL: the FIRST capture must be a full-state update, not a
  // delta from the doc's current state vector. Why: when
  // bindYjsAutoEmit fires, the host (e.g. colorwave) has already
  // written state to the Y.Doc (wb.text initial values, module-load
  // wb.* primitives, etc.). If we captured a delta from the
  // CURRENT vector, every subsequent delta would reference items
  // that exist in THIS doc but not in a fresh doc doing replay —
  // the items get queued as pending and never apply. State
  // silently fails to hydrate. (`new Uint8Array()` is NOT the empty
  // state vector — yjs's varint decoder errors on zero-length input.
  // Pass undefined to mean "encode full state".)
  //
  // After the first capture, subsequent deltas chain off it normally.
  let lastVector: Uint8Array | undefined = undefined;
  const handler = () => {
    // Compute the diff since the last commit and emit it.
    const update = opts.Y.encodeStateAsUpdateV2(opts.doc, lastVector);
    lastVector = opts.Y.encodeStateVector(opts.doc);
    if (update.length === 0) return;
    void mutator.commit(target, update);
  };
  opts.doc.on("updateV2", handler);
  return () => opts.doc.off("updateV2", handler);
}

// ── auto-binding: SQLite Sessions ───────────────────────────────

export interface SqliteSessionBindOptions {
  /** sqlite3InitModule()'s Sqlite3Static result — provides capi + wasm. */
  sqlite3: any;
  /** The DB whose mutations are captured. */
  db: any;
  /** Substrate target name (default: "data"). */
  target?: string;
  /** Capture cadence — emit a changeset on this trigger. */
  trigger:
    | { kind: "transaction-end" }    // capture per transaction
    | { kind: "manual" }             // caller invokes captureNow()
    | { kind: "interval"; ms: number };
}

export interface SqliteSessionBinding {
  captureNow(): Promise<void>;
  unbind(): void;
}

/** Auto-emit substrate WAL ops for SQLite Sessions changesets.
 *
 *  Strategy: attach a session, periodically (or on demand) capture its
 *  changeset, emit as an op, then reset the session for the next
 *  capture. */
export function bindSqliteSessionAutoEmit(
  mutator: SubstrateMutator,
  opts: SqliteSessionBindOptions,
): SqliteSessionBinding {
  const { sqlite3, db } = opts;
  const target = opts.target ?? "data";
  const { capi, wasm } = sqlite3;
  const dbPtr = db.pointer ?? db;

  let pSession = createSession(capi, wasm, dbPtr);

  async function captureNow(): Promise<void> {
    const ppChange = wasm.alloc(8);
    const pnChange = wasm.alloc(4);
    const rc = capi.sqlite3session_changeset(pSession, pnChange, ppChange);
    if (rc !== 0) {
      wasm.dealloc(ppChange); wasm.dealloc(pnChange);
      throw new Error(`sqlite3session_changeset rc=${rc}`);
    }
    const nChange = wasm.peek(pnChange, "i32");
    const pChange = wasm.peekPtr(ppChange);
    if (nChange === 0) {
      wasm.dealloc(ppChange); wasm.dealloc(pnChange);
      return; // empty changeset
    }
    const bytes = wasm.heap8u().slice(pChange, pChange + nChange);
    capi.sqlite3_free(pChange);
    wasm.dealloc(ppChange); wasm.dealloc(pnChange);

    // Emit
    await mutator.commit(target, bytes);

    // Reset session for next capture
    capi.sqlite3session_delete(pSession);
    pSession = createSession(capi, wasm, dbPtr);
  }

  let intervalHandle: any = null;
  if (opts.trigger.kind === "interval") {
    intervalHandle = setInterval(() => {
      void captureNow().catch((e) => console.warn("substrate sqlite capture:", e));
    }, opts.trigger.ms);
  }

  return {
    captureNow,
    unbind() {
      if (intervalHandle) clearInterval(intervalHandle);
      capi.sqlite3session_delete(pSession);
    },
  };
}

function createSession(capi: any, wasm: any, dbPtr: number): number {
  const ppSession = wasm.alloc(8);
  const rc = capi.sqlite3session_create(dbPtr, "main", ppSession);
  if (rc !== 0) {
    wasm.dealloc(ppSession);
    throw new Error(`sqlite3session_create rc=${rc}`);
  }
  const pSession = wasm.peekPtr(ppSession);
  wasm.dealloc(ppSession);
  capi.sqlite3session_attach(pSession, null);
  return pSession;
}
