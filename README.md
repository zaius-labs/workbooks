# Workbooks

> A **portable runtime for browser apps.** Real ML, real data work, real
> agents — packaged as a single HTML file that runs in any browser, with
> no server, no install, no sign-up. Apps you can email.

```
.workbook.html = self-contained HTML + WebAssembly runtime + your code
```

Notebooks. Documents. Full apps. All expressed as a single canonical
format. Author it any way you want — hand-written HTML, a build pipeline
with components, a framework like Svelte. Run it from `file://`, a USB
stick, your inbox, or behind a CDN. Compose workbooks as building blocks
of larger workbooks.

## Three canonical types

A workbook's `manifest.type` field declares which rendering profile a
host should use. Same format, same runtime, same env contract across
all three:

- **`document`** — sdoc-style read-mostly artifact. Rendered prose
  with embedded auto-rendered blocks (charts, tables, citations).
  Hosts wrap the workbook in a paper-like reader chrome. No agent
  loop or compute affordances surfaced to the reader.
- **`notebook`** — Jupyter-style linear runner. Cells in a static
  DAG, reactive execution. Reader edits inputs, re-runs cells, sees
  outputs materialize. Hosts wrap the workbook in a notebook chrome
  with run/restart/clear controls.
- **`spa`** — full canvas application. The author renders whatever
  UI they want; runtime is a service available on demand. Examples:
  `examples/chat-app/` (multi-mode agent UI), `examples/svelte-app/`
  (Svelte 5 + hash router multi-page app). Hosts render the
  workbook as-is — no chrome.

Type is a hint to consumers, not a build-path branch. The same
`.workbook.html` file format produces all three.

---

## Why this exists

Notebooks today are leaky abstractions. Jupyter ties you to Python kernels;
Observable to its hosted runtime; Marimo to Pyodide cold-starts. The
*format* gets entangled with the *runtime* gets entangled with a *vendor*.
A workbook from 2019 is a museum piece in 2026.

We bet on three pieces of unloved infrastructure:

1. **HTML as the format.** Web standards survive forever. View Source works
   from any text editor, on any operating system, in any year.
2. **Rust → WASM as the runtime.** Polars, Candle, Plotters, instant-
   distance, tokenizers — the modern data and ML stack compiled small,
   stripped, and SIMD-aware. ~2 MB compressed for a runtime that does
   what Pyodide needs ~30 MB to do.
3. **Protobuf as the contract.** Cells, runtime, LLM service — typed
   shapes that survive transport changes. Same caller code in the
   browser, on a Cloudflare Worker, behind a managed Connect-RPC service.

A workbook is the small intersection: a declarative HTML document that
knows how to execute itself, anywhere, today and in fifteen years.

---

## What's novel

| | Status quo | Workbooks |
|---|---|---|
| **Format** | Vendor JSON (`.ipynb`, etc.) | Plain HTML with custom elements (`.workbook.html`) — open in any browser, edit in any text editor |
| **Compute** | Python kernel server-side, or Pyodide ~30 MB / 8 s cold start | Rust → WASM, Polars + Candle + Plotters at ~2 MB / 200 ms cold start |
| **ML** | Server inference, or no inference at all | Real BERT-class models running in the page (verified: MiniLM sentence embeddings, 384-dim, 110 ms/query) |
| **Reactivity** | Manual re-run | Static cell DAG, debounced re-execution, only downstream cells re-fire on input change |
| **Distribution** | "Open Jupyter, install Python, run …" | Save a single `.workbook.html`, double-click, runs anywhere |
| **Agents** | Bolted-on chat panel calling a hosted API | Typed `LlmService` proto; agents are first-class cells; tools are sibling cells |
| **Extensibility** | Plugin = patch the host app | `registerWorkbookCell(language, impl)` — any developer ships a new cell type as a JS module; HTML authors use it as `<wb-cell language="my-thing">` |
| **License** | Vendor-controlled | Apache-2.0; format and reference implementations both open source |

Mozilla AI's [wasm-agents-blueprint](https://github.com/mozilla-ai/wasm-agents-blueprint)
is the closest cousin in spirit — HTML-first, WASM-powered agents. We
extend the same idea to *full data-science workbooks*: SQL, DataFrames,
charts, ML inference, vector search, agents, all in one declarative format.

---

## Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────┐
│  Authoring layer                                                  │
│  ┌────────────────┐   ┌────────────────┐   ┌────────────────┐    │
│  │ Hand-written   │   │ Svelte editor  │   │ Agent-authored │    │
│  │ HTML           │   │ (signal app)   │   │ (workbook agent│    │
│  │ (forever)      │   │ (rich DX)      │   │ writes cells)  │    │
│  └────────┬───────┘   └────────┬───────┘   └────────┬───────┘    │
│           └────────────────────┴────────────────────┘            │
│                                │                                 │
│                          workbook spec                           │
│                  cells · inputs · agents · manifest              │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
┌────────────────────────────────▼─────────────────────────────────┐
│  @workbook/runtime  (TypeScript)                                  │
│   • mountHtmlWorkbook  — DOM ↔ spec                              │
│   • ReactiveExecutor   — DAG + debounced re-execution            │
│   • LlmClient          — proto-typed; tier-portable              │
│   • runAgentLoop       — tool-using agent loop                   │
│   • createRuntimeClient — bridges to wasm                        │
│   • registerWorkbookCell — plugin entry point                    │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
┌────────────────────────────────▼─────────────────────────────────┐
│  workbook-runtime  (Rust → WASM)                                  │
│   Polars (lazy + SQL frontend)   Candle (BERT/inference)         │
│   Plotters (charts → SVG)         instant-distance (HNSW)        │
│   Rhai (scripting + variable     Tokenizers (HF)                 │
│         binding)                  Linfa (classical ML)            │
└──────────────────────────────────────────────────────────────────┘
```

**Three layers, each with one job.**

- The **HTML format** is the canonical authoring + serialization surface.
  It's the thing that gets shared. It's the thing that survives.
- The **TypeScript runtime** is the adapter: parse the format, build the
  cell DAG, reactively execute, plug in custom cells, route LLM calls.
- The **Rust/WASM engine** is the heavy compute: data, ML, vectors, charts.
  Tree-shakeable feature slices keep the bundle small.

The Svelte UI components in `packages/runtime/` are an *additional*
producer — a rich live-editing experience (used by [signal.ml](https://signal.ml))
that reads/writes the same canonical format.

---

## What's in this repo

```
zaius-labs/workbooks/
├── docs/
│   ├── SPEC.md              ← format spec: blocks, manifest, runtime tiers
│   ├── OPERATIONS.md        ← lifecycle, persistence, observability
│   └── RUST_RUNTIME.md      ← the Rust/WASM pivot rationale + tool map
├── proto/
│   ├── workbook/v1/
│   │   └── workbook.proto   ← canonical Workbook + Cell + manifest types
│   └── workbook/runtime/v1/
│       └── runtime.proto    ← Connect-RPC service every tier implements
│   └── workbook/llm/v1/
│       └── llm.proto        ← LlmService — chat / embed / describe
├── packages/
│   ├── runtime/             ← @workbook/runtime  (TS / Svelte)
│   │   └── src/
│   │       ├── htmlBindings.ts     ← <wb-*> custom elements + parser
│   │       ├── reactiveExecutor.ts ← cell DAG + debounce
│   │       ├── cellAnalyzer.ts     ← static reads/provides extraction
│   │       ├── wasmBridge.ts       ← createRuntimeClient
│   │       ├── llmClient.ts        ← LlmClient + browser transport
│   │       ├── agentLoop.ts        ← tool-using agent loop
│   │       ├── modelArtifactResolver.ts ← IndexedDB model cache
│   │       ├── crossWorkbookLoader.ts   ← lockfile + pin
│   │       ├── duckdbSidecar.ts    ← lazy-loaded @duckdb/duckdb-wasm
│   │       ├── runDiff.ts          ← structured diff between runs
│   │       ├── loopBlock.ts        ← parallel iteration
│   │       └── (Svelte components: Workbook, Block dispatcher, blocks/*)
│   └── runtime-wasm/        ← workbook-runtime  (Rust → WASM)
│       ├── src/
│       │   ├── lib.rs              ← entry + feature flags
│       │   ├── frames.rs           ← Polars cells (lazy + SQL)
│       │   ├── charts.rs           ← Plotters charts → SVG
│       │   ├── scripting.rs        ← Rhai cells (with variable binding)
│       │   ├── inference.rs        ← Candle (tensor ops + smoke test)
│       │   ├── embed.rs            ← BERT sentence embeddings
│       │   ├── vectors.rs          ← instant-distance HNSW
│       │   └── train.rs            ← Linfa classical ML
│       └── examples/         ← tour of demos (see below)
│           ├── _shared/      ← design system (CSS) + nav (chrome.js)
│           ├── hello-cell/   ← simplest rhai eval
│           ├── csv-explore/  ← polars query → auto-chart
│           ├── reactive-cells/ ← cell DAG + debounced re-execution
│           ├── candle-ops/   ← matmul/softmax/conv2d vs JS baseline
│           ├── vector-knn/   ← HNSW nearest-neighbor
│           ├── sentence-search/ ← real BERT embeddings + KNN
│           ├── chat-cell/    ← typed streaming LLM call
│           ├── chat-app/     ← full chat UI app — modes + inspector
│           ├── html-workbook/ ← workbook authored entirely in HTML
│           ├── html-agent/   ← <wb-agent> + <wb-chat> grounded on cells
│           └── runner/       ← drag-drop a .workbook to execute it
```

---

## Quickstart — run the demo tour

```bash
git clone https://github.com/zaius-labs/workbooks
cd workbooks/packages/runtime-wasm

# Build the wasm with all features enabled.
wasm-pack build --target web --release \
  --features "candle,vectors,embeddings"

# Serve the examples.
python3 -m http.server 8000
# Open http://localhost:8000/examples/html-agent/
```

Click through the nav: each demo proves a different layer of the runtime.

| Demo | Proves | Verified |
|---|---|---|
| `hello-cell/` | The wasm bridge round-trip works | Rhai eval in browser |
| `csv-explore/` | Polars OLAP runs in WASM | `GROUP BY` + auto-chart |
| `reactive-cells/` | The cell DAG reactively re-executes | Drag input → only downstream cells run |
| `candle-ops/` | Real ML compute is competitive with JS | matmul 11.4× faster than naive JS at N=256 |
| `vector-knn/` | HNSW index in browser | 2K × 128-dim corpus, sub-ms query |
| `sentence-search/` | Real BERT model runs | all-MiniLM-L6-v2 (~90 MB), 110 ms/query embed, semantic match correctness ✓ |
| `chat-cell/` | LLM service typed contract | OpenRouter streaming via proto-typed client |
| `chat-app/` | Multi-mode agent app on top of the runtime | Hamburger / left nav / right inspector |
| `html-workbook/` | HTML *is* the workbook | View Source = workbook source |
| `html-agent/` | Agent grounded on cell outputs | Polars table → GPT-4o-mini quotes exact numbers in chat |
| `runner/` | `.workbook` files run via drag-drop | Generic player |

---

## The format

A workbook is HTML. Custom elements declare structure; the runtime parses
the document at mount time.

```html
<wb-workbook name="customer-churn-snapshot">

  <wb-input name="csv" type="csv" default="region,revenue,churn
us,12000,0.04
eu,15600,0.02
apac,21000,0.05"></wb-input>

  <wb-cell id="by_region" language="polars" reads="csv">
    SELECT region, SUM(revenue) AS total, AVG(churn) AS avg_churn
    FROM data
    GROUP BY region
    ORDER BY total DESC
  </wb-cell>
  <wb-output for="by_region"></wb-output>

  <wb-agent id="analyst" model="openai/gpt-4o-mini" reads="by_region">
    <wb-system>You are a precise analyst. Cite numbers. Reply in 3 sentences.</wb-system>
  </wb-agent>
  <wb-chat for="analyst"></wb-chat>

</wb-workbook>
```

Open this HTML file in any browser → custom elements register on
`connectedCallback` → they hand their config to a `WorkbookContext` →
the executor builds the DAG → the polars cell computes → the chat UI
mounts → conversation flows with the agent grounded on the cell output.

A canonical `.workbook` JSON form exists too (smaller for embedding in
hosts) and round-trips bit-exact with the HTML form. Both flow through
the same internal spec → same executor → same wasm engine.

### Cell languages out of the box

| `language=` | Backend | Notes |
|---|---|---|
| `rhai` | Rhai engine (in wasm) | Variable scope wired from cell params; expression eval with full scripting |
| `polars` | Polars LazyFrame + SQL frontend (in wasm) | OLAP at ~1.75 MB compressed |
| `chart` | Plotters → SVG (in wasm) | Bar / line; multi-series spec |
| `sqlite` | `@sqlite.org/sqlite-wasm` | Lazy-loaded JS sidecar |
| `duckdb` | `@duckdb/duckdb-wasm` | Lazy-loaded JS sidecar; for advanced SQL needs Polars doesn't cover |
| `candle-inference` | Candle (in wasm) | Real BERT-class model inference; `embedTextFlat` for sentence embeddings |
| `linfa-train` | Linfa (in wasm) | Classical ML — linear regression, trees, clustering |
| `chat` | LlmClient (proto-typed) | Browser transport calls OpenRouter / OpenAI-compatible endpoints |
| `wasm-fn` | Curated function registry | Reserved (P7) |

### Plugin cells

Anyone can register a new cell language. Ship it as an npm package or a
single `<script type="module">`:

```js
import { registerWorkbookCell } from "@workbook/runtime";

registerWorkbookCell("mapbox-map", {
  execute: async ({ source, params, ctx }) => {
    const data = ctx.read(params.dataCell);
    const svg = await renderMapboxToSvg(data);
    return [{ kind: "image", content: svg, mime_type: "image/svg+xml" }];
  },
});
```

Authors then write `<wb-cell language="mapbox-map">…</wb-cell>` and it
works. Cell types come from anywhere; the runtime stays minimal.

---

## Tier model — same code, three hosts

The proto contracts (`workbook/runtime/v1/runtime.proto`,
`workbook/llm/v1/llm.proto`) are deliberately tier-agnostic. The runtime
ships three swappable transports:

| Tier | Transport | When |
|---|---|---|
| **Tier 1** — browser | In-page WASM via `wasm-bindgen`; LLM via direct fetch | Default. Single-file `.workbook.html`. No server. |
| **Tier 2** — self-hosted | Cloudflare Worker / Node + wasmtime; LLM via Cloudflare AI Gateway proxy | Front-end stays local but heavy work (large model loads, polars-parquet) offloads to a worker; provider keys stay server-side |
| **Tier 3** — managed | Hosted runtime fleet exposing Connect-RPC | Production; observability, quotas, multi-tenant |

Caller code is identical across tiers. A workbook that runs in your phone
browser and one that runs in a Tier 3 fleet hit the same `LlmService.GenerateChat`
surface with the same shapes. Migration between tiers is a transport swap
in the runtime client — no cell, agent, or workbook changes.

---

## Reactive execution model

Cells form a DAG via the `reads` and `provides` annotations. The static
analyzer fills in dependencies the author didn't declare (parsing SQL
FROM/JOIN clauses, Rhai `let` bindings, etc.). The executor:

1. Topologically sorts cells once
2. Marks dirty cells stale on input change
3. Debounces 200 ms (so dragging a slider doesn't fire 30× per second)
4. Runs cells in topo order; downstream sees upstream's output as a param
5. Failure isolates: an errored cell leaves its downstream as `stale`,
   not running with stale inputs

State machine per cell: `pending → running → ok | error → stale → running …`.
View layers subscribe via `onCellState` and render badges, output, errors.

---

## Portable export

Click `↓ workbook` in any demo's nav. You get one of:

- **`<slug>.workbook`** — JSON, ~1 KB. Needs a host that has the runtime
  (the `runner/` page, the signal app).
- **`<slug>.workbook.html`** — single HTML file, ~15–20 MB. Wasm + JS
  bridge + workbook spec all base64-inlined. Open with any browser, no
  server, no `pkg/` directory. Works from a USB stick. Compresses to ~3 MB
  on the wire if served over HTTP with brotli.

The portable HTML form is what makes a workbook a *durable* artifact:
the format and runtime travel together as one file.

---

## Where it's going

Shipped today (October 2026):
- ✅ HTML-first format with custom elements
- ✅ Rust/WASM compute (Polars / Plotters / Rhai / Candle / Linfa / vectors / tokenizers)
- ✅ Reactive cell DAG with static analyzer + debounced re-exec
- ✅ Proto-typed LlmService + browser transport
- ✅ Streaming chat UI grounded on cell outputs
- ✅ Plugin API for custom cell languages
- ✅ Portable `.workbook.html` self-contained export
- ✅ Cross-workbook composition + lockfile
- ✅ Model artifact cache (IndexedDB, content-addressed)
- ✅ Run diff (CSV row-level / text / image / table)

Next up (in order):
- **Tool-calling agent** — agents that *do* things, not just describe them.
  Built-in tools: `read_cell`, `run_cell`, `append_cell`, `query_data`,
  `search_vectors`. Agent loop already exists in `agentLoop.ts`; needs
  wiring to the chat UI + tool surface.
- **Workbook env contract** — typed required-env declarations
  (varlock-style schema). Hosts satisfy before run; runner UI shows red
  dots for unsatisfied keys.
- **Tier 2 runtime** — Cloudflare Worker host serving Connect-RPC, with
  the LLM Gateway transport. Heavy cells offload, light cells stay local.
- **Async / Web Worker WASM** — current wasm runs on the main thread, so
  long ops (BERT inference, big matmul) freeze the UI. Move to Web Worker.
- **Polars-parquet** — needs a wasm32 C toolchain (wasi-sdk). Adds
  Parquet read/write to the default bundle.
- **More model architectures** — distilbert, sentence-transformers
  variants, small LLMs (TinyLlama Q4_K_M for in-browser chat without
  external API).
- **Buf-generated SDKs** — proto → TS / Python / Go / Rust clients.
- **Self-hosted Docker image** — same wasm bundle, headless via Node + wasmtime.

Architectural arcs further out:
- **Embedded agent runtime** — port of `pi-agent-rust` to wasm. The full
  agent loop + tool dispatch in Rust, browser-side, no JS round-trips.
- **Manifest signatures** (Ed25519) — workbooks signed by their authors;
  consumers verify on load.
- **Scheduled workbooks** — manifest declares a cron; managed runtime
  fires the workbook on schedule, captures structured diffs against the
  prior run.

---

## Contributing

See `CONTRIBUTING.md` for the dev loop. The repo is a pnpm workspace
(`packages/runtime` + `packages/runtime-wasm`). The Rust crate is
`workbook-runtime`; the npm package is `@workbook/runtime`.

A workbook spec change needs proto + types + at least one demo. Cell
language additions need a Cargo feature flag (so non-users don't pay
the bundle cost) plus a Cargo.toml peer-dep entry for sidecar JS deps.

We use [bd / beads](https://github.com/zaius-labs/.bit) for issue
tracking. The work that built this README is tracked under `core-7fw`
(workbook v2 epic).

## License

[Apache-2.0](LICENSE) — © 2026 Zaius Labs.

The format and reference implementations are open source. Build cell
plugins, alternative editors, alternative hosts. Workbooks should
outlive any one company.
