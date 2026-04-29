# @workbook/cli

Build tool for workbooks. Compiles a multi-file source tree (HTML, JS,
CSS, Svelte components) into a **single, self-contained
`.workbook.html`** that runs from `file://` with no server, no CDN, and
no `dist/` siblings.

## Why

Hand-writing workbooks as one giant `index.html` is the simplest path —
chat-app is the canonical example — but it doesn't scale. Multi-page
apps, framework-based apps (Svelte, etc.), and anything that benefits
from a real component model need a build step. This CLI provides one
without sacrificing the single-file artifact at the end.

## Install

Inside the workbooks monorepo:

```bash
npm install
# CLI is available at packages/workbook-cli/bin/workbook.mjs
```

(Standalone npm publish: TBD.)

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

Optional icon — single path or array of `{ src, sizes?, type? }`. Inlined as a data URL so the saved `.workbook.html` ships with its own browser-tab icon:

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
file icon for `.workbook.html` files in Finder/Explorer requires
platform-level registration and is intentionally out of scope here.

## Commands

```
workbook dev             # Vite dev server with HMR
workbook build           # → dist/<slug>.workbook.html (single file)
workbook init <name>     # (todo) scaffold a project
```

Flags:

```
--port <n>      dev server port (default 5173)
--out <dir>     build output dir (default dist)
--runtime <p>   override path to workbook-runtime checkout
--no-wasm       skip inlining wasm + bundle (smaller, dev-only)
```

## What `build` does

1. Vite bundles your entry + all imports into a single HTML payload
   (`vite-plugin-singlefile` collapses JS + CSS into the HTML).
2. The workbook plugin reads the wasm-bindgen JS, the runtime bundle,
   and the wasm bytes from the sibling `runtime-wasm/pkg/`, and
   inlines them as `<script type="text/plain">` blocks under
   `<!-- portable-assets-begin --> ... <!-- portable-assets-end -->`.
3. The same plugin emits a `<script id="workbook-spec">` JSON blob
   carrying the manifest (slug, env declarations, runtime features).
4. The output is renamed `<slug>.workbook.html`. That's it.

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

## Status

v0.1 — works for the `examples/svelte-app/` reference project.
Standalone npm publish + `workbook init` scaffolding are TBD.
