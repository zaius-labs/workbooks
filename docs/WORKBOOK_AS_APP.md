# Workbook as App

Deep dive on the SPA workbook type — packaging a real browser app
as a single HTML file.

> See **`WORKBOOK_AUTHORING.md`** for the umbrella authoring guide
> covering all shapes (document / notebook / spa) and all authoring
> styles (vanilla / Svelte / Tailwind / mdsvex / raw HTML). This page
> is the SPA-lane chapter — the chat-app pattern, the hand-rolled
> save flow, the env contract details. Other shapes are covered in
> `SPEC.md` and `OPERATIONS.md`.

## What an "app workbook" is

A workbook with `manifest.type: "spa"` whose `blocks: []` is empty.
Instead of cells, the author ships a custom UI (HTML, JS, optionally
a framework like Svelte) that renders directly into the page. The
wasm runtime is available as a service the app can pull in on demand
via `virtual:workbook-runtime` (under the build tool) or by reading
the inlined `<script id="*">` blocks at boot (single-file authoring).

The two reference exemplars in this repo:

- `examples/chat-app/index.html` — single-file, no build step. Four
  modes (general / data analyst / sql helper / agent), inline VFS
  + virtual bash, OpenRouter LLM client, streaming agent loop,
  markdown renderer, save-as-portable-`.html`. ~1400 lines
  of vanilla JS with `view-source` working end-to-end.
- `examples/svelte-app/` — multi-file Svelte 5 project. Built with
  `@work.books/cli`. Three routes (Home / Editor / Settings) with
  hash routing, varlock env contract, lazy wasm runtime.

Both produce a single `.html` of similar shape (~17 MB
with the wasm runtime inlined). The format doesn't care which
authoring style you used.

## When to choose which authoring path

**Hand-written single-file** (chat-app pattern):

- The app is small (< ~2000 lines of code).
- You want `view-source` to be the contribution path.
- You don't want a `node_modules/` to maintain.
- One-off internal tools, demos, agent harnesses.

**Build tool** (svelte-app pattern):

- Multiple HTML pages, real component model.
- You want a framework (Svelte, etc.).
- You're editing components day-to-day; HMR matters.
- Anything that benefits from typed code, scoped CSS, or
  build-time optimization.

The two paths produce equivalent artifacts. Migrate between them
when the constraints change.

## Build tool: `@work.books/cli`

Vite-based, ships as an npm package. See `packages/workbook-cli/`.

```bash
npm i -D @work.books/cli @sveltejs/vite-plugin-svelte svelte
```

```js
// workbook.config.mjs
export default {
  name: "my workbook",
  slug: "my-workbook",
  type: "spa",                 // document | notebook | spa
  entry: "src/index.html",
  env: {
    OPENROUTER_API_KEY: { required: true, secret: true, prompt: "sk-or-…" },
  },
};
```

```bash
npx workbook dev      # http://localhost:5173 with HMR
npx workbook build    # → dist/<slug>.html (single file)
```

What `build` does:

1. Vite bundles your entry + all imports.
2. `vite-plugin-singlefile` collapses JS + CSS into the HTML.
3. The CLI's plugin reads the wasm-bindgen JS, runtime bundle, and
   wasm bytes from a sibling `runtime-wasm/pkg/`, and inlines them
   as `<script type="text/plain">` blocks under
   `<!-- portable-assets-begin --> ... <!-- portable-assets-end -->`.
4. The same plugin emits a `<script id="workbook-spec">` JSON blob
   carrying the manifest (slug, type, env, runtime features).
5. Output is renamed `<slug>.html`.

User code accesses the runtime via a virtual import:

```js
import { loadRuntime } from "virtual:workbook-runtime";
const { wasm, bundle } = await loadRuntime();
const out = wasm.runPolarsSql("SELECT * FROM data", csv);
```

In dev: resolves to direct fetches of the runtime files (served by
the CLI middleware at `/__workbook/*`). In build: same surface, but
the loader reads the inlined `<script id>` blocks and imports via
blob URLs. **The user's compiled JS does not statically import the
runtime bundle** — that keeps the user code small and avoids
pulling in the runtime's optional peer deps (deck.gl, mermaid, plotly, etc.)
into the build graph.

## Env contract (varlock-style)

Workbooks declare the env they need; the host resolves values at
runtime; secrets never serialize back into the file.

```js
// workbook.config.mjs (or hand-written manifest)
env: {
  OPENROUTER_API_KEY: {
    label: "openrouter api key",
    prompt: "sk-or-…",
    required: true,
    secret: true,
  },
}
```

Resolution priority:

1. `window.WORKBOOK_ENV[key]` — host-injected (e.g. when embedded
   inside Signal).
2. `localStorage["wb.env.<slug>.<key>"]` — namespaced per workbook.
3. Inline UI prompt (red dot + password input in the workbook's
   own settings page).

The serializer walks `manifest.env` and **drops any field flagged
`secret: true` from `value` slots before save**. Today
declarations don't carry `value` at all; this is the discipline
boundary that makes future additions safe by default.

## Trigger-substring discipline

`<script>` raw text contains a state machine. These substrings, if
present in the source as literals, can put the page's HTML parser
into "script data escaped" state and prematurely terminate the
script tag in the generated artifact:

```
<!--    -->    <script    </script    </style    </head
```

When generating any HTML inside a script tag (most relevant for
authoring tools that emit script content), build these substrings
at runtime by string concatenation:

```js
const COM_OPEN  = "<" + "!" + "--";
const COM_CLOSE = "--" + ">";
const TAG_SCRIPT_OPEN  = "<" + "script";
const TAG_SCRIPT_CLOSE = "<" + "/script>";
```

The CLI's `src/util/triggerSafe.mjs` provides helpers. The
hand-written chat-app does this manually. This bug bit chat-app
during development — saved files would render correctly until the
`<!--` in a regex literal got serialized into the output, putting
the parser into a state where a later `</script>` substring closed
the wrong tag.

## Persistence in app workbooks

Two scopes:

- **Workbook-internal state** — UI state, in-flight conversations,
  ephemeral input. Use localStorage namespaced as `wb.<slug>.*`.
  Or just rebuild from the manifest on each load if cheap.
- **Workbook content** — files the user creates inside the app
  (chat-app's VFS, for instance). Choose a backing store
  appropriate to the size:

  | Backing | Cap | Latency | Suits |
  |---|---|---|---|
  | localStorage | ~5 MB origin | sync, fast | tiny configs, threads |
  | OPFS (`WorkbookVfs` in `@work.books/runtime`) | gigabytes | async, fast | real datasets |
  | IndexedDB | gigabytes | async | structured records, large blobs |

The hand-written chat-app uses localStorage for simplicity. Real
data tools should use OPFS via `WorkbookVfs`.

## Save as portable `.html`

The CLI's `build` command produces a portable artifact directly.
For hand-written workbooks (chat-app pattern), the saver fetches
its own assets at click time:

```js
const [bindgenJs, bundleSrc, designCss, wasmBytes] = await Promise.all([
  fetchText("../../pkg/workbook_runtime.js"),
  fetchText("../reactive-cells/runtime.bundle.js"),
  fetchText("../_shared/design.css"),
  fetchBytes("../../pkg/workbook_runtime_bg.wasm"),
]);
// strip wasm-bindgen's `new URL(..., import.meta.url)` (opaque in blob)
// inline as <script type="text/plain"> blocks under portable-assets sentinels
```

When opening a saved file, the boot path detects whether the
inlined blocks are present and switches between dev and portable
modes transparently. Same source supports both.

## Markdown rendering

Available as `renderMarkdown` from `@work.books/runtime` (or the
inline runtime bundle). Returns trusted HTML; callers use
`innerHTML`. CommonMark-ish — fenced code blocks, headings, lists,
blockquotes, hr, bold/italic, inline code, links (http(s)/anchor
only — `javascript:`/`data:` URLs render as plain text), autolinks.

```js
import { renderMarkdown } from "@work.books/runtime";
el.innerHTML = renderMarkdown("# Title\n\nsome `code` and **bold**");
```

Streaming-friendly: an unclosed code fence renders as a code block
and recovers cleanly when the closing ``` arrives in a later delta.
Used in chat-app's assistant text rendering.
