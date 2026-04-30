# hello-cell example

Minimal browser demo for `workbook-runtime`: loads the WASM, evaluates a
Rhai expression via `runRhai()`, displays the result.

## Run

From `packages/runtime-wasm/`:

```bash
wasm-pack build --target web --release
python3 -m http.server 8000
# open http://localhost:8000/examples/hello-cell/
```

## What this proves

- The WASM bundle loads in a browser.
- `wasm-bindgen` glue + JS bridge work end-to-end.
- `build_info()` returns active feature flags + cold-start ms.
- `runRhai("40 + 2")` returns `[{ kind: "text", content: "42" }]`.

## Next

P2.2 layers in `runPolars()` and `renderChart()` on top of this same bridge
pattern. P2.5 lands the full demo workbook (CSV upload → Polars query →
Plotters chart) in `examples/csv-explore/`.
