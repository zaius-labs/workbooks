// Substrate transport — moves persisted bytes from the runtime's
// in-memory state back to a place on disk that round-trips on next open.
//
// The runtime delegates persistence to a transport. The transport
// chooses how (FSA writethrough, OPFS shadow, download, etc.); the
// runtime only describes WHAT to persist via commitPatch().
//
// All transports implement the same interface. The negotiator picks
// the strongest available at runtime startup; a transport may swap
// later (e.g. user installs the PWA mid-session → upgrade T3 → T2).
//
// Tier reference (decreasing-friction):
//   T2 — PWA-installed File System Access (handle from launchQueue)
//   T3 — Per-session FSA (handle from showSaveFilePicker, lost on tab close)
//   T4 — OPFS shadow + download fallback (no FSA available)
//   T5 — Read-only (no transport at all; refuses commits)

import type { SubstrateFile, WalOp, Cid } from "./types";

/** A snapshot of the substrate file image to write. */
export interface FileImage {
  /** The full HTML payload to write to disk for the workbook. The
   *  transport may choose to write this in pieces or all at once;
   *  what's guaranteed is that the bytes round-trip. */
  html: string;
  /** Number of bytes (for progress reporting). */
  byteLength: number;
  /** New post-write fingerprint to record in the identity store. */
  fingerprint: Cid;
}

/** A patch the runtime would like to land on disk.
 *
 *  expectedFingerprint = the runtime's view of the file's content
 *  fingerprint at commit time. Transports MUST verify the on-disk file
 *  still matches before applying the patch (FSA does this trivially via
 *  the cached handle; OPFS does it by comparing its shadow image's
 *  fingerprint). On mismatch, transport returns
 *  `{kind: "fingerprint-mismatch", actualFingerprint}` and the runtime
 *  surfaces "this file changed externally" to the user. */
export interface CommitRequest {
  expectedFingerprint: Cid;
  /** The new image post-mutation. The transport persists this image. */
  newImage: FileImage;
  /** Whether the runtime can tolerate the transport doing a full rewrite
   *  (most transports always rewrite; T1 native could append). */
  mode: "rewrite-required" | "append-preferred";
}

export type CommitResult =
  | { kind: "ok"; durableAt: number /* epoch ms */ }
  | { kind: "fingerprint-mismatch"; actualFingerprint: Cid }
  | { kind: "queued"; reason: string }   // e.g. T4 "click to download"
  | { kind: "error"; message: string };

/** Capability descriptor — what a transport can do. */
export interface WriteSemantics {
  canTrueAppend: boolean;
  rewriteCostPerCommit: "delta" | "full";
  fingerprintAfterClose: "deterministic" | "queryable";
  /** Tier label for telemetry / status indicator. */
  tier: "T1" | "T2" | "T3" | "T4" | "T5";
  /** User-visible status string for the menubar pill. */
  status: "saved-in-file" | "needs-permission" | "download-to-keep" | "read-only";
}

export interface SubstrateTransport {
  semantics(): WriteSemantics;
  /** Optional one-time setup. T2/T3 may need to acquire the FSA handle.
   *  Resolves when the transport is fully ready to commit. */
  prepare?(): Promise<void>;
  commitPatch(req: CommitRequest): Promise<CommitResult>;
  /** Subscribe to status changes — fires when the transport's status
   *  string changes (e.g. saved → needs-permission after handle lost). */
  onStatusChange?(fn: (s: WriteSemantics["status"]) => void): () => void;
  /** Tear down — close handles, clear timers. */
  dispose?(): Promise<void>;
}
