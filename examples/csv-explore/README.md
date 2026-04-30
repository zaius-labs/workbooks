# csv-explore example

Browser demo for the Polars-on-WASM execution path. **This is the P2.5
gate** — until this runs end-to-end in a real browser without errors,
the workbook-runtime architectural pivot is unproven.

## Run

From `packages/runtime-wasm/`:

```bash
wasm-pack build --target web --release
python3 -m http.server 8000
# open http://localhost:8000/examples/csv-explore/
```

## What this proves

- Polars LazyFrame creation works on `wasm32-unknown-unknown`
- `polars-sql` SQLContext successfully registers a frame and executes
  arbitrary SELECT/GROUP BY/aggregation queries
- `polars-csv` reader + writer round-trip correctly
- The wasm-bindgen JS bridge passes string args + receives structured
  outputs without serialization errors
- Cold-start time is reasonable (target < 2s on a warm browser cache)

## Acceptance

The page renders a result table with three rows (us, eu, apac) and
columns `region`, `customers`, `total_revenue`, `avg_churn` ordered
by total_revenue descending. Build info shows
`features: ["plotters", "rhai", "polars"]` and `cold_start_ms` < 2000.

If the query errors with `polars sql plan: ...` or `polars csv parse:
...`, the bug is in `src/frames.rs > run_polars_sql_inner`. If the
wasm fails to load at all, that's a build/toolchain issue.

## Next

P2.5 follow-on: render a Plotters chart from the same data — wires up
the `chart` cell language alongside `polars`, completing the
"data-in → query → chart-out" pipeline that's the workbook's basic
unit of execution.
