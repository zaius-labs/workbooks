# Workbook Format Specification

## Vision

A `.workbook` is the canonical artifact format for **portable browser apps with an embedded execution runtime**. Reports, notebooks, data analyses, ML experiments, recurring monitors, full chat agents, multi-page Svelte SPAs — all expressed as a single canonical type. There is no separate "report type" or "app type". A workbook can be opened in a browser as a static document, executed as a live notebook, scheduled as a recurring pipeline, called as an API, or served as an MCP server. These are modes of the same artifact, not different artifact types.

## Three canonical types

`manifest.type` (string, optional, default `"spa"`) declares which rendering profile a host should apply. Same format, same runtime, same env contract across all three:

| `type`     | Shape | Example | Host renders |
|------------|-------|---------|---|
| `document` | Read-mostly. Prose + auto-rendered blocks (charts, tables, citations). No agent loop or compute affordances surfaced to the reader. | a quarterly report, a published analysis | Paper-like reader chrome wrapping the workbook tree |
| `notebook` | Linear runner with cells in a static DAG. Reactive execution; reader edits inputs, re-runs cells, sees outputs materialize. | an ML experiment, a data exploration | Notebook chrome with run/restart/clear controls |
| `spa`      | Full canvas application. Author renders whatever UI they want; runtime is a service available on demand. | `examples/chat-app/`, `examples/svelte-app/` | None — workbook renders itself |

Type is a hint to consumers about what chrome (if any) to wrap the workbook in. It is **not** a build-path branch — the same `.html` file format produces all three. Cells, inputs, manifest schema, runtime contract, env declarations are identical.

## Format

The format is a self-contained HTML file that opens in any browser without installation. **Cells, when present, execute in a Rust runtime compiled to WebAssembly that ships with the workbook** — Polars for DataFrames + SQL, Candle for ML inference, Linfa for classical ML, Plotters for visualization, Rhai for scripting glue. SQLite via `@sqlite.org/sqlite-wasm` is available as an opt-in JS-side sidecar for non-Polars SQL. No Python sandbox, no server-side compute for the common path, no cold start. A workbook is fully runnable in the browser the moment it loads. Heavy or specialized workloads can opt into a Signal-hosted runtime (Tier 3 below), but the default — and the differentiator — is client-side execution.

For SPA workbooks, cells are usually empty — the author is rendering a custom UI directly. The wasm runtime is still available on demand via `virtual:workbook-runtime` (or, for hand-written single-file workbooks, by reading the inlined `<script id="*">` blocks at boot).

See `WORKBOOK_RUST_PIVOT.md` for the full architectural rationale and tool mapping from Python ecosystem equivalents. See `WORKBOOK_AS_APP.md` for the SPA authoring patterns (chat-app + svelte-app exemplars, build tool, env contract, trigger-substring discipline).

---

## File Format

### Extension & MIME

```
extension:                       .workbook
content-type (view):             text/html; charset=utf-8
content-disposition (view):      inline
content-type (download):         text/html; charset=utf-8
content-disposition (download):  attachment; filename="<title>.workbook"
```

`/workbook/<slug>` in Signal serves `inline` so browsers render it. `/workbook/<slug>/export` uses `attachment` to trigger a download. A `.workbook` file opened directly from disk renders as standard HTML in any browser.

### Export modes

A workbook is exported in one of two modes, declared in `manifest.exportMode`. The user picks at the export dialog based on intent.

| Mode | Size | External deps | Use case |
|------|------|--------------|----------|
| `linked` *(default)* | minimal | Signal CDN for runtime JS, R2 for large data | Internal sharing, embedding, links between Signal users |
| `portable` | larger | none — everything inlined | Email to external recipient, compliance archive, "open this in 5 years" |

**`linked` mode** uses external resources for efficiency. The runtime JS is loaded from `cdn.signal.app`. SQLite > 5 MB is stored on R2 and fetched lazily; an inline preview slice (first 1,000 rows per table) keeps display blocks rendering instantly. Total file size typically < 1 MB regardless of underlying data volume.

**`portable` mode** inlines everything: the full SQLite (no preview slicing), the runtime JS (~200 KB), and all referenced images as base64 data URIs. The file may be 50+ MB but works forever, anywhere, with nothing external. No CDN, no R2, no server. This is the archival format.

The `data` and `runtime` sections of the manifest indicate where each layer comes from:

```json
"exportMode": "linked | portable",
"data": {
  "mode": "embedded | external",
  "externalUrl": "string",
  "previewSlice": false
},
"runtime": {
  "jsSource": "cdn | inline",
  "cdnUrl": "https://cdn.signal.app/workbook-runtime/v1.js"
}
```

All `.workbook` files are served with `Content-Encoding: gzip`. Base64-encoded binary content compresses 40–60% in practice.

**Browser compat**: Chrome limits data URIs to ~2 MB. Workbooks in `linked` mode with many embedded images use external URLs for those assets to avoid silent download failures. `portable` mode uses base64 throughout but accepts the resulting file size.

### Embedded layers

A `.workbook` file is valid HTML containing four structured script layers plus a Svelte app mount point:

```html
<!-- Layer 1: Manifest -->
<script type="application/workbook+json">{ ... }</script>

<!-- Layer 2: Tabular data (embedded fully or as preview slice) -->
<script type="application/workbook+sqlite">base64-encoded SQLite3 DB</script>

<!-- Layer 3: Execution state from the last run -->
<script type="application/workbook+state">{ ... }</script>

<!-- Layer 4: Svelte UI runtime + compiled components (CDN in linked, inline in portable) -->
<script src="https://cdn.signal.app/workbook-runtime/v1.js" nonce="..."></script>

<!-- Layer 5: Rust/WASM execution runtime (CDN in linked, inline in portable) -->
<script src="https://cdn.signal.app/workbook-runtime-wasm/v1.js" nonce="..."></script>

<!-- Mount point + bootstrap -->
<body>
  <div id="app">
    <div class="workbook-skeleton">…</div>  <!-- minimal loader -->
  </div>
</body>
<script nonce="...">
  import { mount } from '@workbook/runtime';
  import Workbook from '@workbook/runtime/Workbook.svelte';
  import { initWasmRuntime } from '@workbook/runtime-wasm';
  await initWasmRuntime();
  mount(Workbook, { target: document.getElementById('app') });
</script>
```

**Layer 1 — Manifest**: Structured document definition. Machine-parseable. Drives everything: blocks, parameters, schedule, dependencies, API exposure, MCP surface, runtime config, provenance.

**Layer 2 — Tabular data**: Arrow IPC format (or SQLite database for SQL-heavy workbooks). Polars queries this layer with zero-copy. Updated on every run. May be a preview slice in `linked` mode for large workbooks; the full data is fetched from R2 lazily.

**Layer 3 — State**: Serialized cell output state from the last run — pre-rendered plots (base64 PNG), text outputs, computed values. The file never looks broken; outputs are always visible because they were embedded at generation time.

**Layer 4 — Svelte UI runtime + components**: The compiled `@workbook/runtime` bundle (~250 KB) containing all block components, the runtime control plane client, and the Svelte mount logic. Loaded from CDN in `linked` mode (cross-workbook caching) or inlined in `portable` mode. The `mount()` call instantiates `Workbook.svelte`, which reads the manifest and renders every block.

**Layer 5 — Rust/WASM execution runtime**: The compiled `@workbook/runtime-wasm` bundle (~10–15 MB) containing Polars (DataFrames + SQL), Candle (ML inference), Linfa (classical ML), Burn + WebGPU (training), Plotters / Charming (charts), Rhai (scripting glue), tokenizers, and arrow-rs. SQLite via `@sqlite.org/sqlite-wasm` is a JS-side sidecar (lazy-loaded only when a workbook declares `language: "sqlite"`). Loaded once from CDN, cached aggressively across workbooks. In `portable` mode, the bundle is inlined for true offline portability.

The body is empty until JS loads (`<div id="app">` with a small skeleton loader). Once the runtime mounts, the document is fully reactive — interactive components are first-class, not progressively-enhanced static HTML.

### Security: Content Security Policy

Every `.workbook` ships with a strict CSP in its `<meta>` tag:

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               script-src 'nonce-<generated>' https://cdn.signal.app;
               style-src 'nonce-<generated>';
               img-src 'self' data: blob: https://*.signal.app;
               connect-src https://*.signal.app https://localhost:*;
               frame-ancestors 'none'">
```

The nonce is generated fresh per export. No inline scripts execute without the nonce — including any injected content. `connect-src` allows `localhost:*` so the local runtime host (Tier 2, see below) can connect.

Svelte's reactivity uses inline event handlers compiled to safe property bindings, not `eval` or string-based handlers — so it is fully compatible with strict CSP. The mount script in the workbook is permitted by the nonce; no other inline scripts execute.

All text-field content in display blocks is rendered through Svelte components that use Svelte's safe text interpolation (`{value}`), which auto-escapes by default. The sanitizing markdown processor is `mdsvex` or equivalent, which produces a parsed AST that Svelte renders as DOM nodes — no `innerHTML`, no raw HTML injection. Image `url` fields are validated to reject `javascript:` URIs and non-HTTPS schemes at write and render time.

Diagram blocks using `syntax: graphviz` are pre-rendered to SVG at generation time (server-side, in the runtime sandbox) and stored as static SVG. The Graphviz binary is not shipped to the browser. Mermaid diagrams render client-side via the Mermaid library loaded via the CSP-permitted script source.

---

## Source of Truth

**The Convex `workbooks` table is canonical. The `.workbook` file is an export snapshot.**

The Convex record is the live, authoritative version. The `.workbook` file is generated deterministically from it at export time and carries an `exportedAt` timestamp.

If a `.workbook` file is re-imported into Signal:
- If `manifest.id` matches an existing record and `exportedAt` is more recent than the record's `updatedAt`, Signal offers to import the changes
- If `manifest.id` matches but `exportedAt` is stale, the import is rejected with a conflict error
- If `manifest.id` is absent or unrecognized, the file is treated as a new workbook

The Convex record uses `updatedAt` as an optimistic lock. Writes that arrive with a stale value are rejected, preventing concurrent schedule runs from silently overwriting each other.

---

## Runtime Hosts

A workbook's format is portable. The Rust/WASM execution runtime ships with the workbook itself, so cells run client-side by default with no server involvement. For workloads that exceed browser capabilities (large model training, native deps, scheduled headless runs, MCP serving), Signal hosts a Tier 3 runtime that implements the same contract.

Three tiers cover the realistic deployment surface:

### Tier 1: Browser-native (default, primary)

No install, no account, nothing. Open the `.workbook` file in any browser:
- All display blocks render (charts, tables, metrics, prose, diagrams)
- SQL cells run via Polars-SQL (or the SQLite sidecar when declared) against the embedded data layer
- Polars cells run DataFrame operations natively in WASM
- Rhai cells orchestrate calls into the WASM runtime
- Candle inference cells run ML models (including quantized LLMs up to ~3B params)
- Linfa training cells train classical ML models
- Plot blocks render via Plotters
- Inputs are reactive; the dependency graph re-executes on changes
- Streaming cell output via SSE
- Cross-workbook `load()` against pinned dependencies (cached locally)

This is the default tier. Most workbooks never leave it. Recipient opens the file; everything works.

### Tier 2: Self-hosted runtime

Optional. For organizations running a self-hosted Signal stack, or for the rare case where an exported workbook needs scheduled execution without depending on Signal SaaS:

```bash
docker run -p 7700 signal/workbook-runtime
# → http://localhost:7700
```

The runtime image embeds the same `@workbook/runtime-wasm` bundle plus a thin HTTP server, scheduling daemon, and persistence layer. It implements the full WorkbookRuntime contract for headless use cases (CI/CD pipelines, scheduled runs in air-gapped environments, on-prem deployments).

Tier 2 is optional in this architecture — most users never need it because Tier 1 already handles their workflows.

### Tier 3: Signal hosted

For workloads that exceed Tier 1's browser capabilities or require Signal infrastructure:

- **Heavy model training** (>1B parameter models, sustained GPU workloads beyond browser WebGPU limits)
- **Scheduled runs** at high frequency or scale
- **Cell-as-API endpoints** (require public ingress and auth fabric)
- **MCP server mode** (require multi-tenant auth and routing)
- **CORS proxy** for external API calls (workbook → OpenAI/Anthropic via Signal-managed credentials)
- **The Signal agent** that generates new workbooks
- **Cross-workbook `load()`** for workbooks the user hasn't pinned locally
- **Multi-user collaboration** with permissions enforcement

A team can also self-host the Signal stack (Convex + R2 + the Tier 3 runtime). The format is identical; the URL prefix changes.

### The runtime contract

A workbook host implements a documented interface:

```ts
interface WorkbookRuntime {
  loadManifest(workbook: WorkbookFile): Promise<Manifest>;
  initRuntime(features: RuntimeFeatures): Promise<RuntimeId>;
  runCell(runtimeId: RuntimeId, cell: Cell, params: Params): AsyncIterable<CellOutput>;
  pauseRuntime(runtimeId: RuntimeId): Promise<void>;
  destroyRuntime(runtimeId: RuntimeId): Promise<void>;
}
```

The Tier 1 implementation (in-browser WASM) and the Tier 3 implementation (Signal hosted) both implement this interface identically. Workbook code makes the same Connect-based RPC calls regardless of which tier is connected.

The contract lives in `@workbook/runtime-spec`.

### The runtime selector

When a workbook is opened, the page UI surfaces a runtime picker:

```
Runtime: [ Browser ▼ ]
         · Browser (active — runs locally, no server)
         · Signal hosted (signed in as you@company.com)
         · Self-hosted (http://localhost:7700)
```

Default is Browser. `manifest.runtime.preferredHost` records the user's last choice. The UI auto-promotes to Signal hosted only when a cell explicitly requires capabilities the browser tier can't provide (large training, MCP serving, scheduled runs).

---

## Wire Protocols & Schema

The format and runtime use four distinct wire protocols, each suited to its data shape. A single Protobuf schema (`workbook.proto`) is the canonical source of truth for type definitions across all of them.

### Schema as source of truth

`workbook.proto` defines every type in the system: manifest, blocks, cell outputs, runtime contract, cell-as-API request/response. Managed via the [Buf schema registry](https://buf.build) and published as `signal/workbook`. From this single schema, code generation produces:

- TypeScript types for the Svelte UI
- Rust types for the WASM runtime (cell execution, the agent runtime)
- Python, Go, JavaScript, and Rust client SDKs (for cell-as-API consumers and third-party hosts)
- JSON Schema for runtime validation
- OpenAPI definitions for the cell-as-API surface

This means the manifest's JSON shape, the runtime gRPC stubs, and the cell-as-API request bodies all derive from the same definitions. Adding a field is one schema change with regenerated bindings everywhere.

### Layer 1: Manifest — JSON in the file, Protobuf as schema

The embedded manifest stays as JSON. Workbooks remain valid, inspectable HTML; you can View Source on a workbook and read its structure without tooling. The Protobuf schema is the *type definition*, not the encoding. The `workbook.proto` file specifies the shape; `application/workbook+json` is the wire encoding embedded in the file.

This trade-off is deliberate. Binary Protobuf in the file would make workbooks opaque to humans and standard text tools (`grep`, `jq`, View Source). Keeping JSON in the file with Protobuf as the schema gives type safety and inspectability simultaneously.

### Layer 2: Runtime control plane — Connect (Protobuf + JSON)

The `WorkbookRuntime` interface is defined in `runtime.proto` and served via [Connect](https://connectrpc.com/), Buf's gRPC-compatible protocol. Connect speaks both Protobuf binary and JSON over HTTP/1.1, HTTP/2, and HTTP/3 — no gRPC-Web shim required for browser clients.

```proto
service WorkbookRuntime {
  rpc InitRuntime(InitRuntimeRequest) returns (InitRuntimeResponse);
  rpc RunCell(RunCellRequest) returns (stream CellOutput);
  rpc PauseRuntime(PauseRuntimeRequest) returns (PauseRuntimeResponse);
  rpc DestroyRuntime(DestroyRuntimeRequest) returns (DestroyRuntimeResponse);
  rpc GetRuntimeState(GetRuntimeStateRequest) returns (RuntimeState);
}
```

Browser clients (Tier 1) use `@connectrpc/connect-web` against the embedded WASM runtime exposed via an in-page bridge. Self-hosted runtimes (Tier 2) serve via `@connectrpc/connect-node`. Signal hosted (Tier 3) serves the same protocol over HTTPS. Identical wire format across tiers — the only difference is which side of the network the runtime sits on.

Debugging is `curl`-friendly (Tier 2/3):
```bash
curl -X POST https://localhost:7700/runtime.WorkbookRuntime/InitRuntime \
     -H "Content-Type: application/json" \
     -d '{"features": ["polars","duckdb","candle"]}'
```

The same endpoint accepts `Content-Type: application/proto` for binary Protobuf when performance matters.

### Layer 3: Data plane — Apache Arrow Flight

Tabular data movement uses **Arrow Flight** (gRPC + Arrow IPC). This covers:
- Cell outputs that are tables (pandas DataFrames, SQL query results)
- Cross-workbook `load()` of tables and large datasets
- MCP resource reads of SQLite tables
- Streaming model artifacts and embeddings

Why Arrow over plain Protobuf: columnar, zero-copy, designed exactly for streaming analytics data between processes. pandas, polars, DuckDB, and Spark already speak it natively. A `load("segments")` call streams Arrow record batches directly into a pandas DataFrame in the consuming cell — no JSON serialization round-trip, no schema mismatch risk.

The data plane is logically separate from the control plane. The control plane says "run cell X and stream its outputs"; if those outputs include tables, they flow over Flight, not through Connect.

### Layer 4: Cell streaming logs — JSON-Lines

When a long-running cell streams `print()` output, training logs, or progress indicators, the right format is **JSON-Lines over Server-Sent Events (SSE)**. One small JSON object per line:

```
{"kind":"stdout","content":"Epoch 1/10","timestamp":"..."}
{"kind":"stdout","content":"Loss: 0.42","timestamp":"..."}
{"kind":"progress","fraction":0.1,"label":"Epoch 1"}
```

Protobuf adds complexity without performance benefit at log-line granularity. JSON-Lines is human-readable in `curl`, easy to render incrementally in the UI, and trivial for any host to produce.

### Layer 5: Cell-as-API — content negotiated

POST endpoints exposed via `manifest.api.cells` default to JSON but support Protobuf via `Content-Type: application/proto`. The cell's `inputSchema` field generates a `.proto` definition exposed at `/workbook/<slug>/cells/<cell-id>/schema.proto`, so callers can `buf generate` against it to get typed bindings in their language.

```bash
# JSON (default)
curl -X POST .../cells/forecast \
     -H "Content-Type: application/json" \
     -d '{"inputs": {"horizon_days": 30}}'

# Protobuf (high-throughput callers)
curl -X POST .../cells/forecast \
     -H "Content-Type: application/proto" \
     --data-binary @request.bin
```

OpenAPI is generated automatically alongside the proto. SDK consumers pick whichever is more convenient.

### Schema versioning

`manifest.runtime.contractVersion` references the version of `workbook.proto` the workbook was generated against. Hosts implementing older contract versions reject workbooks with newer versions; hosts implementing newer contract versions accept older workbooks (backward-compatible within a major version). Buf's breaking-change detection enforces this at schema compile time — incompatible changes require a major version bump.

### Summary table

| Use case | Protocol | Encoding | Why |
|----------|----------|----------|-----|
| Manifest in file | — | JSON | Inspectable, View Source friendly |
| Runtime control (start/run/pause cells) | Connect (HTTP/2) | Protobuf + JSON | Schema-validated, browser-native, debuggable |
| Tabular data movement | Arrow Flight (gRPC) | Arrow IPC | Columnar, zero-copy, ecosystem-standard |
| Cell streaming logs | SSE | JSON-Lines | Human-readable, simple, line-granular |
| Cell-as-API endpoints | HTTP | JSON or Protobuf (negotiated) | Default ergonomic, opt-in performance |

---

## Manifest Schema

```json
{
  "version": "1.0",
  "kind": "workbook",
  "type": "document | notebook | spa",
  "id": "<convex id>",
  "slug": "<human-readable slug>",
  "title": "string",
  "emoji": "string",
  "description": "string",
  "createdAt": "ISO 8601",
  "updatedAt": "ISO 8601",
  "exportedAt": "ISO 8601",
  "exportMode": "linked | portable",

  // Optional. Document and notebook workbooks use blocks as their
  // primary content. SPA workbooks usually have an empty blocks
  // array — the author renders custom HTML/components directly,
  // typically pulling the wasm runtime in on demand.
  "blocks": [ /* see Block Catalog */ ],

  // Optional. Varlock-style env contract — declares what env keys
  // the workbook needs at runtime. Hosts resolve values from
  // window.WORKBOOK_ENV → namespaced localStorage; values flagged
  // `secret: true` are stripped before serialization. See
  // WORKBOOK_AS_APP.md for the full pattern.
  "env": {
    "<KEY>": {
      "label": "human-readable label",
      "prompt": "placeholder text",
      "required": true,
      "secret": true
    }
  },

  "parameters": {
    "<name>": {
      "type": "string | number | boolean | date | enum",
      "default": "<value>",
      "description": "string",
      "enum": ["option-a", "option-b"]
    }
  },

  "data": {
    "mode": "embedded | external",
    "externalUrl": "string",
    "previewSlice": false
  },

  "runtime": {
    "uiSource": "cdn | inline",
    "uiCdnUrl": "https://cdn.signal.app/workbook-runtime/v1.js",
    "wasmSource": "cdn | inline",
    "wasmCdnUrl": "https://cdn.signal.app/workbook-runtime-wasm/v1.js",
    "preferredHost": "browser | signal-hosted | self-hosted",
    "contractVersion": "1.0",
    "bundleVersion": "@workbook/runtime-wasm@1.0"
  },

  "environment": {
    "runtimeFeatures": ["polars", "duckdb", "candle", "linfa", "plotters", "rhai"],
    "modelArtifacts": [
      {
        "name": "embedding-model",
        "url": "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2",
        "format": "safetensors",
        "size": 90000000,
        "sha256": "..."
      }
    ],
    "tier3Required": false
  },

  "schedule": {
    "cron": "0 9 * * 1",
    "timezone": "America/New_York",
    "enabled": true,
    "retryPolicy": {
      "maxAttempts": 3,
      "backoffSeconds": [60, 300, 900]
    },
    "missedRunPolicy": "latest",
    "concurrencyPolicy": "skip",
    "lastRunAt": "ISO 8601",
    "lastRunStatus": "ok | error | running",
    "lastRunId": "string"
  },

  "permissions": {
    "visibility": "private | shared | public",
    "collaborators": [
      { "userId": "string", "role": "editor | viewer" }
    ]
  },

  "api": {
    "enabled": true,
    "cells": ["<cell-id>"],
    "auth": {
      "required": true,
      "scopes": ["signal:workbook:execute"],
      "allowedOrigins": ["https://yourapp.com"],
      "rateLimit": { "requestsPerMinute": 60, "perCaller": true }
    }
  },

  "mcp": {
    "enabled": true,
    "name": "string",
    "description": "string",
    "auth": {
      "public": false,
      "requiredScope": "signal:workbook:mcp"
    },
    "tools": [
      {
        "cellId": "<cell-id>",
        "name": "string",
        "description": "string",
        "inputSchema": { }
      }
    ],
    "resources": [
      {
        "table": "string",
        "uri": "workbook://<slug>/data/<table>",
        "description": "string",
        "public": false
      }
    ]
  },

  "provenance": {
    "generatedBy": "signal-agent-v1",
    "sessionId": "string",
    "agentModelId": "string",
    "promptHash": "sha256:<hex>",
    "signature": "string",
    "dependencies": {
      "<slug-or-user/slug>": {
        "runId": "string",
        "resolvedAt": "ISO 8601",
        "schemaHash": "sha256:<hex>",
        "pin": "exact | latest"
      }
    }
  }
}
```

**`slug` uniqueness**: slugs are unique per user (namespace-scoped). Cross-workbook references default to the calling user's namespace; explicit `user/slug` syntax is supported.

**`schedule.cron`**: Interpreted in `schedule.timezone`, not UTC. Implementations must use a timezone-aware parser. DST transitions are handled by the parser.

**`runtime.contractVersion`**: Identifies which version of the runtime contract this workbook expects. Hosts implementing older contract versions reject workbooks with newer versions; hosts implementing newer versions accept older workbooks (backward-compatible within a major version).

---

## Block Catalog

Every block has `id`, `kind`, and `position`. Additional fields are kind-specific.

### Display blocks

These render the same in all modes. Always pre-rendered into Layer 4.

| kind | Key fields | Notes |
|------|-----------|-------|
| `heading` | `text`, `level: 1–4` | |
| `paragraph` | `text` | Sanitized markdown inline |
| `markdown` | `content` | Full sanitized markdown |
| `callout` | `variant: info\|warning\|error\|success`, `content` | |
| `divider` | — | |
| `image` | `url`, `alt`, `caption` | HTTPS URLs only; no `javascript:` URIs |
| `video` | `url`, `caption` | |
| `table` | `sqlTable: string` | References SQLite layer |
| `chart` | `type`, `sqlTable`, `xField`, `yField`, `config` | Queries SQLite layer |
| `metric` | `label`, `value`, `unit`, `trend`, `trendValue` | Single KPI |
| `metrics` | `items: metric[]` | Grid of KPIs |
| `diagram` | `syntax: mermaid\|graphviz`, `source`, `prerenderedSvg` | Graphviz pre-rendered server-side |
| `code` | `language`, `source` | Display-only syntax-highlighted code; not runnable |

### Execution blocks

The notebook layer. Connect to the reactive dependency graph.

#### The dependency graph: derived, not declared

The DAG is **inferred by the runtime**, not declared by the agent. At save time the runtime runs a static analyzer over each cell to extract:

- **`provides`**: variables and tables the cell defines (Rhai bindings, Polars LazyFrame outputs, SQL `CREATE TABLE`)
- **`reads`**: variables and tables the cell consumes (Rhai free names, Polars input frames, SQL table references)

The DAG is then computed by matching reads against provides across cells. The agent's job is to compose coherent cells; the runtime's job is to figure out what depends on what.

```rust
// Cell A (Rhai) — analyzer extracts: provides = ["segments"], reads = ["orders"]
let segments = compute_segments(orders);
```
```rust
// Cell B (Rhai) — analyzer extracts: provides = ["churn_model"], reads = ["segments"]
let churn_model = train_model(segments);
// Runtime infers: cell-B dependsOn cell-A
```

```sql
-- Cell C (SQL) — analyzer extracts: provides = ["funnel_stats"], reads = ["events"]
CREATE TABLE funnel_stats AS SELECT stage, COUNT(*) FROM events GROUP BY stage;
```

A `dependsOn` field on the cell exists but is **derived state**, not user-authored. The runtime writes it back after analysis so it appears in the manifest for diffing and documentation, but the source of truth is the static analysis pass.

**Dynamic patterns** the static analyzer cannot resolve (Rhai `eval()`, dynamic table names from variables) are caught at runtime: cell execution is instrumented to track actual variable and table access, and any read not present in the static `reads` set updates the graph and emits a warning. Over time the graph self-heals.

**Cycle detection**: the inferred graph is validated. Cycles reject the save with `"Cycle detected: cell-A → cell-B → cell-A"`.

**Error propagation**: if a cell fails, transitive dependents go `status: "stale"` and display their last valid output with a warning badge. Execution does not cascade through a failed cell.

**Why static + runtime instead of agent-declared**: the agent will reliably get this wrong on workbooks of even moderate complexity. Missing dependencies produce stale outputs (wrong answers); spurious ones waste compute. Static analysis is well-trodden territory (marimo, Observable Framework). Runtime instrumentation is cheap and catches what static analysis misses.

#### `cell`

The core runnable unit. Cells are **structured** — they declare what kind of computation they perform, not free-form code in a general-purpose language. This is what makes client-side WASM execution possible without compilation overhead.

```json
{
  "kind": "cell",
  "id": "cell-abc123",
  "language": "sql | polars | rhai | candle-inference | linfa-train | chart | wasm-fn",
  "runtime": "wasm | host",
  "source": "string",
  "spec": { /* language-specific structured spec; see below */ },
  "provides": ["variable-name", "table-name"],
  "reads": ["variable-name", "table-name"],
  "dependsOn": ["cell-id"],
  "status": "pending | running | ok | error | stale",
  "outputs": [
    {
      "kind": "text | image | table | error | stream",
      "content": "string | base64 | { table: string }",
      "mimeType": "text/plain | image/png | ...",
      "executedAt": "ISO 8601"
    }
  ],
  "streaming": false
}
```

**Cell languages**:

- `sql` — DuckDB-WASM or DataFusion query against the embedded data layer
- `polars` — Polars LazyFrame chain (declarative DataFrame operations)
- `rhai` — Rhai script orchestrating multiple runtime calls (procedural glue)
- `candle-inference` — declarative model inference: model reference + input binding + output spec
- `linfa-train` — declarative classical ML training: algorithm + dataset + hyperparameters
- `chart` — Plotters / Charming declaration: chart type + data binding + style config
- `wasm-fn` — call into a curated function from a registered WASM function library (the escape hatch for custom compute, governed by the same trust model as the `widget` block)

The agent never writes free-form Rust or Python — it composes structured cells against the runtime's stable API. This makes generated content safe (no arbitrary code), inspectable (declarative), and uniform.

**Runtimes**:

- `runtime: wasm` runs in the embedded WASM runtime in-browser. No server needed. Default for all `language` values above.
- `runtime: host` routes to a connected Tier 3 runtime. Used only when a cell explicitly requires capabilities the WASM tier can't provide (heavy training, scheduled headless execution, MCP serving, CORS-bounded external APIs). Falls back to displaying embedded outputs when no host is reachable.

`provides` and `reads` are populated by the static analyzer, not the agent. `dependsOn` is derived from these.

#### `input`

A parameter widget. Its value flows into dependent cells via the inferred graph.

```json
{
  "kind": "input",
  "id": "input-abc123",
  "name": "cohort",
  "label": "Cohort",
  "inputType": "text | number | select | date | slider | toggle",
  "default": "enterprise",
  "options": ["enterprise", "smb", "startup"],
  "description": "string"
}
```

When `name` matches a key in `manifest.parameters`, the input also accepts URL query overrides. URL params take precedence.

`input` blocks `provide` a variable matching their `name`. Cells that read that name are inferred dependents.

#### `cellRef`

Pins a specific output from a cell at a different position in the document. Used when a cell produces multiple outputs and one should be surfaced separately.

```json
{
  "kind": "cellRef",
  "cellId": "cell-abc123",
  "outputIndex": 0
}
```

#### `widget`

References a curated Svelte component from a registered widget library. Lets workbooks express custom interactive UI (specialized charts, dashboards, simulators) without embedding arbitrary code.

```json
{
  "kind": "widget",
  "id": "widget-abc123",
  "library": "@signal/widgets",
  "component": "kpi-funnel",
  "version": "^2.0",
  "props": {
    "stages": ["awareness", "consideration", "conversion"],
    "sqlTable": "funnel_stats"
  },
  "dependsOn": ["cell-abc123"]
}
```

The widget code is fetched from the registered library, not embedded in the workbook. The runtime resolves `library@version` against trusted registries — `@signal/widgets` is built-in; additional registries are user- or organization-configured. Widgets that reference unregistered libraries fail to render with an explicit "untrusted widget library" error rather than silently executing arbitrary code.

Widget components receive `props` directly and may declare `reads` against SQLite tables (queried via the runtime's data plane). They participate in the reactive graph like any other block.

Arbitrary user-authored Svelte source embedded directly in a workbook is **not supported**. Custom UI flows through the widget registry pattern.

#### `step`

A named pipeline stage grouping cells. Replayable independently.

```json
{
  "kind": "step",
  "id": "step-abc123",
  "name": "string",
  "description": "string",
  "cells": ["cell-id"],
  "autorun": false,
  "status": "pending | running | ok | error",
  "lastRunAt": "ISO 8601"
}
```

`autorun: true` marks the step for automatic replay when the runtime cold-starts (page reload, fresh Tier 3 instance), restoring variable state without manual intervention.

#### `machine`

ML training or inference with structured provenance. The block IS the model card.

```json
{
  "kind": "machine",
  "id": "machine-abc123",
  "modelKind": "string",
  "config": { },
  "trainingData": {
    "sqlTable": "string",
    "query": "string",
    "rowCount": 0,
    "hash": "sha256:<hex>"
  },
  "versions": [
    {
      "trainedAt": "ISO 8601",
      "artifact": {
        "url": "string",
        "signedUrlExpiresAt": "ISO 8601",
        "size": 0,
        "format": "onnx | safetensors"
      },
      "metrics": { "accuracy": 0.94, "f1": 0.91 },
      "runId": "string"
    }
  ],
  "cellId": "cell-abc123"
}
```

**`trainingData.hash`**: SHA-256 of raw training data bytes, hex-encoded. Algorithm fixed.

**`artifact.format`**: `pickle` is excluded — pickle executes arbitrary code on load. Supported: `onnx` (portable), `safetensors` (safe-by-design). Pickle artifacts are rejected at save time.

**`artifact.url`**: Signed R2 URL with expiry. New signed URLs are generated per recipient when shared.

**`versions`**: Each training run appends an entry. Most recent is current. History is preserved for diff and replay.

#### `loop`

Runs cells over an iterable, producing a result per iteration.

```json
{
  "kind": "loop",
  "id": "loop-abc123",
  "over": {
    "kind": "input | table | literal",
    "value": "input-name | table-name | [1, 2, 3]"
  },
  "cells": ["cell-id"],
  "parallelism": 4,
  "errorPolicy": "continue | halt",
  "outputTable": "loop_results",
  "status": "pending | running | ok | partial | error"
}
```

**`over`**: Tagged object eliminates ambiguity. `input` references a widget's options; `table` iterates SQLite rows; `literal` is a hardcoded array.

**`parallelism`**: Each parallel iteration runs in a separate runtime instance (a fresh WASM module instance in Tier 1, or a separate Tier 3 worker) for isolation. Multiplies compute cost. Default 1.

**`errorPolicy`**: `continue` records failed iterations as error rows in `outputTable`; `halt` stops at first failure.

**`outputTable`**: Iteration results merge into a SQLite table with this name. Schema inferred from first successful iteration. Failures contribute a row with `_error: string` and null other columns.

---

## Rendering & Components

A workbook is a Svelte 5 application. The same components that render the live Signal UI render every exported workbook. There is no separate static-HTML rendering path, no SSR step, no duplicated rendering logic.

### Single source of truth

Block components live in `apps/web/src/lib/sdoc/blocks/`:

```
Heading.svelte    Paragraph.svelte    Markdown.svelte    Callout.svelte
Image.svelte      Video.svelte        Divider.svelte     Table.svelte
Chart.svelte      Metric.svelte       Diagram.svelte     Code.svelte
Cell.svelte       Input.svelte        CellRef.svelte     Step.svelte
Machine.svelte    Loop.svelte         Widget.svelte
```

A root `Workbook.svelte` reads the manifest, walks the block tree, and dispatches each block to its component. The same root mounts in three contexts:

| Context | How it mounts |
|---------|--------------|
| Live Signal app | `<Workbook manifest={…} runtime={signalHost} />` inside the SvelteKit app |
| Exported `.workbook` file | `mount(Workbook, { target: '#app', props: { manifest, runtime: detectHost() } })` from the embedded bundle |
| Tier 2 local runtime | Same mount, with `runtime` pointing at `localhost:7700` |

The component hierarchy is identical across contexts. Differences are confined to the `runtime` prop — which client to use for cell execution.

### The runtime bundles

Two complementary bundles cooperate to render and execute a workbook:

**`@workbook/runtime`** (~250 KB gzipped) — the Svelte UI layer:
- All block components (compiled Svelte)
- The Svelte 5 runtime
- The Connect client for the runtime control plane
- The Arrow Flight client for the data plane (used to stream data between WASM cells)
- The mount logic and host detection
- The bridge to `@workbook/runtime-wasm`

**`@workbook/runtime-wasm`** (~10–15 MB compressed) — the Rust execution layer (Layer 5):
- Polars (DataFrames)
- DuckDB-WASM (SQL)
- Candle (ML inference)
- Linfa (classical ML)
- Burn + WebGPU (training)
- Plotters / Charming (charts)
- Rhai (scripting glue)
- tokenizers, arrow-rs, statrs, and supporting crates

Both bundles are versioned independently of `workbook.proto`. `manifest.runtime.contractVersion` declares which schema version the workbook expects; the bundles negotiate compatibility. In `linked` mode, both load from CDN; in `portable` mode, both are inlined.

### Real JavaScript everywhere

Because the workbook is a Svelte app, every block has full access to the JS runtime. This unlocks:

- **Real interactive charts** — D3, ECharts, visx, or any JS charting library can be wrapped in a block component
- **Real form widgets** — sliders, multi-select, date pickers, file uploads — all native Svelte components
- **Real animations and transitions** — Svelte's transition system, Motion One, GSAP
- **Real Web APIs** — Web Workers for client-side compute, IndexedDB for caching, BroadcastChannel for cross-workbook coordination, WebSockets for live data

Display blocks that today render to static HTML (charts, metrics, diagrams) become genuinely interactive. A `chart` block can hover, zoom, and brush. A `metric` block can animate value transitions. A `table` block can sort, filter, and paginate against the SQLite layer in real time — all without round-tripping to a runtime host.

### Custom interactivity: the `widget` block

The `widget` block (defined in the Block Catalog) lets workbooks reference curated Svelte components from a registered library. Use cases:

- Domain-specific dashboards (a "churn cohort explorer" widget reused across customer-analysis workbooks)
- Specialized visualizations not worth adding to the core block catalog
- Organization-internal components (a company's design system widgets)

Widget libraries are published as standard npm packages with a manifest declaring exported components. The runtime resolves them from trusted registries declared in user/org settings. The CSP allows script loading from registered registry hosts.

### What the agent generates

The agent emits the manifest (block tree + cell sources). It does not write Svelte. The block components are pre-built; the agent's job is to compose blocks, not implement them. This keeps the agent's output safe and consistent — every block of a given kind renders identically across all workbooks.

If a workbook needs custom UI beyond the catalog, the agent emits a `widget` block referencing the appropriate library component. If no widget exists, the agent falls back to standard blocks (e.g., a `chart` instead of a custom visualization).

### Backwards-incompatible runtime updates

When the runtime bundle ships breaking changes, older workbooks continue to work because the CDN serves all major versions:
- `cdn.signal.app/workbook-runtime/v1.js` — current
- `cdn.signal.app/workbook-runtime/v2.js` — future
- A workbook's `manifest.runtime.cdnUrl` pins the major version it was generated against

Workbooks generated against `v1` continue to load `v1` indefinitely. The same applies to inlined runtime bundles in `portable` mode — they're frozen with the file.

---

## Execution Model

### Reactive dependency graph

The graph derived from static analysis (`provides`/`reads`) drives reactivity. When a cell's inputs change — `input` widget, URL parameter, manual edit — the runtime computes the transitive closure of affected cells and re-queues them in topological order. Only the affected subgraph re-executes.

Cell re-runs are debounced 200 ms to batch rapid input changes.

### Execution backends

| Context | SQL cells | Polars / Rhai cells | Inference / training cells |
|---------|-----------|--------------------|----------------------------|
| Tier 1 (browser, default) | DuckDB-WASM in-browser | WASM runtime in-browser | Candle / Linfa in WASM (with WebGPU when available) |
| Tier 3 (Signal hosted) | Same WASM runtime, headless | Same WASM runtime, headless | Same + heavy GPU when needed |

Cells always display embedded outputs from the last run. Re-execution at Tier 1 happens immediately because the WASM runtime is already loaded. Tier 3 is reached only when a cell explicitly requires capabilities the browser tier can't provide.

### Runtime lifecycle (WASM)

The runtime is the `@workbook/runtime-wasm` bundle described in Layer 5. It's a single WebAssembly module containing Polars, DuckDB-WASM, Candle, Linfa, Burn, Plotters, Rhai, tokenizers, and supporting libraries. Total size: ~10–15 MB compressed; loaded once from CDN per major version, cached aggressively across workbooks.

#### Initialization

When a workbook page mounts:
1. The Svelte UI begins rendering Layer 4 (display blocks always render immediately from the embedded state)
2. The WASM runtime is fetched from CDN (or loaded from inline bytes in `portable` mode)
3. `initWasmRuntime()` is called with `manifest.environment.runtimeFeatures` — the runtime tree-shakes unused feature slices to minimize memory
4. Model artifacts in `manifest.environment.modelArtifacts` are downloaded in parallel and cached in IndexedDB (or read from inline base64 in `portable` mode)
5. The runtime is ready; cells become runnable

Cold start (uncached): ~2–3 seconds.
Warm start (cached): ~200ms.
This is dramatically faster than the Python sandbox model — there is no provisioning, no package installation, no container boot.

#### Adding runtime features

The runtime is built from a Cargo workspace at `packages/workbook-runtime-wasm/`. Adding a new Rust crate to the runtime:

```bash
cd packages/workbook-runtime-wasm
# edit Cargo.toml to add the crate
bun run build:wasm                    # ~2-5 min compile
bun run publish:wasm-runtime          # publish to CDN
```

The new feature is opt-in per workbook via `manifest.environment.runtimeFeatures` so that workbooks that don't need it don't pay the bundle-size cost.

**`bundleVersion`**: The manifest pins the runtime bundle version. Newer bundle versions are backward-compatible within a major version. The CDN serves all major versions (`v1.js`, `v2.js`) so older workbooks continue to load their pinned bundle indefinitely.

#### Session lifecycle

Within a single workbook page session, runtime state persists across cell runs. Variables defined in one Rhai cell are available to subsequent ones; loaded models stay in memory; trained models persist until the page closes.

When the page is closed and reopened, the runtime cold-starts fresh. Steps with `autorun: true` are replayed in order to restore variable state — same pattern as before, but now executing client-side rather than against a remote sandbox.

Scheduled runs (Tier 3) always use a fresh runtime instance — never reuse an interactive session. Reproducibility.

### Streaming execution

Long-running cells stream output incrementally. The cell's outputs gain a `kind: "stream"` entry that updates in real time. On completion the stream entry is replaced by the final typed output. Progress bars, log lines, intermediate checkpoints appear as they happen.

In Tier 1 (browser), streaming is implemented via the WASM runtime emitting events to a JS callback. In Tier 3, streaming uses Server-Sent Events over the Connect channel.

### Parameter injection

Parameters are injected per language, with types preserved:

**Rhai cells** receive parameters as a pre-bound `params` map in scope:
```rust
let cohort = params.cohort;        // String
let start  = params.start;         // Date
let limit  = params.limit;         // i64
```

**Polars cells** can reference parameters in expressions via `${name}` substitution at plan time:
```rust
df.filter(col("created_at").gt_eq(lit(${start})))
  .filter(col("cohort").eq(lit(${cohort})))
```

**SQL cells** receive parameters as named bound parameters:
```sql
SELECT * FROM orders WHERE created_at >= :start AND cohort = :cohort
```

**Candle inference cells** receive parameters in their input binding spec:
```json
{ "input": { "text": { "from_param": "user_query" } } }
```

The injection mechanism is uniform across cell types: parameters are typed, never coerced from strings, never injected via environment variables.

---

## Offline Experience

The Rust/WASM architecture changes the offline story dramatically: **a workbook is fully runnable offline by default**. SQL, Polars, Rhai, Candle inference, Linfa training, and chart cells all execute in the browser with no network connectivity required (after the initial CDN load of the runtime bundle, which is cached). The only operations that need a network are external API calls (LLM providers, third-party data sources) and Tier 3-specific features (heavy training, scheduled runs, MCP serving).

### When network is unnecessary

A workbook opened from a `.workbook` file works fully offline if:
- The runtime bundle is cached (or the workbook is in `portable` mode with the bundle inlined)
- All `manifest.environment.modelArtifacts` are cached in IndexedDB (or inlined)
- All cells use `runtime: wasm` (the default)
- No cells call external APIs that require live network

This is the common case. Most workbooks, opened on a plane or behind a firewall, run identically to how they run with full connectivity.

### When network is required

Some operations require connectivity:

| Need | Why |
|------|-----|
| First-time load (runtime + models) | CDN download |
| External API calls (OpenAI, customer DB) | Network access (proxied via Tier 3 if configured) |
| Tier 3 features (scheduling, MCP, large training) | Server-side capability |
| Cross-workbook `load()` for unpinned dependencies | Convex query |

When a cell with these requirements runs offline, the UI surfaces a clear message: "This cell needs `<reason>`. [Connect →]". The cell still shows its last embedded output — only re-execution is gated.

### Visual cell state

Cells display state explicitly:

- **WASM cells (default)**: live Run button. The runtime is loaded; press to execute.
- **Cells requiring Tier 3 (no connection)**: Run button greyed, tooltip explains why. Embedded output still shown.
- **Cells with cached external models**: live Run button (cache hit means no network needed).
- **Cells whose external models are not cached**: Run button greyed until the first online load fetches and caches them.

Cells never silently fail to run.

### Deep link

Every workbook embeds a `signal://workbook/<slug>` deep link as a CTA for opening in the Signal app (which auto-syncs to Convex, enables collaboration, etc.). Useful for workbooks shared via email — recipient clicks the link, the workbook opens in Signal with their account.

### What this reframes

A workbook offline is the **default experience**, not a degraded one. The format ships with everything it needs to run — runtime, data, outputs, and (when configured) the agent that built it. "Live execution requires Signal" is no longer the default story; it's a specific opt-in for capabilities Signal genuinely uniquely provides (heavy training, hosted scheduling, multi-tenant collaboration). Everything else just works, anywhere, forever.

---

## Permissions & Collaboration

A workbook is **single-writer** in Phase 1–4. Concurrent editing is not supported.

| Role | View | Run cells | Edit source | Share |
|------|------|----------|-------------|-------|
| `owner` | ✓ | ✓ | ✓ | ✓ |
| `editor` | ✓ | ✓ | ✓ | — |
| `viewer` | ✓ | — | — | — |
| `public` | ✓ | — | — | — |

`visibility: "public"` makes the workbook viewable (static outputs, plus full client-side execution of WASM cells) without authentication. MCP and API access require explicit `auth` config regardless of visibility.

Last-write-wins with the `updatedAt` optimistic lock is the conflict strategy. Two simultaneous editors: one write succeeds, the other gets a conflict error and a diff view to reconcile. Real-time collaborative editing (OT/CRDT) is out of scope until explicitly scoped.

---

## Parameterization

Parameters declared in `manifest.parameters`. Precedence:

1. **URL query string**: `/workbook/churn-analysis?cohort=enterprise&date=2025-Q1`
2. **`input` block widget**
3. **Default**: `manifest.parameters.<name>.default`

URL parameters are coerced to declared types. A `type: number` parameter from a URL string is parsed to a float; `type: date` to ISO date. Coercion failure renders an error in the `input` block and blocks dependent cells.

---

## Scheduling

A workbook with `manifest.schedule.enabled: true` runs on its cron schedule. Scheduling executes on a Tier 3 runtime — the same WASM runtime as Tier 1, but running headlessly on Signal-hosted infrastructure. Each run:

1. Fresh runtime instance initialized with `manifest.environment.runtimeFeatures` and model artifacts
2. Cells execute in topological dependency order
3. On cell failure: `errorPolicy` (default `halt`) saves outputs from completed cells; data and state layers updated with partial results; `lastRunStatus = "error"`
4. On success: layers fully updated; structured diff computed against previous run
5. `lastRunAt`, `lastRunStatus`, `lastRunId` updated under optimistic lock

**Retry**: failures retry per `retryPolicy` with backoff. Each attempt uses a fresh runtime instance.

**Missed runs**: `missedRunPolicy: "latest"` — if paused and re-enabled, exactly one run for the current interval. No backfill.

**Concurrency**: `concurrencyPolicy: "skip"` — if a run is still active when the next tick fires, skip the new run. Prevents queue buildup.

Scheduling requires a Tier 3 runtime (Signal hosted or self-hosted). Tier 1 (browser) cannot run schedules — there's no daemon to fire the cron.

---

## Cell-as-API

Cells listed in `manifest.api.cells` are exposed as POST endpoints:

```
POST /workbook/<slug>/cells/<cell-id>
Authorization: Bearer <signal-api-token>
Content-Type: application/json

{ "inputs": { "<param-name>": "<typed-value>" } }
```

Authentication required unless explicitly disabled in `manifest.api.auth`. Token must carry the configured scopes. Rate-limited per caller per `rateLimit` config.

Initializes (or reuses) the workbook's headless runtime instance, injects inputs as typed parameters, executes the cell against the WASM runtime, returns output as JSON. Same runtime, same execution semantics as interactive Tier 1 use.

Requires Tier 3 runtime host (needs public ingress and auth fabric).

---

## MCP Server Mode

A workbook with `manifest.mcp.enabled: true` is served as an MCP server:

- **Tools** — entries in `manifest.mcp.tools` become callable MCP tools. Calling executes the referenced cell.
- **Resources** — entries in `manifest.mcp.resources` become readable MCP resources returning SQLite table contents as JSON. `public: false` requires auth.
- **Prompts** — `input` blocks become MCP sampling prompts.

Authentication via `manifest.mcp.auth`. Default `public: false` requires a Signal session token with the configured scope.

Requires Tier 3 runtime host.

---

## Cross-Workbook Composition with Lockfile Pinning

Cells load data from other workbooks the caller has access to via the runtime's `load()` function. Available in Rhai and Polars cells:

```rust
// Rhai cell
// Loose: resolves to latest at first execution, then pinned
let segments = load("customer-segments-v3").table("segments");

// Always latest, never pin (re-resolves every run)
let trends = load("market-trends@latest").table("trends");

// Explicit run pin
let model = load("alice/churn-model-q1@run_2025_01_15_abc").artifact("model");
```

```rust
// Polars cell — load() returns a LazyFrame
let segments_df = load("customer-segments-v3").table_lazy("segments");
segments_df.filter(col("score").gt_eq(lit(0.5))).collect()
```

`load()` fetches the target workbook's data layer (Arrow IPC) over Apache Arrow Flight, streamed directly into Polars with zero copy. Cached locally per pinned `runId`.

### Resolution semantics

Same model as npm: declare loose, pin exact.

`load("slug")` resolves to the latest successful run **at first execution**. The resolved `runId` is recorded in `manifest.provenance.dependencies`:

```json
"provenance": {
  "dependencies": {
    "customer-segments-v3": {
      "runId": "run_2025_01_15_abc",
      "resolvedAt": "2025-01-15T10:00:00Z",
      "schemaHash": "sha256:...",
      "pin": "exact"
    },
    "market-trends": {
      "runId": null,
      "pin": "latest"
    }
  }
}
```

Subsequent runs use the pinned `runId`. The resolved version is stable until explicitly updated. This is the lockfile.

### Pin syntax

| Syntax | Behavior |
|--------|----------|
| `load("slug")` | Use pinned runId; resolve fresh on first use, then stable |
| `load("slug@latest")` | Always latest, never pin |
| `load("slug@<runId>")` | Explicit run reference |

### Refresh

A "Refresh dependencies" action in the UI re-resolves all loose pins to current latest, updates the lockfile, and re-runs the workbook. Equivalent to `npm update`.

### Schema validation

Each pinned dependency records `schemaHash` — a hash of the source workbook's table schemas at resolution time. On every run, the runtime compares the pinned `schemaHash` against the current source. If they differ, dependents fail loudly with `"Schema drift in <slug>: column X removed"` instead of silently consuming bad data.

### Slug resolution

`load("slug")` resolves within the calling user's namespace. `load("user/slug")` is explicit cross-namespace. Ambiguous slugs do not silently resolve to another user's workbook.

---

## Environment Snapshots & Reproducibility

`manifest.environment` is populated at generation time. The Rust/WASM runtime architecture makes reproducibility much simpler than the Python+pip-freeze model:

- **`runtimeFeatures`**: declares which slices of the runtime bundle the workbook uses. Stable; tied to the bundle version.
- **`bundleVersion`**: pins the exact `@workbook/runtime-wasm` version. Newer bundle major versions are backward-compatible; older bundles continue to load forever from CDN.
- **`modelArtifacts`**: each model has a SHA-256 hash. The runtime verifies the hash on load. Models referenced by Hugging Face URL or Signal-hosted URL; both are immutable per-version.

Reproducibility holds because:
1. The runtime bundle is content-addressable and version-pinned
2. Model artifacts are SHA-verified
3. The runtime itself is deterministic (Rust + WASM + identical input → identical output)
4. No "system Python" drift, no transitive dependency upgrades, no environment poisoning

A workbook generated today re-runs identically in 5 years against the same bundle version. Heavy-tail Python ecosystem reproducibility issues (numpy ABI breaks, pip yanks, OS-specific wheels) don't apply.

Captured automatically in Phase 2; no agent or user action required.

---

## Structured Diff & Replay

Manifest is structured JSON; outputs are typed; snapshots can be diffed semantically:

- Which cells changed output
- Which metric values shifted (and direction)
- Which charts changed shape
- Which tables gained/lost rows

Scheduled workbooks expose this as a changelog in the UI and optional push notifications.

**Replay**: manifest carries `sessionId` and `promptHash`. The agent can be re-run with the same prompt against updated data to regenerate the workbook fresh. Distinct from cell re-execution: replay re-runs the agent (may restructure); cell re-execution re-runs code in existing structure.

---

## Provenance & Signatures

```json
{
  "generatedBy": "signal-agent-v1",
  "sessionId": "...",
  "agentModelId": "...",
  "promptHash": "sha256:<hex>",
  "signature": "...",
  "dependencies": { /* lockfile, see above */ }
}
```

The signature is a cryptographic hash of canonical manifest JSON (keys sorted, no whitespace) signed by Signal's private key. Recipients verify the workbook was produced by Signal and not tampered with. Meaningful for workbooks used as data sources by downstream workbooks or MCP clients.

---

## URL & Route Structure

| Route | Disposition | Description |
|-------|-------------|-------------|
| `/workbook/<slug>` | inline | Open in Signal UI |
| `/workbook/<slug>/export?mode=linked\|portable` | attachment | Download |
| `/workbook/<slug>/cells/<cell-id>` | — | Cell-as-API (POST) |
| `/workbook/<slug>/mcp` | — | MCP server endpoint |
| `/workbook/<slug>/data/<table>` | — | Direct table access (JSON) |
| `/workbook/<slug>/diff/<run-a>/<run-b>` | — | Structured diff between runs |
| `signal://workbook/<slug>` | — | Deep link to Signal app |
| `signal://runtime/local` | — | Deep link to local runtime |

---

## Convex Schema

```
workbooks {
  slug:           string        // unique per user
  title:          string
  emoji:          string
  description:    string
  ownerId:        id(users)
  sessionId:      id(sessions)
  blocks:         array         // live block tree
  sqliteUrl:      string        // R2 URL to full SQLite
  stateUrl:       string        // R2 URL to state snapshot
  dataMode:       "embedded | external"
  schedule:       object | null
  mcp:            object | null
  api:            object | null
  permissions:    object
  environment:    object | null
  provenance:     object        // includes dependencies lockfile
  createdAt:      number
  updatedAt:      number        // optimistic lock field
  lastRunAt:      number | null
  lastRunStatus:  string | null
  lastRunId:      string | null
}
```

---

## Versioning & Migration

`version` follows semver. The runtime handles all prior minor versions within the current major version. Breaking changes increment the major version and require migration.

| Manifest version | Minimum runtime contract version |
|-----------------|----------------------------------|
| 1.0 | 1.0 |

### Migration pattern

The runtime applies migrations at open time if the manifest version is below current. Migrations are pure functions `(manifest: OldShape) => NewShape` applied in sequence. Migrated manifests are saved back under the optimistic lock to avoid re-migrating on every open.

### `code` block deprecation

Phase 1 ships both `code` (display-only) and `cell` (runnable). `code` blocks generated in Phase 1 remain valid forever. In Phase 2 the agent emits `cell` blocks for runnable code. Existing `code` blocks render as syntax-highlighted display code; never auto-promoted. Manual "promote to cell" action available in the UI.

---

## Implementation Phases

The phases below assume the consolidation refactor in `WORKBOOK_REFACTOR.md` has landed first (`sbooks` → `workbooks` rename, compositions removed, schema cleaned). The phases below build the new spec capabilities on the cleaned foundation.

### Phase 1 — Svelte-mounted Export & Schema Foundation
- Export pipeline rewrites: produces a Svelte-mounted HTML shell with embedded layers
- `@workbook/runtime` package (UI runtime) extracted; published to CDN
- Bootstrap script + skeleton loader in the exported file body
- CSP meta tag with nonce per export
- `workbook.proto` schema authored; Buf registry set up; TypeScript bindings generated
- Content-disposition: `inline` for view, `attachment` for export

### Phase 2 — WASM Execution Runtime (foundation)
- Build minimal `@workbook/runtime-wasm` with Polars + DuckDB-WASM + Plotters
- Single-feature workbooks (data + SQL + charts) running entirely client-side
- Validate bundle size, cold/warm load times, performance vs Pyodide baseline
- Connect-based `WorkbookRuntime` service in `runtime.proto`
- `runCell` RPC implemented for in-browser execution path
- **Gate**: end-to-end demo of a generated workbook running fully in browser

### Phase 3 — Cell types, Static DAG, Reactivity
- `sql`, `polars`, `chart` cell types with full WASM execution
- Static analyzer (`provides`/`reads`) running at save time → derived `dependsOn`
- Runtime instrumentation in WASM for dynamic-pattern catch-up
- `input` block with URL parameter contract + type coercion
- Reactive re-execution on input change (debounced 200 ms)
- Cycle detection at save time
- Error propagation: `status: "stale"` on downstream
- Streaming output via WASM event callback (SSE for Tier 3)
- Output embedding at generation time (state layer populated)
- `step.autorun` for state restoration
- Typed parameter injection per cell language

### Phase 4 — ML Inference & Classical ML
- `candle-inference` cell type with Candle backend in WASM
- Model artifact resolution from Hugging Face / Signal-hosted URLs
- Quantized model support (GGUF, Q4_K_M)
- IndexedDB caching for model artifacts; SHA-256 verification
- `linfa-train` cell type for classical ML
- `machine` block type with model card provenance captured at training time
- Inference and training benchmarks vs Python equivalent
- Apache Arrow Flight client for cross-workbook data movement

### Phase 5 — Scheduling, Diff, Loop, Tier 3 emergence
- Cron in manifest wired to Convex cron infrastructure (Tier 3)
- Retry policy, concurrency skip, partial-run state saving
- Structured diff between runs; changelog in UI
- `loop` block with parallelism (separate runtime instances)
- Tier 3 runtime serves the same Connect interface for headless execution

### Phase 6 — Cell-as-API, MCP, Composition with Lockfile
- `manifest.api.cells` + POST endpoint with auth + rate limiting; content negotiation (JSON or Protobuf)
- `manifest.mcp` + MCP server wrapper with auth (Tier 3 only)
- `load()` with lockfile resolution + Arrow Flight transport
- `provenance.dependencies` schema-hash validation
- "Refresh dependencies" UI action

### Phase 7 — Runtime Tiers Open
- Publish `workbook.proto` and `runtime.proto` to public Buf registry
- Publish runtime bundle (WASM) as a versioned, content-addressable CDN artifact
- Ship `@workbook/runtime-self-hosted` Docker image for Tier 2 self-hosted (optional, organizations who need on-prem)
- Generated SDKs published: `@signal/workbook-sdk` (TS), Python (for legacy interop), Go, Rust
- `widget` block + widget registry resolution
- `wasm-fn` block with curated function registry
- Self-host documentation

### Phase 8 — Provenance, Collaboration, Portable Export
- Manifest signatures (Ed25519 over canonical JSON)
- `portable` export mode (WASM runtime + UI runtime + models all inlined; no CDN dependency)
- Replay from session + prompt hash
- Permission model UI (share as viewer/editor)
- Import conflict resolution flow
- Machine block version-history diff

### Phase 9 — Embedded Agent Runtime (per `WORKBOOK_RUST_PIVOT.md`)
- Fork pi_agent_rust; port to WASM (`@signal/workbook-agent-wasm`)
- Three credential modes (user-key, Signal proxy, local LLM)
- Workbook tool surface (manifest mutations + runtime invocations)
- Trust policy engine and capability gating
- IndexedDB session persistence
- `manifest.agent` configuration
- The artifact-as-product story: workbooks ship with their authoring agent
