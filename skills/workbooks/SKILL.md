---
name: Workbooks authoring
description: Author portable single-file HTML workbooks — `.html` files that ship an inlined WASM runtime (Polars, Candle, SQLite, ML), embed their own gzipped source bundle, and run anywhere a browser runs (file://, USB, email, any host). Use this skill when the user asks to build, edit, or scaffold a workbook; when they mention `workbook init`, `workbook dev`, `workbook build`, `workbook unbundle`; or when they want a portable single-file analytical app, notebook, or document.
---

# Workbooks authoring

A workbook is one HTML file that runs anywhere a browser does. The
artifact is portable + iterable: the CLI compiles your project tree into
a single `.html`, with the source bundled inside (gzipped) so recipients
can `workbook unbundle` it back into a working directory.

```
<slug>.html  =  HTML  +  inlined WASM runtime  +  your code  +  gzipped source bundle
```

Three render shapes — pick the one that matches what the reader does:

| shape       | reader does       | example template                  |
| ----------- | ----------------- | --------------------------------- |
| `document`  | reads prose       | report, memo, narrative           |
| `notebook`  | re-runs cells     | data analysis, ML scratchpad      |
| `spa`       | uses an interface | full single-file app              |

## When to load each reference

This skill is intentionally split. Don't read everything at once.

| If the user wants to…                                | Load                                              |
| ---------------------------------------------------- | ------------------------------------------------- |
| understand the file format itself                    | [references/format.md](references/format.md)      |
| scaffold, dev, build, lint, sign, unbundle           | [references/cli.md](references/cli.md)            |
| publish / manage env vars / groups / per-viewer data | [references/cli.md](references/cli.md)            |
| drive the workbooks portal from Claude / Cursor      | [references/cli.md](references/cli.md) (§ MCP)    |
| call the browser-side runtime (DataFrames, ML)       | [references/runtime.md](references/runtime.md)    |
| fix a `workbook check` rule failure                  | [references/checks.md](references/checks.md)      |
| ship to users (file://, USB, email, web host)        | [references/deploy.md](references/deploy.md)      |
| use the file-as-database substrate (legacy)          | [references/substrate.md](references/substrate.md)|
| copy a working example as a starting point           | [references/examples.md](references/examples.md)  |

## Hard rules

These hold regardless of what the user is building.

1. **One file output.** A workbook is always exactly one `<slug>.html`
   file. No siblings. No `dist/assets/`. The workbook-cli enforces this.

2. **Plain `.html` extension.** Workbook identity is content-based —
   `<meta name="wb-permissions">` and `<script id="wb-meta">` inside
   the file mark it as a workbook, not the filename.

3. **Author with `@work.books/cli`.** Don't hand-write your own bundler.
   The CLI handles WASM inlining, runtime injection, the
   DecompressionStream sandwich, source-bundle embedding, and (when
   requested) the encrypt/sign stages.

4. **Bare `.html` is the canonical artifact.** It runs in any browser
   without anything installed. Source-bundle embedding is on by default
   so the artifact ships with its own iterable source; recipients can
   `workbook unbundle <file.html>` to recover the project tree.

5. **Persistent state lives at workbooks.sh.** The `.html` artifact
   itself is stateless — perfect for one-shot deliverables (a chart, a
   tool, a presentation). Workflows that need login + per-recipient
   state move to the hosted viewer at workbooks.sh; the artifact stays
   portable, the host adds storage.

   When the workbook needs to call a third-party API with a secret key,
   declare the destinations + splice rule in `workbook.config.mjs`:

   ```js
   connect: {
     OPENAI_KEY: { inject: "bearer", domains: ["api.openai.com"] },
   }
   ```

   then call via the SDK:

   ```js
   import { fetch as wb } from "workbook:env";
   const r = await wb("https://api.openai.com/v1/chat/completions", { ... });
   ```

   The author owns the **policy** (which hosts a key may be sent to,
   how it's spliced into the request). A group admin sets the
   **value** in Studio (or via `workbook env set`). The plaintext
   never reaches the browser — the broker proxies the call and
   splices the key in flight.

6. **`workbooksd` is legacy.** The save-in-place daemon still exists
   for installed users, but it's no longer the recommended path. Don't
   propose new daemon work without flagging the pivot. See
   `packages/workbooksd/README.md`.

## Quick-start

```bash
# Author
npm install -g @work.books/cli
workbook init my-thing
cd my-thing
workbook dev      # live-reload server
workbook build    # → dist/my-thing.html (with embedded source bundle)

# Run anywhere
open dist/my-thing.html                                # any browser

# Recover the source from a built artifact
workbook unbundle dist/my-thing.html ./extracted
cd extracted && npm install && workbook dev

# Publish to a group on workbooks.sh
workbook group list                                    # find the group id
workbook env set OPENAI_KEY sk-… --group <gid>         # admin sets values
workbook publish dist/my-thing.html --group <gid>      # → workbooks.sh/w/<id>
```

## From Claude / Cursor / Codex

`@work.books/cli` ships an MCP server so you can drive the whole
workbooks portal — env vars, groups, publish, per-viewer usage —
through tool calls. Add this to your MCP client config:

```json
{ "mcpServers": { "workbooks": { "command": "workbook", "args": ["mcp", "serve"] } } }
```

Tools exposed include `workbooks_groups_list`, `workbooks_env_set`,
`workbooks_env_import`, `workbooks_publish`, `workbooks_workbook_views`,
`workbooks_workbook_revoke`. Auth defaults to `WORKBOOKS_API_TOKEN` for
headless use; falls back to a cached browser session.

Build flags worth knowing:

```
workbook build
  --no-bundle      skip embedding the source (smaller .html, no `unbundle`)
  --bundle-git     include the .git/ directory in the source bundle
  --no-wasm        skip wasm + runtime inlining (dev-only, smaller files)
  --encrypt        wrap in a passphrase lock screen (age-v1)
```

## Disambiguation — workbooks vs HyperFrames vs Signal

If the user mentions "workbooks" and you see other skills loaded, this
skill is for the workbook file format specifically. It is NOT:

- HyperFrames (video composition with `data-start`/`data-duration`) —
  that's a separate skill at `~/.claude/skills/hyperframes/`.
- Signal's "workbook agent" / convex schema — Signal is a SaaS host
  for workbooks; this skill is about the workbook format itself.

When in doubt, look for `<meta name="wb-permissions">` or
`<script id="wb-meta">` inside an `.html` file — that's a workbook,
this skill.

## Source of truth

- Repo: <https://github.com/shinyobjectz-sh/workbooks>
- Spec: `docs/SPEC.md` in that repo
- Examples: `examples/` in that repo (chess, earthquakes, stocks, etc.)
- CLI on npm: `@work.books/cli`
- Hosted viewer (for persistent / multi-user workflows): <https://workbooks.sh>
