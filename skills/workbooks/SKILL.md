---
name: Workbooks authoring
description: Author .workbook.html files — single-file HTML documents that ship a real WASM runtime (Polars, Candle, SQLite, ML), save themselves in place via workbooksd, and run from file://, USB, email, or any browser. Use this skill when the user asks to build, edit, or scaffold a workbook; when they mention `.workbook.html`, `workbook init`, `workbook dev`, `workbook build`; or when they want a portable single-file analytical app, notebook, or document.
---

# Workbooks authoring

A workbook is one HTML file that runs anywhere a browser does and saves
itself in place when the local **workbooksd** runtime is installed.

```
.workbook.html  =  HTML  +  inlined WASM runtime  +  your code
```

Three render shapes — pick the one that matches what the reader does:

| shape       | reader does       | example template                  |
| ----------- | ----------------- | --------------------------------- |
| `document`  | reads prose       | report, memo, narrative           |
| `notebook`  | re-runs cells     | data analysis, ML scratchpad      |
| `spa`       | uses an interface | full single-file app              |

## When to load each reference

This skill is intentionally split. Don't read everything at once.

| If the user wants to…                           | Load                                              |
| ----------------------------------------------- | ------------------------------------------------- |
| understand the file format itself               | [references/format.md](references/format.md)      |
| scaffold, dev, build, lint, sign                | [references/cli.md](references/cli.md)            |
| call the browser-side runtime (DataFrames, ML)  | [references/runtime.md](references/runtime.md)    |
| fix a `workbook check` rule failure             | [references/checks.md](references/checks.md)      |
| ship to users (workbooksd, file://, web)        | [references/deploy.md](references/deploy.md)      |
| use the file-as-database substrate              | [references/substrate.md](references/substrate.md)|
| copy a working example as a starting point      | [references/examples.md](references/examples.md)  |

## Hard rules

These hold regardless of what the user is building.

1. **One file output.** A workbook is always exactly one `.workbook.html`
   file. No siblings. No `dist/assets/`. The workbook-cli enforces this.

2. **`.workbook.html` extension.** The double-extension is the contract.
   It's matched by the workbooksd path validator, the macOS file-type
   association, and the lander's download flow. Don't rename it to
   `.html` or anything else.

3. **No `workbook-runner`.** The legacy C polyglot is removed. If you
   see `workbook-runner` or `cosmocc` in any active code path, that
   reference is stale — it was replaced by `packages/workbooksd` (a
   small Rust background daemon).

4. **Author workbooks with `@work.books/cli`.** Don't hand-write your
   own bundler. The CLI handles WASM inlining, runtime injection, the
   DecompressionStream sandwich, save handler, and install toast.

5. **Install Workbooks once, edit any workbook anywhere.** The save
   contract is: when `workbooksd` is running and the page is loaded
   via `http://127.0.0.1:47119/wb/<token>/`, ⌘S writes the file in
   place atomically. When it isn't, the workbook still renders;
   it's read-only.

## Quick-start

```bash
# Author
npm install -g @work.books/cli
workbook init my-thing
cd my-thing
workbook dev      # live-reload server
workbook build    # → dist/my-thing.workbook.html

# Run anywhere
open dist/my-thing.workbook.html        # without workbooksd: read-only
workbooksd open dist/my-thing.workbook.html  # with workbooksd: edit + save
```

## Disambiguation — workbooks vs HyperFrames vs Signal

If the user mentions "workbooks" and you see other skills loaded, this
skill is for `.workbook.html` files specifically. It is NOT:

- HyperFrames (video composition with `data-start`/`data-duration`) —
  that's a separate skill at `~/.claude/skills/hyperframes/`.
- Signal's "workbook agent" / convex schema — Signal is a SaaS host
  for workbooks; this skill is about the workbook format itself.

When in doubt, look at file extensions: `.workbook.html` → this skill.

## Source of truth

- Repo: <https://github.com/shinyobjectz-sh/workbooks>
- Spec: `docs/WORKBOOK_SPEC.md` in that repo
- Examples: `examples/` in that repo (chess, earthquakes, stocks, etc.)
- Daemon: <https://workbooks.sh>
