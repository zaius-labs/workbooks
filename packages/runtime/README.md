# @workbook/runtime

Svelte 5 UI runtime for workbooks — the components that render the workbook block tree. Used in two contexts:

1. **Live mode**: imported as a workspace package, mounted inside a host app
2. **Exported mode** (.workbook files): bundled to a CDN-deployable ESM module that the exported HTML imports at `<your-cdn>/@workbook/runtime/v1.js`

Both contexts use the **same components** — there is no separate static-render path. See [`docs/SPEC.md`](../../docs/SPEC.md) > Rendering & Components.

## What's in here

| File | Purpose |
|---|---|
| `src/Workbook.svelte` | Root component — reads manifest, walks block tree |
| `src/WorkbookBlock.svelte` | Block dispatcher — maps each block kind to its component |
| `src/workbookContext.ts` | Context store for data references (block lookup, citations) |
| `src/blocks/*.svelte` | One Svelte component per block kind |

## Build

```bash
bun run build         # produces dist/workbook-runtime.js
bun run typecheck     # svelte-check
```

## Migration status

This package is being filled incrementally. Today's contents:

- ✅ Display blocks (no runtime data fetching): Heading, Paragraph, Markdown, Callout, Divider, Code, Diagram, Chart, Metric, Metrics, Table, Concept, Step, Machine, Widget, Network, Geo, Embedding3D
- ✅ Root: Workbook.svelte, WorkbookBlock.svelte, workbookContext.ts
- ⏸️ Convex-coupled blocks (need peer-dep decoupling first): File, Image, Video, Input
- ⏸️ App-specific UI: ArtifactChip, PlanWidget, WorkbookToolbar, CitationReport (stay in apps/web)

## Reference

- `docs/WORKBOOK_SPEC.md` — format spec, block catalog, rendering architecture
- `docs/WORKBOOK_REFACTOR.md` — phase plan; this package is P1.2
