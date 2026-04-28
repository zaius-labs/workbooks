# @signal/workbook-runtime-wasm

Rust execution runtime for Signal Workbooks — compiled to WebAssembly and
shipped as the workbook's client-side compute layer.

## What it does

A workbook page loads two bundles:

1. **`@signal/workbook-runtime`** (Svelte UI, ~250 KB) — renders blocks, mounts the document
2. **`@signal/workbook-runtime-wasm`** (this crate, ~10–15 MB compressed) — executes cells

The WASM bundle dispatches cell execution by language:

| Cell language | Backend | Phase |
|---|---|---|
| `sql` | DuckDB-WASM | P3.1 |
| `polars` | Polars LazyFrame | P3.2 |
| `chart` | Plotters | P3.3 |
| `rhai` | Rhai engine | P3 |
| `candle-inference` | Candle | P4.1 |
| `linfa-train` | Linfa | P4.4 |
| `wasm-fn` | Curated function registry | P7 |

## Build

```bash
cd packages/workbook-runtime-wasm
wasm-pack build --target web --release
# output: pkg/workbook_runtime_wasm.{js,wasm}
```

`wasm-opt -Oz` runs automatically (configured in `Cargo.toml`).

## Tree-shaking

Each cell language is a Cargo feature. Workbooks declare the slices they need
in `manifest.environment.runtimeFeatures`; bundles built for those workbooks
only include the requested features. See `Cargo.toml` for the feature flags.

## Architecture

```
+------------------+     wasm-bindgen     +-------------------+
| Svelte UI        |--------------------->| @signal/workbook- |
| (Workbook.svelte)|                      |  runtime-wasm     |
+------------------+                      +-------------------+
                                                    |
                                                    v
                          +-------------------------+-------+
                          | Polars  DuckDB  Candle  Linfa  |
                          | Plotters  Rhai  Burn   Stats   |
                          +--------------------------------+
```

## Reference

- `proto/signal/runtime/v1/runtime.proto` — service contract (PR #2)
- `proto/signal/workbook/v1/workbook.proto` — Workbook + Cell types
- `docs/WORKBOOK_SPEC.md` — full spec
- `docs/WORKBOOK_RUST_PIVOT.md` — pivot rationale + tool migration map
