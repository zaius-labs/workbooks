// T5 — Read-only.
//
// The fallback when no transport works at all (no FSA, no OPFS, etc.).
// All commitPatch calls are rejected with a clear "queued" result so the
// runtime UI can surface "this browser cannot save your changes."

import type {
  SubstrateTransport,
  CommitRequest,
  CommitResult,
  WriteSemantics,
} from "../transport";

export class ReadOnlyTransport implements SubstrateTransport {
  semantics(): WriteSemantics {
    return {
      canTrueAppend: false,
      rewriteCostPerCommit: "full",
      fingerprintAfterClose: "queryable",
      tier: "T5",
      status: "read-only",
    };
  }
  async commitPatch(_req: CommitRequest): Promise<CommitResult> {
    return {
      kind: "queued",
      reason: "no transport available — workbook is read-only in this browser",
    };
  }
}
