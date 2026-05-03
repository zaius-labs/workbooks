// Workbook substrate v0 — type contract.
// Wire format defined in vendor/workbooks/docs/SUBSTRATE_FORMAT_V0.md.

/** Content identifier — `blake3-` + 32 lowercase hex chars. */
export type Cid = string;

/** Stable identifier baked into the file at build time, never regenerated. */
export type WorkbookId = string;

/** Decoded `<wb-meta>` block. */
export interface SubstrateMeta {
  workbook_id: WorkbookId;
  substrate_version: "v0";
  schema_version: number;
  /** Authorial timestamp; informational only. */
  created_at?: string;
  /** Monotonically increasing across compactions. Starts at 0. */
  compaction_seq: number;
  /** Map from container-target name (e.g. "composition", "data") to that
   *  container's current snapshot CID. New WAL ops parent off these. */
  snapshot_cid_by_target: Record<string, Cid>;
}

/** Decoded `<wb-snapshot:TARGET>` block. */
export interface Snapshot {
  /** Target name (the part after `wb-snapshot:`). */
  target: string;
  /** Decoded bytes. */
  bytes: Uint8Array;
  /** CID of `bytes`, taken from data-cid attribute. Verified against
   *  recomputation by the parser; if mismatch, the parser throws. */
  cid: Cid;
  /** Format hint for the runtime. v0 reserves "yjs", "sqlite", "bytes". */
  format: string;
}

/** Decoded `<wb-wal>` op record. */
export interface WalOp {
  /** Globally monotonic sequence number across all targets. */
  seq: number;
  /** Target name this op applies to. */
  target: string;
  /** CID of the prior state for this target (snapshot CID or prior op's CID). */
  parent_cid: Cid;
  /** CID of this op's effect: blake3_32(parent_cid || target || seq || payload). */
  cid: Cid;
  /** Authorial timestamp; informational only. */
  ts?: string;
  /** Op payload as decoded bytes. Format-specific:
   *  - yjs targets: bytes from `Y.encodeStateAsUpdateV2`
   *  - sqlite targets: bytes from `sqlite3session_changeset` */
  payload: Uint8Array;
}

/** Result of `parseSubstrate(htmlOrDocument)`. Pure data; no live handles. */
export interface SubstrateFile {
  meta: SubstrateMeta;
  /** Map from target name to its snapshot. Empty Map if the workbook has
   *  no snapshots (e.g. fresh build with no edits yet). */
  snapshots: Map<string, Snapshot>;
  /** WAL ops in seq order. May be empty. */
  wal: WalOp[];
  /** Workbook-content fingerprint = blake3_32 over canonicalized
   *  snapshot CIDs. Used by the conflation guard to key transport-side
   *  cache. */
  fingerprint: Cid;
}

/** Substrate parse / verify error. */
export class SubstrateError extends Error {
  constructor(public code: SubstrateErrorCode, message: string) {
    super(message);
    this.name = "SubstrateError";
  }
}

export type SubstrateErrorCode =
  | "missing-meta"
  | "invalid-meta-json"
  | "unsupported-substrate-version"
  | "missing-wal"
  | "invalid-wal-json"
  | "snapshot-cid-mismatch"
  | "wal-cid-mismatch"
  | "wal-seq-non-monotonic"
  | "wal-parent-cid-broken"
  | "trailing-op-corrupt"; // recoverable; runtime discards trailing op
