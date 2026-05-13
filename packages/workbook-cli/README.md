# @workbook/cli

Build tool for workbooks. Compiles a multi-file source tree (HTML, JS,
CSS, Svelte components) into a **single, self-contained
`.html`** that runs from `file://` with no server, no CDN, and
no `dist/` siblings.

## Why

Hand-writing workbooks as one giant `index.html` is the simplest path —
chat-app is the canonical example — but it doesn't scale. Multi-page
apps, framework-based apps (Svelte, etc.), and anything that benefits
from a real component model need a build step. This CLI provides one
without sacrificing the single-file artifact at the end.

## Install

```bash
npm install -g @work.books/cli
# → adds the `workbook` command to PATH
```

Or use it ad-hoc:

```bash
bunx -p @work.books/cli workbook <command>
npx  -p @work.books/cli workbook <command>
```

## Project layout

```
my-workbook/
  workbook.config.mjs    # manifest: name, slug, entry, env, runtime features
  src/
    index.html           # entry — references main.js / main.svelte / etc.
    main.js
    components/...
    styles/...
```

Minimum config:

```js
// workbook.config.mjs
export default {
  name: "my workbook",
  slug: "my-workbook",
  entry: "src/index.html",
};
```

Optional icon — single path or array of `{ src, sizes?, type? }`. Inlined as a data URL so the saved `.html` ships with its own browser-tab icon:

```js
icon: "src/icon.svg",                              // short form
// or
icons: [
  { src: "src/icon-32.png",  sizes: "32x32",   type: "image/png" },
  { src: "src/icon-192.png", sizes: "192x192", type: "image/png" },
],
```

If neither `icon` nor `icons` is provided, the build injects a default
workbook glyph so every saved file has a recognizable favicon. Author
HTML that already declares `<link rel="icon">` opts out automatically.

Note: this only controls the **browser** icon (tab, bookmark). The OS
file icon for `.html` files in Finder/Explorer requires
platform-level registration and is intentionally out of scope here.

## Commands

Authoring:

```
workbook init <name>      scaffold a new project (--template=spa|notebook|document)
workbook dev   [project]  Vite dev server with HMR (default :5173)
workbook build [project]  compile → dist/<slug>.html (single file)
workbook check [project]  lint the source tree
workbook explain <rule>   rationale + fix recipe for a check rule
workbook encrypt          wrap a payload in a passphrase lock (age-v1)
workbook unbundle <html>  extract the embedded source bundle
workbook keygen           generate an Ed25519 author keypair
```

Publishing + control plane (talks to auth.workbooks.sh):

```
workbook publish <html>     upload to workbooks.sh/w/<id>  [--group <gid>]
workbook env <action>       manage group env vars (list/set/rotate/delete/import)
workbook group <action>     list groups, members, workbooks, invite teammates
workbook mcp serve          stdio MCP server — drive everything from Claude / Cursor
```

Auth: first time you run a publish/env/group/mcp command it opens a
browser for a one-time OAuth and caches a bearer at
`~/.config/workbooks/auth.json`. For CI / headless use, set
`WORKBOOKS_API_TOKEN=wbat_...` (create one in Studio → Settings).

Build flags:

```
--port <n>      dev server port (default 5173)
--out <dir>     build output dir (default dist)
--no-wasm       skip inlining wasm + runtime bundle (smaller, dev-only)
--no-bundle     skip embedding the gzipped source bundle in the artifact
--bundle-git    include .git/ when embedding the source bundle
--encrypt       wrap the built artifact in an age-v1 passphrase gate
```

## Driving Workbooks from Claude / Cursor / Codex

The same install ships an MCP server. Add to your MCP client config:

```json
{
  "mcpServers": {
    "workbooks": { "command": "workbook", "args": ["mcp", "serve"] }
  }
}
```

Tools exposed: `workbooks_groups_list`, `workbooks_group_members`,
`workbooks_group_workbooks`, `workbooks_group_invite`,
`workbooks_env_list`, `workbooks_env_set`, `workbooks_env_rotate`,
`workbooks_env_delete`, `workbooks_env_import`, `workbooks_publish`,
`workbooks_workbook_views`, `workbooks_workbook_revoke`.

## Secrets that workbooks call out with

The author declares **policy** — which hosts a key may be sent to and
how to splice it into the request — in `workbook.config.mjs`:

```js
export default {
  // ...
  connect: {
    OPENAI_KEY:  { inject: "bearer",               domains: ["api.openai.com"] },
    HUBSPOT_PAT: { inject: "header:Authorization", domains: ["api.hubapi.com"] },
  },
};
```

A group admin sets **values** in Studio (or via `workbook env set`).
The workbook calls upstream APIs through the SDK:

```js
import { fetch as wb } from "workbook:env";
const r = await wb("https://api.openai.com/v1/chat/completions", { ... });
```

The broker splices the value in flight. Plaintext never reaches the
browser; recipients never see the key.

## What `build` does

1. Vite bundles your entry + all imports into a single HTML payload
   (`vite-plugin-singlefile` collapses JS + CSS into the HTML).
2. The workbook plugin reads the wasm-bindgen JS, the runtime bundle,
   and the wasm bytes from the sibling `runtime-wasm/pkg/`, and
   inlines them as `<script type="text/plain">` blocks under
   `<!-- portable-assets-begin --> ... <!-- portable-assets-end -->`.
3. The same plugin emits a `<script id="workbook-spec">` JSON blob
   carrying the manifest (slug, env declarations, runtime features).
4. The output is renamed `<slug>.html`. That's it.

A `boot` shim in your entry HTML can detect the inlined assets and
load wasm via `URL.createObjectURL` + dynamic `import()` — the
chat-app pattern. Or you can use the virtual import:

```js
import { wasm, bundle, initWasm } from "virtual:workbook-runtime";
await initWasm();
const out = wasm.runPolarsSql("SELECT * FROM data", csv);
```

In dev that resolves to direct imports of the runtime files. In build
it picks up the inlined data via `URL.createObjectURL`.

## Trigger-substring discipline

The CLI carefully avoids writing literal `<!--`, `-->`, `<script`,
`</script>`, `</style>`, `</head>` substrings into source files —
those put the page's HTML parser into "script data escaped" state and
can prematurely close the script tag in the generated artifact. All
trigger substrings are assembled at runtime (see
`src/util/triggerSafe.mjs`).

## Links

- Hosted viewer + portal: <https://workbooks.sh>
- Studio (publish, env vars, members, usage): <https://studio.workbooks.sh>
- Source: <https://github.com/shinyobjectz-sh/workbooks>
