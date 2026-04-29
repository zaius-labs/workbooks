# Authoring a workbook

Workbooks are a **format**, not a framework. The runtime + build tool
are open about how you author the source — pick whatever shape and
tooling matches the work, get the same `.workbook.html` artifact at
the end.

This document is the umbrella reference. Two axes:

- **Shape**: what kind of artifact is this? `document`, `notebook`, `spa`.
- **Authoring style**: how do you write the source? Vanilla JS in one
  file, Svelte components, mdsvex markdown, raw HTML.

Pick one of each. They compose.

---

## TL;DR — decision tree

```
Q: what is the reader of this workbook supposed to do?
├── read it (prose-heavy, citations, charts) ──→  shape = "document"
├── re-run it, edit inputs, see updated outputs ──→  shape = "notebook"
└── use it as an interactive app (chat, editor, dashboard, …) ──→  shape = "spa"

Q: how big / complex is the source?
├── < ~400 lines, single concept ──→  hand-written index.html (vanilla JS or raw HTML)
├── multi-page or component-heavy ──→  Svelte + @work.books/cli
├── prose-heavy with embedded computation ──→  mdsvex (.svx) + @work.books/cli
└── utility-CSS-heavy UI ──→  Svelte + Tailwind v4 + @work.books/cli
```

Same `.workbook.html` output across every combination. The format
doesn't care which path you took.

---

## The matrix

|  | **document** | **notebook** | **spa** |
|---|---|---|---|
| **Vanilla single-file** (one `index.html`) | `examples/html-workbook/` | `examples/reactive-cells/`, `examples/runner/` | `examples/chat-app/` |
| **Raw HTML + cells** | `examples/html-agent/` | (uses `<wb-cell>` directly) | (write your own UI) |
| **Svelte** (multi-file build) | — | — | `examples/svelte-app/`, `examples/notebook-agent/` |
| **Svelte + Tailwind** | — | — | `examples/tailwind-app/` |
| **mdsvex** (markdown + Svelte) | `examples/document-mdx/` | `examples/notebook-mdx/`, `examples/dependency-chain/` | (rare — wrap markdown in any layout) |

Empty cells aren't gaps in capability — they're just shapes for
which one of the other styles is a better fit. Nothing stops you
from writing a document workbook in raw HTML or a notebook in
vanilla JS; the matrix shows the **canonical** path per cell.

---

## Lane 1 — Vanilla single-file

One `index.html`, inline `<script type="module">`, hand-written
HTML/CSS/JS. View-source on the rendered page IS the source. No
toolchain. No `node_modules/`. No build step.

```html
<!DOCTYPE html>
<html>
  <head>
    <title>my workbook</title>
    <style>/* ... */</style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module">
      import * as wasm from "../../pkg/workbook_runtime.js";
      import { runAgentLoop, createBrowserLlmClient }
        from "../reactive-cells/runtime.bundle.js";

      await wasm.default();
      // ... your app
    </script>
  </body>
</html>
```

**When to choose**: small concept demos, inspectable references, one-
off internal tools. Anything where someone reading the source on
the web should see exactly what's running.

**When to leave**: when the source crosses ~500 lines and the inline
`<script>` becomes a god-object. Move to Svelte.

**Reference exemplar**: `examples/chat-app/` — 1400-line full chat
agent SPA, view-source works end-to-end. Save-as-portable runs in
the browser via the inline saver.

---

## Lane 2 — Raw HTML + workbook custom elements

Same as Vanilla, but you use the workbook's own HTML grammar:
`<wb-cell>`, `<wb-input>`, `<wb-output>`, `<wb-chat>`, `<wb-agent>`.
The runtime parses these and wires up cells without you writing a
component model.

```html
<wb-input name="csv" type="csv" default="region,churn
us,0.04
eu,0.10"></wb-input>

<wb-cell id="hotspots" language="polars" reads="csv">
  SELECT * FROM data WHERE churn > 0.05
</wb-cell>

<wb-output for="hotspots"></wb-output>
```

`mountHtmlWorkbook()` from `@work.books/runtime/htmlBindings` walks
the DOM, builds the cell list, runs the executor. No React/Svelte/
Solid required.

**When to choose**: you want declarative cells without picking a
framework. Or you want the workbook source to read like an HTML
document with annotations.

**Reference exemplar**: `examples/html-agent/` — Polars cell + LLM
agent grounded on the cell output, all declared via `<wb-*>`.

---

## Lane 3 — Svelte multi-file

Real component model, scoped CSS, Svelte 5 runes for state. Built
with `@work.books/cli` (Vite + `vite-plugin-svelte` under the hood).

```
my-workbook/
  workbook.config.mjs       # name, slug, type, entry, env
  package.json              # svelte ^5, @work.books/cli, etc.
  src/
    index.html              # bare shell — mounts <App />
    main.js                 # mount(App, ...)
    App.svelte              # root component
    components/...
```

```js
// workbook.config.mjs
export default {
  name: "my workbook",
  slug: "my-workbook",
  type: "spa",
  entry: "src/index.html",
};
```

```bash
npx workbook dev      # vite dev server with HMR
npx workbook build    # → dist/<slug>.workbook.html (single file)
```

The runtime is available as a virtual import:

```js
import { loadRuntime } from "virtual:workbook-runtime";
const { wasm, bundle } = await loadRuntime();
const out = wasm.runPolarsSql("SELECT * FROM data", csv);
```

In dev: served from `/__workbook/*`. In build: inlined as base64 in
the output HTML. Same surface; loader handles both.

**When to choose**: real apps. Multi-page navigation, component
reuse, anything that benefits from typed code or scoped styles.

**Reference exemplars**:
- `examples/svelte-app/` — three-route hash-router SPA (Home / Editor / Settings)
- `examples/notebook-agent/` — Svelte chat-with-cells SPA, parallel to chat-app

---

## Lane 4 — Svelte + Tailwind v4

Lane 3 with utility-class CSS via `@tailwindcss/vite`. Tailwind's
v4 `@theme` token system maps cleanly to scoped Svelte components.

```js
// workbook.config.mjs
import tailwindcss from "@tailwindcss/vite";

export default {
  name: "my-tailwind-workbook",
  slug: "my-workbook",
  type: "spa",
  entry: "src/index.html",
  vite: { plugins: [tailwindcss()] },
};
```

```css
/* src/styles.css */
@import "tailwindcss";

@theme {
  --color-page:    #fafafa;
  --color-surface: #ffffff;
  --color-fg:      #0a0a0a;
  --color-accent:  #84cc16;
}
```

```html
<div class="bg-page text-fg p-8">
  <button class="bg-accent text-white px-4 py-2 rounded">Run</button>
</div>
```

The CLI's plugin merge means user-supplied `vite.plugins` runs
before the workbook plugin chain. JIT-purged output: the final
HTML only contains utilities you actually used.

**When to choose**: utility CSS is your team's house style, or you
want fast iteration on visual design without scoped-CSS overhead.

**Reference exemplar**: `examples/tailwind-app/` — analyst dashboard
with sidebar filters + reactive Polars queries.

---

## Lane 5 — mdsvex (markdown + Svelte components)

Markdown for prose. Inline Svelte components for richness. Workbook
language code fences (` ```polars `, ` ```rhai `, etc.) auto-compile
to executable cells.

```svx
<script>
  import { Notebook, NotebookCell, NotebookToolbar }
    from "@work.books/runtime/notebook";

  const CSV = `region,churn
us,0.04
eu,0.10`;
</script>

<Notebook data={CSV}>

# Customer churn report

<NotebookToolbar />

This quarter we observed elevated starter-tier churn. Below is
the full breakdown.

```polars id="hotspots" reads="csv"
SELECT region, churn FROM data WHERE churn > 0.05
```

The starter tier has the highest rate at **{result}**.

</Notebook>
```

The `@work.books/cli` auto-loads `mdsvex` when present in `package.json`
deps. The plugin's `remarkWorkbookCells` rewrites fenced code blocks
tagged with workbook languages into `<NotebookCell>` invocations.
Authors write markdown; the chrome (play buttons, Run All, status
indicators) appears automatically.

The `<Notebook>` component supports three rendering modes via
`mode="..."`:

- `notebook` (default) — Jupyter-style chrome with gutter, play button per cell, editable source
- `document` — single-column, no gutter, source as quoted figure, read-only
- `headless` — cells run silently; consumer renders output

**When to choose**:
- **document** — quarterly reports, published analyses, prose-heavy
  artifacts with embedded computation
- **notebook** — analyst notebooks, exploration, anywhere you want
  cells + prose

**Reference exemplars**:
- `examples/document-mdx/` — Q4 customer revenue report with embedded
  ChurnScenario interactive widget
- `examples/notebook-mdx/` — analyst churn notebook with standard chrome
- `examples/dependency-chain/` — five-cell error-propagation demo

---

## The standardized notebook chrome (SDK)

For `type: "notebook"` workbooks, `@work.books/runtime/notebook` ships
a working chrome you don't have to think about:

```ts
import {
  Notebook,           // wrapper — owns ReactiveExecutor, provides context
  NotebookCell,       // per-cell chrome — gutter, play button, source, output
  NotebookToolbar,    // Run All, Clear outputs
  getNotebookContext, // drop down a layer for custom UI
  renderCellOutput,   // pure-string output → HTML helper
} from "@work.books/runtime/notebook";
```

**Default DX**: write a workbook, get play buttons + Run All + status
indicators. Don't think about it.

**Override DX**: build your own gutter / toolbar / editor by reading
the same `NotebookApi` via `getNotebookContext()`. The wrapper is
the only required piece (it owns the executor); everything else is
opt-in.

CSS variables for theming without ejecting:
- `--nb-bg` / `--nb-bg-2` / `--nb-bg-3` — background tones
- `--nb-ink` / `--nb-ink-2` / `--nb-ink-3` / `--nb-ink-4` — text shades
- `--nb-line` / `--nb-line-2` — borders
- `--nb-error` — error red (default `#dc2626`)
- `--nb-mono` — monospace stack

Override one, override all — the chrome adapts without forking.

---

## Widgets — interactive components inside a workbook

A widget is **an SPA at component scale**. You write a Svelte
component, import it in a `.svx` (or any other workbook source),
use it inline. It runs in the same wasm runtime as the surrounding
workbook — no second cold start, no isolation.

```svx
<script>
  import ChurnScenario from "./widgets/ChurnScenario.svelte";
</script>

# Some prose

<ChurnScenario />

More prose. The widget above lets the reader play with parameters.
```

```svelte
<!-- widgets/ChurnScenario.svelte -->
<script>
  import { onMount } from "svelte";
  let runtime = $state(null);
  let reduction = $state(0.5);

  onMount(async () => {
    const { loadRuntime } = await import("virtual:workbook-runtime");
    runtime = await loadRuntime();
  });

  $effect(() => {
    if (!runtime) return;
    void reduction;        // dependency
    runProjection();
  });
  // ... runs Polars queries on slider input
</script>

<input type="range" min="0" max="1" step="0.05" bind:value={reduction} />
<!-- ... -->
```

This pattern works in `document`, `notebook`, **and** `spa` workbooks
— the .svx + Svelte authoring path is the same. A widget is just a
component scoped narrower than a page.

**Reference**: `examples/document-mdx/src/widgets/ChurnScenario.svelte`.

---

## Env contract (varlock-style)

Every workbook can declare what env it needs. Values resolve at
runtime; secrets never serialize back into the saved file.

```js
// workbook.config.mjs
export default {
  // ...
  env: {
    OPENROUTER_API_KEY: {
      label: "openrouter api key",
      prompt: "sk-or-…",
      required: true,
      secret: true,
    },
  },
};
```

Resolution priority (in the running workbook):
1. `window.WORKBOOK_ENV[key]` — host-injected (e.g. when embedded in Signal)
2. `localStorage["wb.env.<slug>.<key>"]` — namespaced per workbook
3. UI prompt (the workbook's own settings page)

The serializer drops any field flagged `secret: true` from the
output before write. Today declarations don't carry `value` at
all; this is the discipline boundary that makes future additions
safe by default.

---

## Icons (favicon)

`workbook.config.mjs` accepts `icon` or `icons[]`. The build inlines
icons as data URLs so the saved `.workbook.html` ships with its own
browser-tab glyph.

```js
icon: "src/icon.svg",
// OR
icons: [
  { src: "src/icon-32.png",  sizes: "32x32",   type: "image/png" },
  { src: "src/icon-192.png", sizes: "192x192", type: "image/png" },
],
```

Default: a lime-green squircle with a 📓 emoji. Override anytime.

**Note**: this controls the **browser** tab icon only. The OS-level
file icon (Finder/Explorer thumbnail) for `.workbook.html` files
requires platform registration and is a separate concern (see bd
issue `core-7fw.1`, deferred).

---

## Trigger-substring discipline

`<script>` raw text contains a state machine. These substrings, if
present in the source as literals, can put the page's HTML parser
into "script data escaped" state and prematurely terminate the
script:

```
<!--   -->   <script   </script   </style   </head
```

When generating any HTML inside a script tag, build these
substrings at runtime by string concatenation. The CLI provides
helpers in `packages/workbook-cli/src/util/triggerSafe.mjs`.

This bug bit `chat-app` during development, and `core-bii` was a
related variant where a user JS bundle's literal `</head>` inside
a template literal corrupted the asset injector. The CLI now
anchors on a unique sentinel instead of a `</head>` regex.

---

## Output format — same artifact, every lane

`.workbook.html` is a single self-contained HTML file. Around 17 MB
with the full wasm runtime inlined; ~3 MB on the wire with brotli.

What's inside:

- Spec — `<script id="workbook-spec" type="application/json">`
  carrying the manifest (slug, type, env declarations, runtime
  features)
- Wasm bytes — `<script id="wasm-b64" type="text/plain">` (base64)
- Wasm-bindgen JS — `<script id="bindgen-src" type="text/plain">`
- Runtime bundle — `<script id="runtime-bundle-src" type="text/plain">`
- Your CSS / JS — inlined by `vite-plugin-singlefile`
- Your favicon — inlined as a data URL

Open from `file://`, USB stick, email attachment, anywhere. Same
runtime, same format, regardless of how you authored the source.

---

## Cross-references

- `SPEC.md` — format spec (manifest schema, block types, wire protocols)
- `OPERATIONS.md` — lifecycle (creation, running, sharing, archival)
- `RUST_RUNTIME.md` — Rust → WASM rationale + tool migration map
- `WORKBOOK_AS_APP.md` — deeper SPA-lane reference (chat-app pattern,
  hand-rolled save flow, varlock contract details)
