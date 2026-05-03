# Substrate Authoring Guide

How to ship a workbook on the substrate. Written for workbook authors, not contributors to the substrate package itself (for that, see [`SUBSTRATE.md`](SUBSTRATE.md)).

## TL;DR

Add a vite plugin, declare your data targets, embed the install banner. The substrate handles persistence; you write your app.

## 1. Install + configure

```sh
npm install @work.books/substrate
```

In your `workbook.config.mjs`:

```js
import { substratePlugin } from "@work.books/cli/vite";

export default {
  name: "my-workbook",
  slug: "my-workbook",
  type: "spa",
  entry: "src/index.html",
  vite: {
    plugins: [substratePlugin({ schemaVersion: 0 })],
  },
};
```

On first build, the plugin generates `.workbook-id` in your project root. **Commit this file** — it's your workbook's permanent identity. Regenerating it (or building the same workbook from a fork without committing the file) would create a *different* workbook lineage that breaks user save state.

## 2. Bootstrap from the substrate

Your app's main entry point should bootstrap the substrate before mounting your UI. Reference: `apps/colorwave/src/main.js` and `apps/colorwave/src/lib/substrateBackend.svelte.js`.

A minimal version:

```js
import * as Y from "yjs";
globalThis.__wb_yjs = Y; // share Yjs with the workbook runtime

import { mount } from "svelte";
import { loadRuntime } from "virtual:workbook-runtime";
import {
  parseSubstrateFromDocument,
  createMutator,
  bindYjsAutoEmit,
  negotiate,
  compact, shouldCompact,
} from "@work.books/substrate";

// Y.Doc handle from the workbook runtime
const { wasm, bundle } = await loadRuntime();
await bundle.mountHtmlWorkbook({ loadWasm: () => Promise.resolve(wasm) });
const doc = window.__wbRuntime.getDocHandle("hyperframes-state").doc;

// Parse the file
const file = await parseSubstrateFromDocument(document);

// Hydrate
const compSnap = file.snapshots.get("composition");
if (compSnap) Y.applyUpdateV2(doc, compSnap.bytes);
for (const op of file.wal) if (op.target === "composition") Y.applyUpdateV2(doc, op.payload);

// Persistence
const { transport } = await negotiate({ workbookId: file.meta.workbook_id });
const mutator = createMutator(file);
bindYjsAutoEmit(mutator, { Y, doc, target: "composition" });

// Debounced commit-on-mutation
let timer;
mutator.onCommit(() => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (shouldCompact(mutator.file)) {
      mutator.replaceFile(await compact(mutator.file, {
        encode: async () => Y.encodeStateAsUpdateV2(doc),
      }));
    }
    const html = assembleImage(mutator.file);
    await transport.commitPatch({
      expectedFingerprint: mutator.file.fingerprint,
      newImage: { html, byteLength: html.length, fingerprint: mutator.file.fingerprint },
      mode: "rewrite-required",
    });
  }, 250);
});

// Mount your app
const { default: App } = await import("./App.svelte");
mount(App, { target: document.getElementById("app") });
```

The `assembleImage(file)` helper assembles a fresh HTML image — your shell HTML with substrate slots replaced by current snapshots/WAL. Color.wave's reference implementation lives at `apps/colorwave/src/lib/substrateBackend.svelte.js#_buildImage`.

## 3. Multiple data targets

A workbook can have any number of data targets. The two most common:

- `composition` — the spec / authored content. Backed by yjs Y.Text or Y.Doc.
- `data` — relational data. Backed by SQLite via Sessions changesets.

Each target gets its own `<wb-snapshot:TARGET>` block on disk. The mutator emits ops scoped to a target; transports persist all targets in one file rewrite per commit.

For a SQLite target, swap `bindYjsAutoEmit` for `bindSqliteSessionAutoEmit`:

```js
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

const sqlite3 = await sqlite3InitModule();
const db = new sqlite3.oo1.DB(":memory:", "ct");

// Hydrate
const dataSnap = file.snapshots.get("data");
if (dataSnap?.format === "sqlite") {
  // sqlite3_deserialize via hydrateSqliteTarget helper
  hydrateSqliteTarget(sqlite3, file, "data", { db });
}

// Auto-emit changesets
const sqliteBinding = bindSqliteSessionAutoEmit(mutator, {
  sqlite3,
  db,
  target: "data",
  trigger: { kind: "interval", ms: 1000 },
});
```

## 4. Install banner

Drop the banner into your bootstrap so users in non-PWA contexts see the "Install Workbooks for autosave" CTA:

```js
import { mountInstallBanner } from "@work.books/substrate";

mountInstallBanner({
  workbookId: file.meta.workbook_id,
  onSaveFileClick: async () => {
    if (transport.prepare) await transport.prepare();
    await commitNow(); // your commit function
  },
});
```

The banner self-detects PWA context (`display-mode: standalone`) and `window.__wbInbound` (set by the PWA shell when launching files via file_handlers). It's a no-op in PWA contexts.

## 5. Status indicator

Read the active transport's status to surface a "saved / needs permission / download" indicator in your chrome:

```ts
const sem = transport.semantics(); // { tier, status, ... }
transport.onStatusChange?.((s) => {
  // s = "saved-in-file" | "needs-permission" | "download-to-keep" | "read-only"
});
```

Color.wave's `MenuBar.svelte` is a working example: a small dot+label pill next to the version chip, with a click handler that routes to `commitNow()` for actionable states.

## 6. Cmd+S handling

The runtime's save handler intercepts Cmd+S and calls `window.workbookSave()`. Wire it to your commit function:

```js
window.workbookSave = async () => {
  await commitNow();
};
```

## What you DON'T need to handle

- **CID computation.** The substrate computes per-op CIDs internally.
- **Integrity checks.** `parseSubstrateFromDocument` rejects corrupt files; the substrate's runtime ignores trailing-op corruption (recovered automatically).
- **Conflation prevention.** Browser-side cache keying is handled by the substrate's identity layer; you never key state by URL or origin.
- **PWA file_handlers wiring.** The PWA shell (`@work.books/shell`) handles the launchQueue plumbing; your workbook doesn't need to know about it.

## Common pitfalls

**1. Do NOT regenerate the workbook ID per build.**
The `.workbook-id` file is the workbook's identity. Every fresh build of the same workbook should have the same ID. Otherwise users' saves silently belong to "a different workbook" and their state vanishes.

**2. Do NOT key any IndexedDB data by URL or origin.**
The substrate's identity guard relies on `(workbook_id, fingerprint)` as the only key. Other keys leak across workbooks of the same origin.

**3. Do NOT try to write directly via `fetch` or other APIs.**
The substrate transport layer has the only sanctioned write path. Adding a side channel breaks the conflation guarantees and the integrity chain.

**4. Compact when warranted.**
The default policy (`shouldCompact`) is sane, but if your workbook has unusual patterns (very large ops, or extremely small ops at high frequency), tune it. WAL bytes growing past 20% of snapshot bytes triggers compaction; you can override.

**5. Test write-through against real FSA semantics, not just OPFS.**
OPFS is a useful proxy for FSA in benchmarks but not a 100% match for atomicity edge cases. Test in actual `showSaveFilePicker` flows on staging before shipping.

## Reference workbook: color.wave

The canonical reference implementation lives in `apps/colorwave/`:

- `src/main.js` — bootstrap order
- `src/lib/substrateBackend.svelte.js` — substrate wiring + image assembly
- `src/lib/autoSave.svelte.js` — Cmd+S + status pipe
- `src/lib/legacyMigration.svelte.js` — one-time pre-substrate IDB → file export
- `src/components/MenuBar.svelte` — status indicator pill UI

Read these in that order if you want a working example.

## Open product questions for authors

- **What workbook id format?** Default ULID-style is fine for most workbooks. If your build pipeline already has stable identifiers (UUIDs from a service, semantic IDs from a CMS), use those — just commit the `.workbook-id` file.
- **What debounce?** 250ms is the substrate default (color.wave uses this). Tune up to 1000ms for very large workbooks (>25MB) where each commit cost is non-trivial.
- **Compaction triggers?** Default = WAL > 20% of snapshot OR > 500 ops. Override via `shouldCompact(file, customCheck)`.

## Related docs

- [`SUBSTRATE.md`](SUBSTRATE.md) — high-level architecture
- [`SUBSTRATE_FORMAT_V0.md`](SUBSTRATE_FORMAT_V0.md) — wire format
- `vendor/workbooks/packages/workbook-substrate/spikes/` — feasibility studies
- `vendor/workbooks/packages/workbook-shell/README.md` — PWA shell hosting + install
