# Workbook Substrate File Format — v0

**Status:** Draft, allowed to mutate during phase P1 of the substrate epic. Lock target: substrate runtime first stable release.

**Audience:** Substrate runtime authors, workbook CLI authors, anyone reading a workbook file with intent to interpret it.

## Goals

A workbook file is, simultaneously:

1. A valid HTML5 document that any browser can render.
2. The canonical, portable container of a workbook's complete state — yjs CRDT bytes for the spec/composition, optionally SQLite bytes for relational data, optionally other typed data containers.
3. An append-only ledger of state mutations (the WAL), with periodic compaction back into snapshots.

State must round-trip across machines, browsers, and email/USB transfer with zero loss. Two readers of the same file — anywhere, anytime — must hydrate to the same in-memory state.

## Non-goals

- Network transport, sync protocols, multi-writer coordination — all out of scope for v0. (The WAL format is designed to support these later, but v0 ships single-writer-only.)
- Authentication, access control, encryption — out of scope. Future versions may add encrypted regions.
- Mobile execution — out of scope. Mobile browsers cannot write back to local files; they get a read-only / download-export experience covered separately.

## Document outline

```
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="workbook-substrate" content="v0" />
    <title>...</title>

    <!-- §1 Identity (required) -->
    <script type="application/json" id="wb-meta">{...}</script>

    <!-- §2 Snapshots (zero or more, one per data container) -->
    <script type="application/octet-stream"
            id="wb-snapshot:composition"
            data-cid="..."
            data-format="yjs">BASE64</script>
    <script type="application/octet-stream"
            id="wb-snapshot:data"
            data-cid="..."
            data-format="sqlite">BASE64</script>

    <!-- §3 WAL (required, may be empty array) -->
    <script type="application/json" id="wb-wal">[...]</script>

    <!-- §4 Runtime + app code (opaque to the substrate) -->
    <script type="module" id="workbook-runtime">...</script>
    <script type="module" id="workbook-app">...</script>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>
```

There must be **no bytes after `</html>`**. Per the parser-containment spike (`packages/workbook-substrate/spikes/parser/FINDINGS.md`), trailing bytes are parsed as character data and pollute the DOM in all three target engines. Anything that needs to be in the file must live inside a `<script>` tag in the `<head>`.

## §1 Identity — `<wb-meta>`

```json
{
  "workbook_id": "01J0K8E9G7H7T9F4S3Q1B2N5V6",
  "substrate_version": "v0",
  "schema_version": 0,
  "created_at": "2026-05-01T07:00:00Z",
  "compaction_seq": 42,
  "snapshot_cid_by_target": {
    "composition": "blake3-...",
    "data": "blake3-..."
  }
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `workbook_id` | string (ULID) | yes | Stable identifier baked at build time by the workbook CLI. NEVER changes for the lifetime of a workbook lineage. Used as the conflation guard key (`(workbook_id, file_content_fingerprint)`) for any browser-side cache. |
| `substrate_version` | `"v0"` | yes | Format major version. Bumped on breaking changes. Runtime refuses to load unknown versions. |
| `schema_version` | non-negative int | yes | Author-controlled minor version for the workbook's own data shape. Independent from `substrate_version`. |
| `created_at` | ISO-8601 string | optional | Authorial timestamp. Not used by the runtime. |
| `compaction_seq` | non-negative int | yes | Monotonically increasing across compactions. Used to detect stale forks ("this snapshot is older than my latest WAL ops"). Initialized to `0` on first build, incremented by 1 on each successful compaction. |
| `snapshot_cid_by_target` | object | yes | Map from data-container target name (`composition`, `data`, etc.) to the CID of that container's current snapshot. Used as the parent CID for the first WAL op against that target. |

### `workbook_id` generation

ULID (`01J...`) preferred for lexicographic time-sortability. UUIDv4 acceptable. Generated once by `workbook-cli` at first build and persisted in the source manifest (`workbook.config.mjs` or equivalent). NEVER regenerated.

## §2 Snapshots — `<wb-snapshot:TARGET>`

A snapshot is a base64-encoded blob representing the cold state of one data container at a known compaction point.

```html
<script type="application/octet-stream"
        id="wb-snapshot:composition"
        data-cid="blake3-7f9a2b1c..."
        data-format="yjs"
        data-byte-length="1572864">
BASE64_PAYLOAD
</script>
```

### Required attributes

| Attribute | Meaning |
|---|---|
| `id="wb-snapshot:TARGET"` | Element id. `TARGET` is a kebab-case identifier matching a key in `wb-meta.snapshot_cid_by_target`. |
| `data-cid="blake3-HEX"` | Content identifier of the **decoded** snapshot bytes. Format: literal `blake3-` prefix + 32-char lowercase hex (truncated Blake3-256). |
| `data-format="..."` | Format hint for the runtime. v0 reserves: `yjs` (Y.Doc encoded via `Y.encodeStateAsUpdateV2`), `sqlite` (raw SQLite database file bytes), `bytes` (opaque). Unknown formats are passed through to the runtime's container handler. |
| `data-byte-length="N"` | Byte length of the decoded snapshot. Provided for fast integrity checks without requiring full decode. |

### Encoding rules

- **Base64**: standard alphabet (`A-Za-z0-9+/`), padded with `=`. Whitespace permitted between chunks (newlines for readability) and stripped by readers via `.replace(/\s/g, "")` before decode.
- **No HTML escaping needed** inside the script body — `<script type="application/octet-stream">` is treated as a raw text data block by the HTML parser (verified across Chromium / Firefox / WebKit). Base64 alphabet contains no HTML-significant characters.
- **CID computation**: `blake3-` + Blake3-256 hash of the decoded bytes, lowercased, hex, truncated to 32 chars. The runtime MAY use full 64-char CIDs internally; the file format truncates to 32 for compactness.

### Reader contract

```ts
function readSnapshot(target: string): Uint8Array {
  const el = document.getElementById(`wb-snapshot:${target}`);
  if (!el) throw new Error(`missing snapshot: ${target}`);
  const b64 = el.textContent.replace(/\s/g, "");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const expectedCid = el.getAttribute("data-cid");
  const actualCid = `blake3-${blake3_32(bytes)}`;
  if (actualCid !== expectedCid) throw new Error(`snapshot CID mismatch: ${target}`);
  return bytes;
}
```

A workbook with no data MAY omit the snapshots entirely. A workbook may have any number of snapshots, one per target.

## §3 WAL — `<wb-wal>`

JSON array of operation records, ordered by `seq`. The WAL is the hot, append-only log of state mutations since the most recent snapshot per target.

```json
[
  {
    "seq": 1,
    "target": "composition",
    "parent_cid": "blake3-7f9a2b1c...",
    "cid": "blake3-3e8f1a4d...",
    "ts": "2026-05-01T07:00:01.234Z",
    "payload_b64": "AAEC..."
  },
  {
    "seq": 2,
    "target": "data",
    "parent_cid": "blake3-c9d8e7f6...",
    "cid": "blake3-9a0b1c2d...",
    "ts": "2026-05-01T07:00:01.456Z",
    "payload_b64": "AwQF..."
  }
]
```

### Op record schema

| Field | Type | Required | Meaning |
|---|---|---|---|
| `seq` | positive int | yes | Monotonically increasing across the entire WAL (all targets share one seq space). Starts at 1; never reused after compaction. |
| `target` | string | yes | Data-container target this op applies to. Must match a key in `wb-meta.snapshot_cid_by_target` OR be a new target introduced by an earlier op (TBD: target-creation ops in a future minor version). |
| `parent_cid` | string | yes | CID of the prior state for this target — either the snapshot CID (for the first op against that target after compaction) or the previous op's `cid`. The chain provides per-target integrity. |
| `cid` | string | yes | CID of this op's effect — `blake3_32(parent_cid \|\| target \|\| seq_bytes \|\| payload_bytes)`. Verifiable on hydrate. |
| `ts` | ISO-8601 string | optional | Authorial timestamp. Informational; not used for ordering (seq governs). |
| `payload_b64` | base64 string | yes | The op payload in its target-specific format. For `yjs` targets: the bytes of `Y.encodeStateAsUpdateV2`. For `sqlite` targets: the bytes of a SQLite Sessions changeset. |

### Replay invariants

A workbook is **valid** iff:

1. `wb-wal` parses as JSON array.
2. `seq` values are strictly increasing across the array (no duplicates, no gaps allowed at v0).
3. For each `target`, the per-target ops form an unbroken parent-CID chain rooted at the target's snapshot CID (from `wb-meta.snapshot_cid_by_target`).
4. Each op's `cid` matches the recomputed Blake3 over its inputs.

Invariant violations cause the runtime to **refuse load** with a descriptive error. There is no partial-load mode.

### Trailing-op recovery

If a write transaction was interrupted mid-WAL-emit, the file may contain a trailing op that violates invariant 4 (CID computed against incomplete payload) or is structurally malformed. The runtime detects this case as the **last** op failing CID verification and:

1. Discards the trailing op silently (logs to console).
2. Loads the remaining WAL.
3. Marks the workbook as "recovered after interrupted write" (UI may surface this).

A trailing op that *does* CID-verify is treated as committed. Mid-stream invariant violations (op N fails for some N < last) are NOT recoverable — the file is corrupt and the runtime refuses to load.

## §4 Runtime + app — `<script type="module" id="workbook-runtime">` and friends

Out of scope for the format spec. The substrate's job is to extract `wb-meta`, snapshots, and WAL; from there the runtime owns initialization. Authors may add additional script tags, stylesheets, etc. — they are opaque to the substrate format.

## Conflation guard

The format itself does not enforce conflation prevention; the substrate runtime does, using `wb-meta.workbook_id` plus a fingerprint of the file's snapshot bytes as the cache key for any browser-side state (file handles, OPFS shadows, etc.).

The format guarantees that the `workbook_id` is stable across the workbook's lifetime (NEVER regenerated, even on compaction or migration), enabling the runtime to:

1. Distinguish "this file is the same workbook lineage as cache key X" from "this file is something foreign — discard cache".
2. Distinguish "this file has been modified externally since I cached it" (snapshot CID changed) from "this file is bit-identical to what I cached".

See `packages/workbook-substrate/src/identity.ts` (TBD) for the canonical guard implementation.

## Compaction

When the WAL exceeds policy threshold (`compaction_seq` policy is up to the runtime; v0 default = 100 ops or WAL size > 20% of total snapshot size), the runtime:

1. Computes the new in-memory state for each target by replaying current snapshot + WAL.
2. Encodes each target's new state as bytes (`Y.encodeStateAsUpdateV2`, SQLite serialize, etc.).
3. Computes new CIDs.
4. Emits a fresh file with: updated `wb-meta` (new `compaction_seq`, new `snapshot_cid_by_target`), updated `<wb-snapshot>` blocks, empty `<wb-wal>` (or `[]`).
5. Atomically replaces the file via the active transport.
6. Failed compaction (transport rejects, fingerprint mismatch detected) leaves the prior file untouched. Compaction is opportunistic, never required for correctness — the runtime can always replay an arbitrarily long WAL.

## Versioning

`substrate_version` is the format major version. Breaking changes (incompatible op record shape, incompatible CID scheme, incompatible meta fields) require a bump. Within a version, additions are backwards-compatible — readers MUST tolerate unknown optional attributes and unknown `data-format` values for unknown targets.

v0 → v1 migration policy: TBD. Likely "build-time conversion via workbook CLI", since at-rest forward migration is hard without the runtime understanding both versions.

## Open items deferred from v0

- **Polyglot artifact** (file is simultaneously valid HTML and a native executable). Parked in research; substrate v0 is HTML-only.
- **Encrypted regions** for sensitive payloads. Designed-for but not implemented.
- **Multi-writer / sync** — WAL shape supports it (CID chain, Lamport-style seq), but v0 explicitly single-writer.
- **Binary-encoded WAL** (CBOR, msgpack) for size — v0 uses JSON for clarity.
- **Inline asset blobs** (images, fonts > a few KB) — currently must live inside `wb-snapshot:assets` or similar. A separate `<wb-blob>` container type may be useful in v1.

## Conformance

A reader is conformant iff it implements §1–§3 read paths exactly as specified, including:

- All snapshot CID checks.
- All WAL invariant checks (seq monotonic, parent-CID chain, op CID verify).
- Trailing-op recovery as specified.
- Refusal to load on mid-stream invariant violation.
- Recognition of unknown `data-format` values without crashing (deferred to runtime container handlers).

A writer is conformant iff every file it emits passes a conformant reader's load path. The substrate package will publish a conformance test suite (core-1ja.19) that all readers/writers should pass.

## Glossary

- **CID**: Content identifier. Format: `blake3-<32-char hex>`. Truncated Blake3-256 of the addressed bytes.
- **Compaction**: Process of folding the WAL into a fresh snapshot.
- **Conflation guard**: Runtime-side mechanism that prevents one workbook's cached state from leaking into another's view of itself.
- **Container / target**: A named CRDT or database living inside a workbook (e.g., `composition` is typically a Y.Doc, `data` is typically a SQLite DB).
- **Snapshot**: The cold image of a target at a compaction point.
- **WAL**: Write-ahead log; the append-only sequence of post-snapshot mutations.
