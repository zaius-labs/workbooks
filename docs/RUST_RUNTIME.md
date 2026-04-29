# Signal Workbook — Rust/WASM Architecture

A strategic alternative to the Python+E2B runtime described in `WORKBOOK_SPEC.md`. Pivots cell execution from Python-in-a-server-sandbox to Rust-compiled-to-WASM running entirely client-side. **And** ships a Rust-native agent runtime that compiles to WASM — so the agent itself runs in the browser alongside the cells it generates. The workbook becomes a single self-contained file containing the document, the runtime, and the agent that authored and refines it.

> **Update (core-0id.7)**: this doc references DuckDB-WASM throughout
> as the SQL engine. The runtime as shipped removed DuckDB — Polars-SQL
> covers analytical workloads, and `@sqlite.org/sqlite-wasm` (lazy-loaded
> JS sidecar) is the non-Polars roadmap path for the `language: "sqlite"`
> cell type. Mentions of "DuckDB-WASM" below should be read as
> "Polars-SQL today / SQLite sidecar tomorrow" unless explicitly
> discussing why DuckDB was originally chosen.

This document analyzes the pivot end-to-end: thesis, architectural changes, tool-by-tool mapping from Python ecosystem to Rust equivalents, the embedded agent runtime, what's gained, what's lost, and a migration path.

---

## Thesis

A workbook today is a portable document, but its execution depends on a Python sandbox we host. Email a `.workbook` to a customer and Python cells are dead until they connect to Signal. The format is portable; the runtime is not.

Rust compiles to WebAssembly. The Rust ML and data ecosystem is now mature enough — Polars, DuckDB, Candle, Linfa, Plotters, Burn — that a well-built WASM runtime can do 80% of what data scientists currently use Python for, **entirely in the browser**. The workbook becomes truly portable: format AND runtime, in one file, runnable anywhere, forever.

The pitch becomes: **"Signal generates a workbook. You email it to anyone. They open it. It runs. Forever. Anywhere. No account, no server, no cold start, no expiration."**

This is a category-defining differentiator. No competitor today ships AI-generated artifacts that are simultaneously interactive, executable, and self-contained.

---

## Strategic Differentiation

| Tool | What you get | What expires |
|------|-------------|--------------|
| ChatGPT / Claude analysis | Chat output, screenshots | Everything when the chat closes |
| Jupyter `.ipynb` | Notebook structure | Execution requires kernel; usually gone |
| Hex / Mode / Deepnote | Hosted notebook | Everything when you stop paying |
| Observable | Hosted reactive notebook | Code stays, runtime depends on Observable being alive |
| Marimo (WASM mode) | Reactive notebook in browser | Limited by Pyodide ceiling — slow, missing libs |
| **Signal Workbook (Rust/WASM)** | Self-contained executable artifact | **Nothing.** Runs forever, anywhere, no dependency |

Marimo is the closest analog — and the architectural inspiration — but it's bottlenecked by Pyodide. Pyodide is Python-on-WASM with all of Python's WASM disadvantages: ~8s cold start, limited package coverage (no `torch`, partial `transformers`), large bundle (~30 MB), interpreter overhead.

A native Rust runtime is **dramatically better**: ~200ms cold start, ~10 MB bundle, near-native execution speed, full ML inference capability, no interpreter overhead. Same architectural pattern, fundamentally different performance envelope.

---

## Architecture

### Runtime: one big WASM module

The workbook runtime is a compiled Rust crate that includes the entire data and ML stack:

```
@workbook/runtime-wasm  (~10–15 MB compressed)
├── Polars              — DataFrame ops (replaces pandas)
├── DataFusion           — SQL query engine
├── DuckDB-WASM          — alternative SQL engine with extensions
├── Arrow                — columnar memory format, IPC
├── Candle               — ML inference (Hugging Face's Rust framework)
├── Linfa                — classical ML (sklearn equivalent)
├── Burn                 — neural network framework with WebGPU backend
├── Plotters / Charming  — charting
├── ndarray + nalgebra   — numerical computing
├── tokenizers           — HF tokenizers (works in WASM)
├── statrs               — statistics (scipy.stats equivalent)
├── image                — image processing (Pillow equivalent)
├── reqwest              — HTTP client (CORS-bound)
├── Rhai                 — scripting glue language
└── serde + arrow-ipc    — serialization
```

This module is loaded once from CDN per major version, cached aggressively. Subsequent workbook loads have near-zero JS overhead — the runtime is already in the browser cache.

### Cells: structured, not free-form

The hard problem with "Rust in a notebook" is compilation time. `rustc` takes seconds-to-minutes; that's incompatible with interactive cells.

The solution: cells aren't free-form Rust. They're **structured operations** against the embedded runtime:

| Cell language | What it does | Compile time |
|---------------|--------------|--------------|
| `sql` | DuckDB-WASM or DataFusion SQL | None (interpreted at runtime) |
| `polars` | Polars DataFrame operations | None (LazyFrame, compiled to plan) |
| `rhai` | Rhai script orchestrating calls into the runtime | None (interpreted) |
| `candle-inference` | Declarative model inference (model + input + output spec) | None (config, not code) |
| `linfa-train` | Declarative classical ML training (algorithm + dataset + hyperparameters) | None (config) |
| `chart` | Plotter declaration (chart type + data binding + style) | None (config) |
| `wasm-fn` | Pre-compiled Rust function from a curated registry | None (just a function call) |

For 95% of data science workflows, these cell types are sufficient. The agent's job is to compose these structured cells, not to write free-form Rust.

For workflows that need real Rust code, the `wasm-fn` cell type calls into a curated function registry — the same widget-registry pattern from the main spec, applied to compute. Functions are pre-compiled to WASM, signed, versioned, and referenced by name.

### What the agent generates

The agent emits manifests, just like today. The block contents change:

- **SQL block**: same as today, runs in DuckDB-WASM
- **Polars block** (new): a Polars LazyFrame expression chain
- **Rhai block** (new): a Rhai script orchestrating multiple runtime calls
- **Candle inference block** (new): a model reference + input/output binding
- **Plot block**: a chart type + data binding (Plotters declarative spec)

The agent never writes free-form Rust. It composes structured cells against the runtime's stable API. This makes generated content safe (no arbitrary code), inspectable (declarative), and uniform (every workbook uses the same primitives).

### File format changes

The `.workbook` format itself stays mostly the same. Differences:

- Layer 4 references `@workbook/runtime-wasm` instead of `@workbook/runtime` (the WASM bundle replaces the Python-host-orchestration JS)
- The data layer prefers Arrow IPC over base64 SQLite (Polars-native, zero-copy into the runtime)
- `manifest.environment` becomes `manifest.runtime.bundle` — declares the runtime version and feature flags rather than pip packages
- `manifest.runtime.contractVersion` references the Rust runtime's API contract (which Rust crates are expected, what API they expose)

### Tier collapse

The three runtime tiers from the spec collapse:

| Spec tier (Python) | Rust pivot |
|--------------------|-----------|
| Tier 1 (browser-only, SQL only) | **Tier 1 expanded** — runs SQL, Polars, Rhai, Candle inference, Linfa training, Plotters charts |
| Tier 2 (local CLI runtime) | **Rare** — only for workflows that hit WASM ceilings (large model training, native deps) |
| Tier 3 (Signal hosted) | **Specific use cases** — scheduled runs at scale, training that exceeds browser memory, headless API serving, MCP server hosting |

For most workbooks, Tier 1 is now the primary tier. Signal hosted becomes the place for scheduled/headless/heavy use cases, not the default execution backend.

---

## Tool Migration Map

A working assumption: most of the Python ecosystem the agent currently uses has a Rust equivalent. This table is the audit.

### Data manipulation

| Python | Rust equivalent | WASM | Notes |
|--------|----------------|------|-------|
| `pandas` | `polars` | ✓ | Polars is faster, lazy-evaluated, handles larger-than-RAM via streaming. Direct WASM target. |
| `numpy` | `ndarray` | ✓ | Mature, full functionality |
| `pyarrow` | `arrow-rs` | ✓ | Same Arrow spec, native impl |
| `dask` | `polars` (lazy mode) + DataFusion | ✓ | Streaming + parallelism via rayon |
| `vaex` | `polars` | ✓ | Same out-of-core story |

### Databases & SQL

| Python | Rust equivalent | WASM | Notes |
|--------|----------------|------|-------|
| `sqlite3` | `rusqlite` / `duckdb-wasm` | ✓ | DuckDB-WASM is a strict upgrade |
| `sqlalchemy` | `sqlx` / `diesel` | partial | Async, type-safe; remote DBs via reqwest |
| `pyodbc` / `psycopg2` | `tokio-postgres` (via proxy) | partial | Browser CORS limits; requires proxy |
| `clickhouse-connect` | `clickhouse-rs` | partial | Same proxy story |
| `pyduckdb` | `duckdb-wasm` | ✓ | Direct |

### Classical ML

| Python | Rust equivalent | WASM | Notes |
|--------|----------------|------|-------|
| `scikit-learn` | `linfa` | ✓ | Random forest, k-means, SVM, regression, etc. |
| `xgboost` | `xgboost-rs` | partial | Bindings exist; WASM build untested |
| `lightgbm` | `gbdt-rs` | ✓ | Pure Rust GBDT |
| `statsmodels` | `linfa` + `nalgebra-glm` | ✓ | Smaller surface than statsmodels |
| `scipy.stats` | `statrs` | ✓ | Distributions, hypothesis tests |
| `scipy.optimize` | `argmin` | ✓ | Optimization framework |
| `scipy.signal` | `rustfft`, `medians-rs` | ✓ | Pieces available; not as cohesive |
| `prophet` | (gap) | — | No mature Rust equivalent; consider porting |

### Deep learning & inference

| Python | Rust equivalent | WASM | Notes |
|--------|----------------|------|-------|
| `pytorch` (inference) | `candle` | ✓ | Hugging Face's Rust ML framework, WASM-tested |
| `pytorch` (training) | `burn` | partial (WebGPU) | Burn supports WGPU backend; works for moderate models |
| `tensorflow` (inference) | `candle` / `ort` | ✓ | ONNX Runtime via `ort` for TF-converted models |
| `transformers` | `candle-transformers` | ✓ | LLaMA, Mistral, BERT, T5 implementations |
| `diffusers` | `diffusers-rs` (via candle) | ✓ | Stable Diffusion in WASM is real (slow but works) |
| `accelerate` | (n/a) | ✓ | Burn handles device dispatch natively |
| `peft` / fine-tuning | `candle-lora` | partial | LoRA fine-tuning works for small models |
| `bitsandbytes` (quantization) | `candle` quantized models | ✓ | GGUF, Q4_K_M support built-in |
| `onnxruntime` | `ort` / `tract` | ✓ | `tract` is pure-Rust, fully WASM-compatible |

### NLP

| Python | Rust equivalent | WASM | Notes |
|--------|----------------|------|-------|
| `transformers` (tokenizers) | `tokenizers` (HF) | ✓ | The Python lib IS Rust under the hood |
| `spacy` | `rust-bert` + `tokenizers` | partial | Smaller scope; pipelines are DIY |
| `nltk` | `whatlang`, `lingua-rs` | ✓ | Language detection, basic NLP |
| `sentence-transformers` | `candle-transformers` (sentence models) | ✓ | All-mpnet, all-minilm work in WASM |

### Vector ops & retrieval

| Python | Rust equivalent | WASM | Notes |
|--------|----------------|------|-------|
| `faiss` | `instant-distance` / `hnsw_rs` | ✓ | HNSW in pure Rust |
| `chromadb` | `lancedb` | ✓ | LanceDB has WASM target; vector + structured |
| `pinecone` (client) | (HTTP via proxy) | partial | API client trivial; needs CORS proxy |
| `weaviate` (client) | (HTTP via proxy) | partial | Same |
| `usearch` | `usearch` | ✓ | Has WASM build |

### Visualization

| Python | Rust equivalent | WASM | Notes |
|--------|----------------|------|-------|
| `matplotlib` | `plotters` | ✓ | Server-side rendered to SVG; or use canvas |
| `plotly` | `charming` | ✓ | Echarts wrapper; same chart vocabulary |
| `seaborn` | `plotters` + presets | ✓ | Higher-level helpers DIY |
| `altair` | (gap, but trivial via vega-lite JSON) | ✓ | Generate Vega-Lite JSON, render with Vega in JS |
| `bokeh` | `charming` | ✓ | Interactive charts |

### Time series

| Python | Rust equivalent | WASM | Notes |
|--------|----------------|------|-------|
| `pandas.resample` | `polars` time series | ✓ | First-class in Polars |
| `prophet` | (gap) | — | Considered worth porting given ubiquity |
| `statsmodels.tsa` | (partial) `linfa` | partial | ARIMA exists; not as comprehensive |
| `darts` | (gap) | — | Specialized; agent can fall back to remote |

### Image / vision

| Python | Rust equivalent | WASM | Notes |
|--------|----------------|------|-------|
| `Pillow` | `image` | ✓ | Full feature parity |
| `opencv-python` | `opencv-rust` | partial | Native OpenCV deps; works with limitations |
| `scikit-image` | `image-rs` + custom | partial | Smaller surface |
| `kornia` | (gap) | — | Niche |

### Audio

| Python | Rust equivalent | WASM | Notes |
|--------|----------------|------|-------|
| `librosa` | `aubio-rs` / `dasp` | partial | Lower-level, smaller scope |
| `soundfile` | `hound` (WAV), `symphonia` (decode) | partial | Multi-format decode |

### LLM tools

| Python | Rust equivalent | WASM | Notes |
|--------|----------------|------|-------|
| `openai` (client) | `async-openai` | ✓ | API client, CORS-bound |
| `anthropic` (client) | `anthropic-rs` (community) | ✓ | Same |
| `langchain` | `rig` / `llm-chain` | ✓ | `rig` is the modern choice |
| `llama-index` | `swiftide` | partial | RAG framework in Rust |
| `instructor` | `rig` (typed outputs via serde) | ✓ | Built-in to `rig` |
| `dspy` | (gap) | — | Niche |

### Web / scraping

| Python | Rust equivalent | WASM | Notes |
|--------|----------------|------|-------|
| `requests` / `httpx` | `reqwest` | ✓ | CORS-bound in browser |
| `beautifulsoup4` | `scraper` / `kuchikiki` | ✓ | Full HTML parsing |
| `playwright` | (browser limitation) | ✗ | Not possible in-browser; needs CORS proxy + Signal hosted |
| `selenium` | (browser limitation) | ✗ | Same |

### Crypto & utility

| Python | Rust equivalent | WASM | Notes |
|--------|----------------|------|-------|
| `hashlib` | `sha2`, `blake3` | ✓ | Full coverage |
| `cryptography` | `ring`, `aws-lc-rs` | ✓ | |
| `uuid` | `uuid` | ✓ | |
| `pydantic` | `serde` + `validator` | ✓ | Better in Rust frankly |
| `sympy` | (gap) | — | Symbolic math; rare in data work |

### Coverage summary

- **Strong coverage** (~85% of typical data work): data manipulation, classical ML, inference, NLP, vector retrieval, visualization, image processing, LLM clients, web fetching, time series basics
- **Partial coverage** (workarounds needed): heavy training (use WebGPU via Burn or fall back to Tier 3), audio/video (Tier 3), browser-incompatible network ops (CORS proxy via Signal)
- **Gaps** (no Rust equivalent today): Prophet, DSPy, kornia, sympy. These are either nicheable (workbook author falls back) or worth Signal investing in (Prophet specifically, given prevalence)

The 15% gap is real. It maps cleanly to "use Tier 3 Signal hosted" — these are exactly the workflows where browser-only is a compromise anyway.

---

## Embedded Agent Runtime

The pivot's most differentiating move: **the agent itself runs in the browser**. A workbook ships with an embedded Rust agent runtime — compiled to WASM, alongside the data runtime — that can author, refine, and extend the workbook entirely client-side. The user opens a `.workbook` file, types a refinement prompt, and the agent reads the manifest, calls tools, mutates blocks, and runs cells — all without contacting Signal's servers (except optionally for LLM API calls, which can route through Signal's CORS proxy or directly to the user's chosen provider).

This collapses the agent/runtime/document distinction. A workbook becomes a complete AI artifact — document + data + runtime + the agent that produced it — that the recipient can continue iterating with.

### Reference architecture: pi_agent_rust

[`pi_agent_rust`](https://github.com/Dicklesworthstone/pi_agent_rust) is a high-performance Rust port of Mario Zechner's Pi Agent. It's a CLI tool today, but its core architecture is exactly what an embedded workbook agent needs:

- **15+ LLM providers** (Anthropic, OpenAI, Gemini, Cohere, Azure, Bedrock, Vertex, plus any OpenAI-compatible endpoint). Credential-aware model selection. Custom routing.
- **Streaming-first** with extended thinking support, custom SSE parser, real-time token streaming
- **Tool calling protocol** with capability-gated execution
- **Tree-structured sessions** (JSONL v3, conversation branching, fast resume)
- **Embedded QuickJS** for JavaScript/TypeScript extensions — sub-100ms cold load, capability-gated hostcalls, deny-by-default policies, kill-switch audit trails
- **No unsafe code** project-wide (`#![forbid(unsafe_code)]`)
- **Custom async runtime** (asupersync) with deterministic cancellation and structured concurrency
- **Extension trust lifecycle** — per-extension policies (safe / balanced / permissive), per-extension overrides
- **rustls-only TLS**, no OpenSSL

Critically, the design is WASM-friendly even though the project doesn't target WASM today: zero unsafe, no native deps in the core, structured concurrency, capability-scoped contexts. The bash/find/grep tools wouldn't translate (no shell or filesystem in WASM), but the architecture does.

The proposed approach: **port pi_agent_rust to WASM**, replace its filesystem/shell tools with workbook tools, and ship it as `@signal/workbook-agent-wasm`. Either fork directly or build new with pi_agent_rust as the design reference; either way the design principles are well-validated.

### Architecture

```
.workbook (HTML)
├── manifest (JSON)              ← document structure
├── data (Arrow IPC)             ← embedded data
├── outputs (state)              ← last run results
├── @workbook/runtime-wasm ← cell execution (Polars, Candle, etc.)
└── @signal/workbook-agent-wasm   ← agent (LLM clients + tools + sessions)
    ├── LLM provider clients (Anthropic, OpenAI, etc.) via fetch
    ├── Tool calling protocol
    ├── Streaming SSE parser
    ├── Session state (in-memory + IndexedDB persistence)
    ├── Capability gating + trust policies
    └── QuickJS for user-defined tool extensions
```

The agent bundle is ~3–5 MB compressed (no QuickJS) or ~6–8 MB (with QuickJS). Loaded on demand — workbooks that don't include a chat composer don't load it. When a user opens a workbook and types into the composer, the agent bundle initializes and is ready in ~200ms.

### The agent's tool set

The agent's bash/find/grep/fs tools (from pi_agent_rust) are replaced with workbook-native tools that call into the runtime:

**Document mutation tools:**
| Tool | Purpose |
|------|---------|
| `read_manifest()` | Returns the current manifest tree |
| `append_block(block)` | Append a block |
| `insert_block(block, after_id)` | Insert at position |
| `update_block(id, patch)` | Modify existing block |
| `delete_block(id)` | Remove block |
| `reorder_blocks(ordered_ids)` | Rearrange |

**Cell execution tools** (call into `workbook-runtime-wasm`):
| Tool | Purpose |
|------|---------|
| `run_polars(expr)` | Execute Polars LazyFrame |
| `run_sql(query)` | Run DuckDB-WASM query |
| `run_rhai(script)` | Execute Rhai script |
| `run_inference(model, input)` | Candle inference |
| `query_table(table, sql)` | Read embedded SQLite table |
| `write_table(name, data)` | Write to SQLite layer |

**External tools** (require network):
| Tool | Purpose |
|------|---------|
| `fetch_url(url)` | HTTP fetch (CORS-restricted; proxied via Signal if configured) |
| `search_web(query)` | Web search via Signal proxy with API key |
| `load_workbook(slug)` | Cross-workbook load (pinned via lockfile) |
| `load_model(hf_id)` | Pull model artifact from Hugging Face |

**User interaction tools:**
| Tool | Purpose |
|------|---------|
| `ask_user(prompt, schema)` | Pause and ask the user via the composer |
| `show_diff(before, after)` | Show proposed change for approval |

The agent never executes shell, filesystem ops, or arbitrary network calls. Its capability surface is defined entirely by the workbook tools — strict, auditable, safe by construction.

### LLM credential management

The agent needs to call an LLM provider. Three credential paths, in precedence:

1. **User-provided key (browser-local)**: User enters their Anthropic / OpenAI key in workbook settings. Stored in `localStorage`, scoped to origin, never leaves the browser. The agent uses it directly via `fetch` to the provider's API. **Truly client-side — no Signal involvement.**
2. **Signal CORS proxy with user-managed key**: User stores their key in Signal's credential vault. Workbook makes calls to `https://proxy.signal.app/llm` which forwards using that key. Lets workbooks shared with collaborators use the owner's key without exposing it.
3. **Signal-provided LLM access**: For users on a paid plan, Signal provides metered LLM access via the proxy with Signal-managed keys. Usage counts against the user's plan.

Mode 1 is the strongest privacy story — no data, no prompts, no responses ever touch Signal infrastructure. Mode 3 is the easiest UX — users don't manage keys.

### Trust and capability gating

Following pi_agent_rust's deny-by-default policy model, every agent action runs through a trust check:

```rust
// Example: agent attempts append_block
trust_policy.check(Action::AppendBlock {
  block_kind: "cell",
  cell_language: "rhai",
})
// → returns Allow | RequireUserApproval | Deny
```

Default policies (configurable):

| Action | Default policy |
|--------|---------------|
| Read manifest | Allow |
| Run cell (already in workbook) | Allow |
| Append display block (paragraph, chart) | Allow |
| Append runnable cell | Require approval |
| Modify existing cell source | Require approval |
| Delete block | Require approval |
| Fetch URL | Allow (subject to CORS) |
| Load model from HF | Require approval (large download) |
| Cross-workbook load | Allow if pinned, else require approval |
| Set schedule | Require approval |
| Modify permissions | Deny (user only) |

User approval is inline in the composer: "The agent wants to delete cell-abc123. [Allow once] [Allow always] [Deny]". Decisions are remembered per workbook + user.

### Session state and persistence

Agent conversation state lives in:
- **In-memory**: while the workbook is open, the active session is an in-memory data structure
- **IndexedDB**: on close or periodically, sessions are persisted to the browser's IndexedDB scoped to the workbook's slug
- **Optional Convex sync**: when connected to Signal hosted, sessions can also sync to the user's Convex record so they're available across devices

The JSONL v3 tree-structured session format from pi_agent_rust ports directly. Conversation branching ("revert and try a different prompt") works the same way client-side.

### What you can build with this

**1. Self-refining workbooks.** Email a workbook. Recipient opens it, types into the composer: "make the chart use absolute counts." Agent reads the manifest, finds the chart block, mutates its config, re-renders. All client-side. No account, no server, no API key (if recipient has their own LLM key set).

**2. Domain-specific workbook templates.** A medical-research workbook ships with an agent system prompt that knows about clinical trial methodology, statistical conventions, and FDA reporting requirements. Recipients refine the analysis through the embedded agent without ever leaving the workbook context.

**3. Stateful workbook conversations.** A workbook is opened repeatedly over weeks. The agent has persistent memory of past refinements, decisions, and user preferences (stored in IndexedDB). The workbook "learns" how the user wants to think about the data.

**4. Multi-agent workbooks.** A workbook can ship multiple agents — each scoped to a different role (Analyst, Reviewer, Forecaster). Users invoke whichever fits the task. Agents reference each other's outputs through the document.

**5. Offline-first AI work.** Power users on planes, in SCIFs, behind firewalls — the workbook + a local LLM (Ollama at `http://localhost:11434`) gives them the full Signal experience disconnected from any external network.

**6. Headless agent runs.** A `.workbook` opened in a headless browser (Playwright) can run its agent with a scripted user message and produce a refined output. CI/CD pipelines that "ask the workbook to update itself" become trivial.

### Embedded agent in the manifest

Workbooks declare their embedded agent in the manifest:

```json
"agent": {
  "enabled": true,
  "bundle": "@signal/workbook-agent-wasm@1.0",
  "systemPrompt": "You are a financial analyst assistant. Help refine churn analyses...",
  "model": {
    "provider": "anthropic | openai | local",
    "name": "claude-sonnet-4-6",
    "credentialMode": "user-key | signal-proxy | local-llm"
  },
  "tools": {
    "enabled": ["read_manifest", "append_block", "update_block", "run_polars", ...],
    "disabled": ["delete_block"]
  },
  "trustPolicy": "balanced | safe | permissive | custom",
  "extensions": [
    { "name": "domain-glossary", "url": "...", "trust": "user-approved" }
  ],
  "session": {
    "persist": true,
    "syncToConvex": false
  }
}
```

The agent is configured *by the original author* (often the Signal agent itself, generating a workbook with an embedded agent for the recipient). The recipient inherits this config; they can override the model and credentials but not the trust policy or tool allowlist (preventing a malicious sender from generating a workbook with an over-permissive agent).

### Strategic implications

**Competitive positioning sharpens dramatically.** Today's AI products fall into two camps:

- **Hosted agents** (Devin, Cursor, GitHub Copilot Workspace, Replit Agent): the agent lives on the vendor's servers; you rent access
- **Local-first chat clients** (Open WebUI, ollama with frontends): the agent is a UI to a local LLM; nothing else

A `.workbook` with an embedded agent is **neither**. It's a portable, self-contained AI artifact that includes:
- The document/output
- The runtime that executed it
- The agent that authored it
- The conversation that refined it
- All in one file, runnable forever, anywhere

No competitor ships this shape. Closest: Anthropic's Artifacts, but those are static HTML with no embedded agent or runtime. Marimo notebooks, but those are Python-via-Pyodide and have no agent layer.

**The artifact-as-product thesis.** If Signal commits to embedded agents, the product story becomes:

> "We don't sell access to AI. We sell the AI artifacts themselves. Generate a workbook. Ship it. The agent ships with it. The runtime ships with it. The data ships with it. Your customer opens it offline, talks to the agent that built it, refines the analysis themselves. Nothing expires. Nothing requires our servers. Signal's value is the agent that authors workbooks AND the hosted runtime for the rare workbook that needs heavy compute. Everything else is yours forever."

This is genuinely category-defining. It's what a Word document is for text — but for AI-driven analysis. A complete, portable, self-contained, runnable, refinable artifact.

### Implementation notes

**Forking pi_agent_rust vs. building new.** The pi_agent_rust codebase is purpose-built for CLI use with file/shell tools. A WASM port would replace ~30% of the code (tools, async runtime adaptation, terminal UI removal) while keeping the streaming, sessions, LLM clients, and capability framework intact. Realistic effort: 6–10 weeks for a competent Rust team familiar with WASM. Forking lets us upstream improvements; building new lets us shape the architecture for our needs. **Recommendation: fork, with frequent upstream contributions.**

**The QuickJS extension story.** pi_agent_rust embeds QuickJS for user extensions. This is highly relevant for workbooks: organizations want to ship workbooks with company-specific tools (a `lookup_employee` tool, a `query_data_warehouse` tool). The QuickJS sandbox is small, secure, and well-isolated — exactly right for embedded extensions. Workbooks can declare extensions in the manifest; the QuickJS runtime loads them with capability checks.

**The async runtime.** asupersync is purpose-built for pi_agent_rust. For WASM we'd likely use `wasm-bindgen-futures` and a smaller structured-concurrency layer (the Tokio in WASM story is improving but heavy). This is the riskiest piece of the port; the structured-concurrency design from asupersync is what we want, but the implementation needs significant rework.

**Bundle size budget.** Combined with `workbook-runtime-wasm`, the total runtime + agent bundle is ~15–20 MB compressed. CDN-cached on first use. For `portable` mode the inlined size is significant — workbooks with embedded agents in portable mode might be 30 MB+. This is fine for the use case (long-lived shareable artifacts) but worth noting. Tree-shaking the LLM provider clients helps — most workbooks need only one provider.

**Browser CSP.** The agent runtime needs `connect-src` permissions for whatever LLM provider it talks to. The CSP in the workbook file declares the allowed providers based on `manifest.agent.model.provider`. Adding a new provider is a manifest edit (and a re-export to update the CSP nonce).

---

## What This Changes in the Stack

### Manifest

A new `runtime` shape at the top of the manifest:

```json
"runtime": {
  "kind": "wasm | python",
  "bundle": "@workbook/runtime-wasm@1.0",
  "contractVersion": "1.0",
  "preferredHost": "browser | local | signal-hosted"
}
```

`kind: wasm` workbooks have no `environment.python` or `environment.packages` field. They have:

```json
"environment": {
  "runtimeFeatures": ["polars", "candle", "linfa", "plotters"],
  "modelArtifacts": [
    { "name": "embedding-model", "url": "...", "format": "gguf", "size": 142000000 }
  ]
}
```

`runtimeFeatures` declares which slices of the runtime the workbook uses (for tree-shaking the bundle in `portable` mode). `modelArtifacts` is new: ML models referenced by name and pulled from Hugging Face or signed Signal-hosted URLs at runtime.

### New cell types

The block catalog gains:

- `polars` — Polars LazyFrame chain (declarative DataFrame ops)
- `rhai` — Rhai script (procedural orchestration)
- `inference` — model + input + output binding (Candle / `ort`)
- `train` — algorithm + dataset + hyperparameters (Linfa)
- `wasm-fn` — call into curated function registry

The existing `cell` block becomes the catch-all for `runtime: host` workbooks; `wasm` workbooks use the structured types above.

### Agent tools

The agent's tool set adapts:

| Existing | Replaced by |
|----------|-------------|
| `run_python(source)` | `run_wasm_cell(kind, spec)` — dispatches to the appropriate cell type |
| `pip_install(pkg)` | `enable_runtime_feature(feature)` — declares a runtime feature; no install needed |
| `submit_doc(blocks)` | unchanged |
| `search_web(query)` | unchanged (uses CORS proxy via Signal) |

The agent learns to compose structured cells. Training: shadow the existing Python-emitting agent and translate its Python emissions into structured WASM cell equivalents on a corpus of past workbooks.

### Runtime contract

`runtime.proto` gets a new method set for the WASM runtime:

```proto
service WorkbookRuntimeWasm {
  rpc LoadBundle(LoadBundleRequest) returns (LoadBundleResponse);
  rpc RunPolarsCell(PolarsCellRequest) returns (CellOutput);
  rpc RunRhaiCell(RhaiCellRequest) returns (stream CellOutput);
  rpc RunInferenceCell(InferenceCellRequest) returns (stream CellOutput);
  rpc RunTrainCell(TrainCellRequest) returns (stream CellOutput);
}
```

The browser implements this service entirely client-side. Tier 3 (Signal hosted) implements the same service for headless / scheduled use. Same contract, different host, same identical wire format.

### CORS proxy for external network

WASM in the browser can't make arbitrary HTTP calls (CORS). For external API access (OpenAI, Anthropic, Pinecone, customer databases), Signal hosts a CORS proxy:

```
https://proxy.signal.app/v1/proxy
  → forwards to user-configured upstream
  → user supplies API key via Signal-managed credential vault
  → Signal logs the call (audit) and rate-limits
```

Workbooks call `https://proxy.signal.app/...` instead of upstream APIs directly. Credentials never enter the workbook file. This is also a privacy win — the workbook contains no secrets, only references to Signal-managed credentials.

---

## What's Lost

Honesty about gaps:

### 1. Heavy model training
Training a >1B parameter model needs CUDA + 40GB+ VRAM. Browser WebGPU + browser memory ceilings make this infeasible. Mitigation: Tier 3 Signal hosted. Fine-tuning (LoRA) of small/medium models works in WASM via Burn + WebGPU.

### 2. Native-dep heavy libraries
`opencv` (full), `ffmpeg` (full), `librosa` (full), Cython-only packages. Mitigations: pure-Rust subsets (`image`, `symphonia`) cover 80% of common cases; Tier 3 for the rest.

### 3. Browser network restrictions
CORS limits arbitrary HTTP. Mitigated by Signal CORS proxy (with auth and audit), but this means external API calls always route through Signal — not pure client-side.

### 4. The Prophet-shaped gap
A handful of widely-used Python tools have no Rust equivalent (Prophet, DSPy, kornia, sympy). For Prophet specifically, this is worth Signal funding a port given how prevalent it is in time-series workflows. Others can fall back to Tier 3.

### 5. Existing user knowledge
Data scientists know Python. They don't know Rust syntax. **But they don't need to** — the structured cell types are declarative, and the agent generates them. The user writes prompts; the runtime is invisible. This is actually a feature, not a bug — declarative cells are easier for non-experts than free-form Python.

### 6. Mature ecosystem habits
The Python data ecosystem has 15 years of accumulated patterns (`df.groupby().agg()`, etc.). Polars is different (better, but different). Migration friction for power users.

---

## What's Gained

### 1. Truly portable artifacts
A `.workbook` file emailed to a stranger runs without any account, server, or installation. Period. This is a category-defining property.

### 2. Cold start: gone
WASM module load is ~200ms cached, ~2s uncached. Versus 2–4 minutes for E2B sandbox cold start. Reactivity — the spec's reactive DAG with input widgets — actually feels reactive.

### 3. Privacy and compliance
Customer data never leaves the customer's browser. HIPAA, GDPR, SOC 2 stories become trivial. Regulated industries (healthcare, finance, government) become accessible markets without Signal needing FedRAMP / HIPAA infrastructure for those workbooks.

### 4. Infrastructure cost
Most workbook execution shifts from Signal-hosted compute to the user's browser. Marginal cost per workbook execution drops to roughly zero. Pricing becomes simpler — Signal sells the agent and the hosted runtime for heavy use cases, not the per-execution compute.

### 5. Offline-first
Workbooks work fully offline. The local-runtime tier from the main spec largely disappears — it's the default behavior, not an installable option.

### 6. Speed
Rust-WASM is 2–10× faster than Python-on-Pyodide for typical data work. For some operations (Polars vs pandas), it's faster than native Python. For ML inference, Candle on WebGPU rivals native PyTorch on consumer GPUs.

### 7. Security
WASM sandbox is a stronger isolation boundary than a Python process. Workbooks can't accidentally read filesystem, leak secrets, or escape the sandbox. The agent's generated code is provably safe by construction.

### 8. The differentiation moat
Every competitor in this space ships against a hosted runtime. If Signal ships against client-side WASM, the moat isn't a feature — it's an architectural property they cannot copy without a multi-year rewrite.

### 9. The agent ships with the artifact
With the embedded agent runtime, a workbook is more than a static document — it's a live, refinable AI artifact. The recipient can talk to the same agent that built the workbook, ask for changes, get them instantly, all without ever contacting Signal. This is a category competitors don't address — they ship hosted agents (Devin, Cursor) or chat clients (Open WebUI), not portable AI artifacts. Signal would be the only product where the AI travels with its output.

---

## Migration Path

Three options. Recommendation follows.

### Option A — Full pivot
Rip out Python, rebuild on Rust. All workbooks become Rust/WASM. Existing workbooks migrate via tool that translates Python cells to structured WASM cells.

- **Pro**: clean architecture, single runtime story, fastest path to differentiation
- **Con**: enormous engineering lift (~12–18 months), high risk, blocks parallel feature work, breaks existing customers

**Not recommended.**

### Option B — Hybrid (recommended)
Add Rust/WASM runtime alongside Python. The manifest declares `runtime.kind: "wasm" | "python"`. Both runtimes coexist permanently.

- The agent picks `wasm` by default for compatible workflows (most of them)
- `python` is selected automatically when the workbook needs heavy training, niche libraries, or uncovered functionality
- New workbooks default to `wasm`; old ones stay `python` until manually migrated
- Signal still hosts both runtimes; users get to pick

- **Pro**: no breaking change, gradual rollout, both worlds covered, reduces risk of WASM ceilings blocking adoption
- **Con**: maintenance burden of two runtimes; agent has to be smart about which runtime to pick

**Recommended.** This is the realistic path.

### Option C — Rust-first new format, Python legacy
Existing workbooks stay on Python forever. New workbooks are Rust/WASM only. Eventual deprecation of Python (2+ years out) once feature parity is verified.

- **Pro**: clean separation, clear migration story
- **Con**: confusing for users ("which kind do I make?"), splits the agent's effort, leaves Python rotting

**Plausible alternative if the maintenance burden of Option B becomes too much.**

---

## Implementation Sketch

### Phase 0 — Prove the runtime (4–6 weeks)
- Build minimal `@workbook/runtime-wasm` with Polars + DuckDB-WASM + Plotters
- Single demo workbook running entirely in browser
- Validate bundle size, load time, performance vs Pyodide
- **Gate**: if this isn't dramatically better than Pyodide, abandon

### Phase 1 — Cell types & runtime contract (8–10 weeks)
- `polars`, `sql`, `chart` cell types
- Connect-based `WorkbookRuntimeWasm` service
- Agent emits these cell types for compatible workflows
- Existing Python path remains for everything else

### Phase 2 — ML inference (6–8 weeks)
- `inference` cell type with Candle backend
- Model artifact resolution (Hugging Face URLs, Signal-hosted URLs)
- Quantized model support (GGUF, Q4)
- Inference benchmarks vs Python equivalent

### Phase 3 — Classical ML training (6–8 weeks)
- `train` cell type with Linfa backend
- Common algorithms: random forest, k-means, regression, SVM
- Training benchmarks vs sklearn

### Phase 4 — Agent migration (4–6 weeks)
- Server-side agent (apps/sift) learns to prefer WASM cells for compatible operations
- Heuristic for when to fall back to Python (Tier 3)
- A/B comparison: workbooks generated by old vs new agent on same prompts

### Phase 5 — Heavy ops (8–12 weeks)
- Burn + WebGPU integration for moderate model training
- CORS proxy infrastructure for external APIs
- OPFS for large local data
- WebWorkers for parallelism

### Phase 6 — Embedded agent runtime, foundation (10–14 weeks)
- Fork pi_agent_rust; strip CLI/TUI/filesystem/shell tools
- Adapt async runtime for WASM (replace asupersync with `wasm-bindgen-futures` + structured-concurrency layer)
- Compile to WASM; validate bundle size, cold start, streaming behavior
- Implement workbook tool surface: manifest mutations + runtime invocations
- Wire `@signal/workbook-agent-wasm` into `Workbook.svelte` composer
- Three credential modes: user-key (localStorage), Signal proxy, local LLM (Ollama)
- IndexedDB session persistence
- **Gate**: end-to-end demo of "open a workbook offline, ask agent to refine, see changes apply" with no Signal involvement

### Phase 7 — Embedded agent, capabilities & extensions (8–10 weeks)
- Trust policy engine (deny-by-default, per-action policies, user approval flow)
- QuickJS extension runtime ported to WASM
- `manifest.agent` schema and configuration UI
- Domain-specific workbook templates with pre-configured agents
- Multi-agent workbooks (multiple `agent` configurations per workbook)
- Optional Convex sync for cross-device session continuity
- Headless mode for CI/CD use cases (Playwright-driven workbook refinement)

### Phase 8 — Polish & gaps (ongoing)
- Port Prophet equivalent (high-leverage gap)
- Custom function registry (`wasm-fn` block)
- Migration tool: Python workbook → WASM workbook (best-effort)
- Upstream contributions back to pi_agent_rust

Total realistic timeline for compelling parity with Python path AND embedded-agent shipped: **14–20 months**, with usable client-side data runtime at month 4 and embedded agent at month 12.

---

## Open Questions

1. **Bundle size ceiling.** A 10–15 MB WASM bundle is acceptable on broadband, painful on mobile. Tree-shaking via `runtime.runtimeFeatures` mitigates this — most workbooks don't need Burn or Candle. A minimal "data + SQL" bundle might be 3 MB. But if the agent needs to load multiple feature slices, total grows.

2. **Model artifact distribution.** Where do the 100 MB+ ML model files live? Hugging Face Hub URLs work but introduce a third-party dependency. Signal-hosted CDN gives control but costs storage + bandwidth. Probably both, with a cache layer.

3. **Browser memory ceilings.** WASM has ~4 GB memory cap (32-bit). Workbooks loading large models or large DataFrames hit this. OPFS helps for large data; model size is harder. Mitigations: 64-bit WASM (memory64) is in development; quantized models cut memory drastically.

4. **WebGPU availability.** WebGPU is in Chrome stable, Edge stable, Firefox in flag, Safari in TP. Mobile coverage incomplete. Workbooks needing GPU degrade to CPU on unsupported browsers.

5. **The Tier 3 product.** If most workbooks run client-side, what does "Signal hosted" sell? Likely: scheduled runs, headless API serving, MCP servers, the agent itself, large training, integration with customer infrastructure. Pricing pivots from per-execution to subscription + agent usage.

6. **Migration of existing Python workbooks.** Best-effort tool that translates common patterns. Some workbooks won't migrate cleanly. Honest answer: those stay on Python forever, gradually rebuilt by users when convenient.

7. **Custom code escape hatch.** The `wasm-fn` registry pattern handles power-user needs without arbitrary Rust. But onboarding for "I need a function that doesn't exist in the registry" needs to be smooth — probably a "Submit function for review and signing" flow with quick turnaround.

---

## Strategic Pitch

If Signal commits to this pivot — both the WASM data runtime and the embedded agent — the product story sharpens dramatically:

> **Signal builds AI artifacts. They live as `.workbook` files. The file IS the document, IS the data, IS the runtime, IS the agent. You generate one in Signal, email it to anyone, they open it, the agent that built it travels with it, the runtime that ran it travels with it, the data is embedded inside it. They talk to the agent. They run cells. They refine the analysis. All in their browser. Offline. Forever. Their data never leaves their network. Yours never leaves theirs. No expiration, no subscription, no server, no vendor lock-in. Signal sells the experience of authoring these artifacts and the hosted runtime for the rare workflow that needs heavy compute. Everything else is yours forever.**

Compared with every competitor:
- **vs OpenAI / Anthropic**: their analyses are chat outputs you copy and paste. Ours are runnable artifacts with embedded agents.
- **vs Anthropic Artifacts**: theirs are static HTML with no agent, no runtime, no data layer. Ours are live, refinable, executable.
- **vs Hex / Mode / Deepnote**: their notebooks die when you stop paying. Ours run forever.
- **vs Marimo**: theirs is bottlenecked by Pyodide and has no agent layer. Ours is native Rust speed and ships with an agent.
- **vs Jupyter**: theirs requires a kernel server. Ours requires nothing.
- **vs Devin / Cursor / Copilot Workspace**: their agents are hosted; you rent access. Ours travels with the artifact.
- **vs Open WebUI / local-LLM frontends**: theirs are chat clients; nothing else. Ours is a complete AI artifact.

This is a category-defining position. The closest combination of "AI agent + portable artifact + client-side runtime" doesn't exist as a product anywhere today. It's worth the engineering investment if the team has the capacity.

The honest bear case: Python's ML ecosystem moat is real (Prophet-shaped gaps will frustrate users), pi_agent_rust isn't WASM-ready and the port is real work, the bundle size of runtime + agent is large for mobile, and the agent retraining is a substantial effort. The honest bull case: the pivot creates an architectural moat that Python-bound competitors structurally cannot match in less than 2–3 years — and the "your AI artifact, with the agent that built it, runs offline forever, anywhere" pitch is genuinely differentiating in a market where everyone is shipping hosted chatbots and rented agents.

The decision is whether Signal is building "another AI notebook tool" or "the first AI-native artifact format that includes its own agent." This pivot is the difference. The artifact-as-product thesis becomes the company's strategic moat.
