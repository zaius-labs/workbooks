// Substrate compactor.
//
// Folds the WAL into fresh snapshots. The compactor is engine-agnostic:
// it asks the caller's encoder to produce fresh bytes for each target
// (knowing the target's current state), then assembles a new
// SubstrateFile with empty WAL + bumped compaction_seq.
//
// Compaction is opportunistic — never required for correctness. A
// failed compaction (transport rejects, fingerprint mismatch, encoder
// throws) leaves the prior file untouched. Only when the new file is
// successfully persisted does the runtime swap to it via
// mutator.replaceFile().

import { cidOf } from "./cid";
import type {
  SubstrateFile,
  Snapshot,
  SubstrateMeta,
  WalOp,
} from "./types";

/** Caller-supplied encoder: given a target name + the current parsed
 *  state for that target (snapshot + WAL ops, pre-compaction), return
 *  the fresh snapshot bytes that capture the post-replay state.
 *
 *  For yjs: `Y.encodeStateAsUpdateV2(doc)` after applying snapshot+WAL.
 *  For sqlite: `sqlite3.capi.sqlite3_serialize(db, "main", null, 0)`.
 *  Custom targets: whatever the format demands. */
export type TargetEncoder = (
  target: string,
  snapshot: Snapshot | undefined,
  walOpsForTarget: WalOp[],
) => Promise<Uint8Array>;

export interface CompactOptions {
  /** Per-target encoder. Required for every target referenced by the
   *  current file (snapshots + targets touched by WAL). */
  encode: TargetEncoder;
  /** Format hint to set on each new snapshot. Defaults to "yjs" /
   *  "sqlite" / inherited from prior snapshot. */
  format?: (target: string) => string;
}

/** Build a fresh SubstrateFile by compacting the current file's WAL.
 *
 *  Postconditions:
 *  - returned.meta.compaction_seq = file.meta.compaction_seq + 1
 *  - returned.snapshots covers every target in (file.snapshots ∪ targets touched by WAL)
 *  - returned.wal = []
 *  - returned.fingerprint reflects the new snapshot CIDs */
export async function compact(
  file: SubstrateFile,
  opts: CompactOptions,
): Promise<SubstrateFile> {
  // Determine target set: existing snapshots ∪ targets touched by WAL
  const targetSet = new Set<string>(file.snapshots.keys());
  for (const op of file.wal) targetSet.add(op.target);

  const newSnapshots = new Map<string, Snapshot>();
  const newSnapshotCids: Record<string, string> = {};

  for (const target of targetSet) {
    const snapBefore = file.snapshots.get(target);
    const walForTarget = file.wal.filter((o) => o.target === target);
    const newBytes = await opts.encode(target, snapBefore, walForTarget);
    const newCid = await cidOf(newBytes);
    const format =
      opts.format?.(target) ?? snapBefore?.format ?? inferFormat(target);
    newSnapshots.set(target, { target, bytes: newBytes, cid: newCid, format });
    newSnapshotCids[target] = newCid;
  }

  const newMeta: SubstrateMeta = {
    workbook_id: file.meta.workbook_id,
    substrate_version: "v0",
    schema_version: file.meta.schema_version,
    created_at: file.meta.created_at,
    compaction_seq: file.meta.compaction_seq + 1,
    snapshot_cid_by_target: newSnapshotCids,
  };

  const fingerprint = await fingerprintOf(newSnapshots);

  return {
    meta: newMeta,
    snapshots: newSnapshots,
    wal: [],
    fingerprint,
  };
}

/** Whether the given file should be compacted per the v0 default policy.
 *
 *  Triggers (any one):
 *    - WAL byte size > 20% of total snapshot byte size
 *    - WAL op count > 500
 *    - (caller-passed) elapsed time since last compaction
 *
 *  Caller can pass a custom policy too. */
export function shouldCompact(
  file: SubstrateFile,
  customCheck?: (f: SubstrateFile) => boolean,
): boolean {
  if (customCheck) return customCheck(file);
  if (file.wal.length === 0) return false;
  if (file.wal.length > 500) return true;

  const snapBytes = [...file.snapshots.values()].reduce(
    (sum, s) => sum + s.bytes.length,
    0,
  );
  const walBytes = file.wal.reduce((sum, o) => sum + o.payload.length, 0);
  if (snapBytes === 0) return walBytes > 0; // no snapshot yet → compact
  return walBytes > snapBytes * 0.2;
}

// ── helpers ──────────────────────────────────────────────────────

function inferFormat(target: string): string {
  // Light convention: "data" → sqlite, everything else → yjs. Authors
  // can override via opts.format.
  if (target === "data" || target.endsWith(":sqlite")) return "sqlite";
  return "yjs";
}

async function fingerprintOf(snapshots: Map<string, Snapshot>): Promise<string> {
  const keys = [...snapshots.keys()].sort();
  const canonical = keys.map((k) => `${k}=${snapshots.get(k)!.cid};`).join("");
  return cidOf(canonical);
}
