> **Note:** Some sections below describe the original polyglot APE-binary
> runner (`packages/workbook-runner`), which has been replaced by
> `packages/workbooksd` — a small Rust background daemon that serves
> workbooks over localhost. The substrate transport contract still
> applies; only the host process changed. See packages/workbooksd/
> for the current implementation.

# Workbook Substrate

**Status:** v0 — released for early adopters; format may evolve, runtime contract is stable.

The substrate is the file-as-database persistence layer for workbook applications. A `.html` file is, simultaneously:

1. A valid HTML5 document.
2. The canonical container of a workbook's complete state — yjs CRDT bytes for the spec/composition, optionally SQLite bytes for relational data, optionally other typed data containers.
3. An append-only ledger of state mutations, periodically compacted back into snapshots.

Two readers of the same file — anywhere, anytime, on any machine — hydrate to the same in-memory state. The file *is* the database.

## Reading order

If you're new to the substrate, read these docs in order:

1. **This document** — architecture overview, what fits where.
2. [`SUBSTRATE_FORMAT_V0.md`](SUBSTRATE_FORMAT_V0.md) — the wire contract.
3. [`SUBSTRATE_AUTHORING.md`](SUBSTRATE_AUTHORING.md) — how to ship a workbook on the substrate.

## What ships in @work.books/substrate

| Module | Surface | What it does |
|---|---|---|
| `parse.ts` | `parseSubstrateFromHtml`, `parseSubstrateFromDocument` | Parse + verify the substrate slots from an HTML file. Validates meta schema, snapshot CIDs, WAL seq monotonicity, parent-CID chain integrity. Recovers from a corrupted trailing op. |
| `cid.ts` | `cidOf`, `opCid`, `opCidSync` | CID computation. v0 uses Web Crypto SHA-256 truncated to 32 hex chars; the prefix `blake3-` is reserved for the eventual swap to Blake3. |
| `mutate.ts` | `createMutator`, `bindYjsAutoEmit`, `bindSqliteSessionAutoEmit` | In-memory WAL state + commit API. Auto-bind helpers route yjs Y.Doc updates and SQLite Sessions changesets into substrate WAL ops. |
| `compact.ts` | `compact`, `shouldCompact` | Fold WAL into fresh snapshots. Engine-agnostic — caller provides the per-target encoder. |
| `identity.ts` | `MemoryIdentityStore`, `migrateIdentity`, `gcOrphans` | Browser-side cache key = `(workbook_id, fingerprint)`. Atomic migrate on compaction. Orphan GC. |
| `transport.ts` + `transports/` | `negotiate`, `PwaFsaTransport`, `FsaSessionTransport`, `OpfsDownloadTransport`, `ReadOnlyTransport` | Pluggable transport layer. Each tier implements `commitPatch({expectedFingerprint, newImage, mode})`. The negotiator picks the strongest available at runtime. |
| `install-banner.ts` | `mountInstallBanner` | Vanilla-JS toast embedded in every workbook. Detects non-PWA context, offers Install / Save File / Not now. |
| `hydrate.ts` | `hydrateYjsTarget`, `hydrateSqliteTarget` | Convenience helpers — apply substrate snapshots + WAL ops to a Y.Doc / SQLite DB. |

## Runtime contract

A workbook's bootstrap, simplified:

```ts
import * as Y from "yjs";
import {
  parseSubstrateFromDocument, createMutator, bindYjsAutoEmit,
  negotiate, compact, shouldCompact,
} from "@work.books/substrate";

// 1. Wait for runtime → Y.Doc
const doc = await getDocFromRuntime();

// 2. Parse the file
const file = await parseSubstrateFromDocument(document);

// 3. Hydrate Y.Doc from snapshot + WAL
Y.applyUpdateV2(doc, file.snapshots.get("composition")?.bytes ?? new Uint8Array(0));
for (const op of file.wal) if (op.target === "composition") Y.applyUpdateV2(doc, op.payload);

// 4. Pick a transport
const { transport } = await negotiate({ workbookId: file.meta.workbook_id });

// 5. Wire the mutator — auto-emit WAL ops on Y.Doc updates
const mutator = createMutator(file);
bindYjsAutoEmit(mutator, { Y, doc, target: "composition" });

// 6. Debounce + commit
let timer = null;
mutator.onCommit(() => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (shouldCompact(mutator.file)) {
      const compacted = await compact(mutator.file, {
        encode: async () => Y.encodeStateAsUpdateV2(doc),
      });
      mutator.replaceFile(compacted);
    }
    const html = await assembleHtmlImage(mutator.file);
    await transport.commitPatch({
      expectedFingerprint: mutator.file.fingerprint,
      newImage: { html, byteLength: html.length, fingerprint: mutator.file.fingerprint },
      mode: "rewrite-required",
    });
  }, 250);
});
```

Color.wave's `apps/colorwave/src/lib/substrateBackend.svelte.js` is a reference implementation.

## Transport tiers

```
T1 — Localhost runner        silent autosave (polyglot APE binary)
T2 — PWA-installed FSA       silent autosave (PWA file_handler) — DEPRECATED
T3 — Per-session FSA         one click per tab → silent
T4 — OPFS shadow + download  click "Download" to commit
T5 — Read-only               nothing works; honest fallback
```

T1 is the canonical desktop path: the workbook ships as a polyglot
binary (see `@work.books/runner`); when launched, the binary spawns
a localhost server, opens the user's browser, and silently rewrites
itself on every save. T2 (PWA shell) is deprecated in favor of T1
because the polyglot path needs no install and no `workbooks.sh`
infrastructure. T3/T4/T5 remain as graceful degradation for users on
mobile or unsupported browsers (the HTML version of the workbook
opens directly in their browser).

The negotiator picks the strongest available. See [`SUBSTRATE_AUTHORING.md`](SUBSTRATE_AUTHORING.md) for transport-specific UX.

## Conflation guarantees

The substrate is structured so that **two distinct workbooks can never trample each other**, and **stale browser-side cache cannot override what the file says**.

- Each workbook has a stable `workbook_id` baked at build time. Never regenerated.
- All browser-side state (FSA file handles, OPFS shadow buffers) is keyed by `(workbook_id, fingerprint(snapshot bytes))`.
- Open a different workbook → no key match → no contamination.
- File modified externally → fingerprint changed → no key match → load from file, ignore cache.
- Compaction → atomically migrate cache key from old fingerprint to new.

This is enforced by the runtime, not the format. The format simply provides the identity primitives (`workbook_id` in `<wb-meta>`, snapshot CIDs in `<wb-snapshot:*>`).

## Browser support matrix

| Browser            | T2 PWA-FSA | T3 session FSA | T4 OPFS+download | T5 read-only |
|--------------------|------------|----------------|------------------|--------------|
| Chrome / Edge / Opera (desktop) | ✓ | ✓ | ✓ | ✓ |
| Firefox (desktop)  | (gating on PWA install + file_handlers) | ✓ flagged | ✓ | ✓ |
| Safari (desktop)   | (gating on file_handlers) | partial | ✓ | ✓ |
| iOS Safari / Chrome iOS | — | — | partial (download fallback) | ✓ |
| Android Chrome     | ✓ (file_handlers in standalone) | ✓ | ✓ | ✓ |

If your target user is on a browser without FSA, the workbook still loads, edits still work in-memory, and the user explicitly downloads the updated file when they want to commit. No silent data loss.

## What's NOT in the substrate

- **No network sync.** v0 is single-writer-only. The WAL shape supports merging multiple writers in v1, but v0 ships without it.
- **No encryption.** A future revision may add encrypted regions.
- **No mobile authoring.** Mobile browsers can READ workbooks (T4 download flow); writing requires desktop until iOS gives PWAs file-handler access.

## What v0 explicitly defers

- **Polyglot HTML+executable artifact.** Researched and parked — the OS-level dispatch problem (browsers always open `.html` in a browser, never as an executable) blocks the UX win. Tracked as research, not roadmap.
- **Binary-encoded WAL.** v0 uses JSON-encoded ops for human readability and easier tooling. v1 may swap to CBOR/msgpack for size if real-world workbooks pressure the WAL byte budget.
- **Multi-doc workbooks.** v0 supports multiple data targets (`composition`, `data`, custom) but treats them as belonging to one workbook. Cross-workbook references / linking are out of scope.

## Versioning

Format major versions are `v0`, `v1`, etc. (see `<meta name="workbook-substrate" content="v0">` and `<wb-meta>.substrate_version`). The runtime refuses to load files whose `substrate_version` it doesn't understand. Within a version, additive changes are tolerated.

`schema_version` is author-controlled — independent of `substrate_version`. Use it for your workbook's own data shape evolution.

## Getting started

```sh
# Install
npm install @work.books/substrate

# Or as a workspace dependency in a workbook app:
"@work.books/substrate": "workspace:*"

# Add a vite plugin to your workbook build:
import { substratePlugin } from "@work.books/cli/vite";
export default {
  vite: { plugins: [substratePlugin()] }
};
```

The plugin generates a `.workbook-id` in your project root on first build (commit this file — it's the workbook's identity) and injects substrate slots into the built HTML.

See [`SUBSTRATE_AUTHORING.md`](SUBSTRATE_AUTHORING.md) for the full authoring guide.

## Project status

Tracked under bd epic `core-1ja`. Spike findings live in `vendor/workbooks/packages/workbook-substrate/spikes/`.
