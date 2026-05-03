# reactive-cells example

Browser demo for **P3.4 (static analyzer) + P3.7 (reactive executor)**.

Three Rhai cells form a DAG:

```
n  →  doubled       (n * 2)
n  →  incremented   (n + 1)
doubled, incremented  →  summary  (doubled + incremented)
```

When you change `n`, the executor:
1. Marks `doubled`, `incremented`, and `summary` as `stale`
2. Debounces 200 ms (additional changes within the window collapse)
3. Runs `doubled` and `incremented` (no order constraint between them)
4. Runs `summary` once both upstream cells finish ok
5. Skips any unrelated cell — none of the others read `n`

## Run

From `packages/runtime-wasm/`:

```bash
wasm-pack build --target web --release
python3 -m http.server 8000
# open http://localhost:8000/examples/reactive-cells/
```

You'll need to serve from a server that resolves `.ts` imports — Vite,
SvelteKit, or any modern bundler. Plain `python3 -m http.server` won't
serve raw TypeScript out of the box; for that case, build the runtime
package first (`cd ../../packages/runtime && pnpm build`).

## What this proves

- `analyzeCell()` correctly identifies reads/provides from explicit
  `dependsOn`/`provides` fields (and falls back to source-parsing when
  they're missing — see `cellAnalyzer.test.ts` for source-parse cases)
- `ReactiveExecutor` builds a topo order, executes cells in dependency
  order, and re-runs only downstream cells when an input changes
- Debouncing collapses rapid input changes into one execution pass
- Cell state transitions surface to the view layer in real time

## Acceptance

- Initial load: all three cells go `pending → running → ok` in topo
  order. `summary` shows `82` (40·2 + 41).
- Drag `n` to 50: cells dim to `stale`, then re-run; `summary` shows
  `101`.
- Spam the slider: timing badges show ONE run per debounce window, not
  one per input change.
