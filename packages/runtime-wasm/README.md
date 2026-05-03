# workbook-runtime (Rust)

Rust execution runtime for workbooks — compiled to WebAssembly and
shipped as the workbook's client-side compute layer.

## What it does

A workbook page loads two bundles:

1. **`@workbook/runtime`** (Svelte UI, ~250 KB) — renders blocks, mounts the document
2. **`workbook-runtime`** (this crate, see "Bundle sizes" below) — executes cells

The WASM bundle dispatches cell execution by language:

| Cell language | Backend | Where it lives | Phase |
|---|---|---|---|
| `rhai` | Rhai engine | this crate (default) | P2.2 (eval works today) |
| `polars` | Polars LazyFrame + SQL frontend | this crate (default) | P2.2 (SQL path works today) |
| `chart` | Plotters | this crate (default) | P2.3 |
| `sqlite` | `@sqlite.org/sqlite-wasm` | sidecar JS, lazy-loaded | P2.5 |
| `duckdb` | `@duckdb/duckdb-wasm` | sidecar JS, lazy-loaded | P3+ |
| `candle-inference` | Candle | this crate, feature `candle` | P4.1 |
| `linfa-train` | Linfa | this crate, feature `linfa` | P4.4 |
| `wasm-fn` | Curated function registry | this crate | P7 |

Polars in lazy mode IS an OLAP engine — same column store, same vectorized
execution as DuckDB, with a SQL frontend that compiles to LazyFrame. It
covers ~90% of analytical workloads at ~1.75 MB compressed.

SQLite + DuckDB are intentionally NOT compiled into this Rust crate. Both
need a wasi-libc sysroot to compile their C source for wasm32-unknown-
unknown, which is non-trivial to ship. Instead, the runtime bridge
lazy-loads `@sqlite.org/sqlite-wasm` (~1 MB) or `@duckdb/duckdb-wasm`
(~7 MB) when a workbook's manifest declares those features. Workbooks
that don't reference them never download the chunks.

## Build

From `packages/runtime-wasm/`:

```bash
wasm-pack build --target web --release
# output: pkg/workbook_runtime.{js,wasm,d.ts} + package.json
```

`wasm-opt -Oz` + brotli compression run automatically.

### Build matrix

Measured on macOS arm64 with rustc 1.94.1, wasm-opt -Oz, brotli --best.

| Features | wasm raw | gzip | brotli |
|---|---:|---:|---:|
| `--no-default-features --features charts,rhai-glue` | 1.1 MB | 357 KB | **274 KB** |
| `default` (polars-frames + charts + rhai-glue) | 12 MB | 3.2 MB | **2.0 MB** |

Default-bundle delta breakdown:
- Charts (Plotters svg) + Rhai engine + scaffold: ~270 KB brotli
- Polars (lazy + csv + json + strings + temporal + sql): +~1750 KB brotli

Polars is the heaviest single piece. Adding `polars-parquet` would push
~+500 KB but currently fails to build (lz4-sys / zstd-sys C deps need a
wasm32 sysroot — see `docs/RUST_RUNTIME.md`).

## Tree-shaking

Each cell language is a Cargo feature. Workbooks declare the slices they
need in `manifest.runtime.features`; bundles built for those workbooks
only include the requested features. See `Cargo.toml > [features]`.

## Demo (smoke test)

```bash
wasm-pack build --target web --release
python3 -m http.server 8000
# open http://localhost:8000/examples/hello-cell/
```

The hello-cell example loads the WASM, calls `runRhai("40 + 2")`, and
displays the output.

## Architecture

```
+------------------+     wasm-bindgen     +-------------------+
| Svelte UI        |--------------------->| workbook-runtime  |
| (Workbook.svelte)|                      |  (this crate)     |
+------------------+                      +-------------------+
                                                    |
                                                    v
                          +-----------------------------+
                          | Polars  Rhai   Plotters     |
                          | SQLite  DuckDB Candle/Linfa |
                          +-----------------------------+
```

## Reference

- `../../proto/workbook/runtime/v1/runtime.proto` — Connect-RPC service contract
- `../../proto/workbook/v1/workbook.proto` — Workbook + Cell types
- `../../docs/SPEC.md` — full spec
- `../../docs/RUST_RUNTIME.md` — pivot rationale + tool migration map
