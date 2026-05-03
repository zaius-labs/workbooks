<!--
  <Notebook> — the standardized chrome wrapper for notebook-shaped
  workbooks. Sets up a ReactiveExecutor, holds reactive cell state,
  exposes a NotebookApi via context for child cells / toolbar /
  custom UI.

  Default behavior:
    - Auto-runs all registered cells once after mount (initial render
      shows outputs without the user clicking anything).
    - Cells edited after that show as "stale"; user clicks Run on
      the cell or Run All in the toolbar to re-execute.

  Slots: default. Whatever is inside <Notebook>...</Notebook> renders
  as the notebook body. Cells declare themselves via <NotebookCell>
  components (or via `getNotebookContext()` for custom chromes).

  Inputs / data:
    - The `inputs` prop is forwarded to the executor as initial input
      values. For Polars cells, set `data` to the CSV the cell reads.
      Same model as the existing reactive-cells example.

  This component is intentionally lightweight chrome-wise — author-
  controlled CSS via class hooks `.workbook-notebook` and the cell-
  level classes. Visual polish lives in the consumer (so a Tailwind
  doc and a serif report can both wrap their notebooks).
-->
<script>
  import { onMount } from "svelte";
  import { setNotebookContext } from "./context";

  let {
    /** Initial input values keyed by name. Cell `reads="<name>"`
     *  attributes look these up. For Polars cells, the runtime
     *  expects the CSV under the key `csv`. */
    inputs = {},
    /** Convenience shortcut. Equivalent to `inputs={{ csv: data }}`.
     *  Passing both is allowed; explicit `inputs` wins. */
    data = undefined,
    /** Auto-run on mount? Most notebooks want this. Set false for
     *  drafts where the author wants explicit Run All as the
     *  first action. */
    autoRunOnMount = true,
    /** Slug for the runtime instance. Defaults to "notebook-<rand>". */
    workbookSlug = `notebook-${Math.random().toString(36).slice(2, 8)}`,
    /** Rendering mode for cells. "notebook" gives the Jupyter chrome
     *  (gutter + play button + Run All toolbar pairing). "document"
     *  renders cells as prose-style figures with no run UI. "headless"
     *  hides the cells entirely (consumer renders output via custom UI). */
    mode = "notebook",
    /** Read-only by default; pass false to make cell sources editable. */
    readonly = mode !== "notebook",
    children,
  } = $props();

  // Build the effective inputs map: explicit `inputs` wins, with
  // `data` filling in `csv` when not specified.
  let effectiveInputs = $derived.by(() => {
    const out = { ...(inputs ?? {}) };
    if (data !== undefined && out.csv === undefined) out.csv = data;
    return out;
  });

  let cells = $state([]);                 // Cell[] in registration order
  let states = $state({});                // id → CellState
  let executor = $state(null);
  let ready = $state(false);
  let running = $state(false);

  // Bookkeeping for cellNumber() so we can show [1], [2], … in the
  // gutter regardless of language. Kept stable across re-mounts.
  const orderById = new Map();

  // Re-push inputs whenever they change post-mount. setInput on
  // ReactiveExecutor schedules a debounced rerun of any cell that
  // declares `reads="<name>"`; downstream cells cascade.
  $effect(() => {
    if (!executor) return;
    for (const [k, v] of Object.entries(effectiveInputs)) {
      executor.setInput(k, v);
    }
  });

  onMount(async () => {
    const { loadRuntime } = await import("virtual:workbook-runtime");
    const { wasm, bundle } = await loadRuntime();
    const client = bundle.createRuntimeClient({ loadWasm: async () => wasm });
    executor = new bundle.ReactiveExecutor({
      client,
      cells,
      inputs: effectiveInputs,
      workbookSlug,
      debounceMs: 0,
      onCellState: (s) => {
        states = { ...states, [s.cellId]: s };
      },
    });
    if (autoRunOnMount) {
      running = true;
      try { await executor.runAll(); }
      finally { running = false; }
    }
    ready = true;
  });

  setNotebookContext({
    register(cell) {
      // Idempotent: same id re-register replaces source (e.g. live
      // Svelte HMR). New ids append.
      const i = cells.findIndex((c) => c.id === cell.id);
      if (i === -1) {
        orderById.set(cell.id, orderById.size + 1);
        cells = [...cells, cell];
      } else {
        cells[i] = cell;
        cells = [...cells];
      }
      if (executor) executor.setCell(cell);
      if (!states[cell.id]) {
        states = { ...states, [cell.id]: { cellId: cell.id, status: "pending" } };
      }
    },
    async run(id) {
      const cell = cells.find((c) => c.id === id);
      if (!cell || !executor) return;
      // Push latest source first (in case the user edited), then
      // force-rerun the cell + downstream via runCell. setCell on
      // its own only triggers downstream cells; runCell includes
      // the cell itself.
      executor.setCell({ ...cell });
      running = true;
      try { await executor.runCell(id); }
      finally { running = false; }
    },
    async runAll() {
      if (!executor) return;
      running = true;
      try {
        for (const c of cells) executor.setCell({ ...c });
        await executor.runAll();
      } finally { running = false; }
    },
    clear() {
      const next = {};
      for (const c of cells) next[c.id] = { cellId: c.id, status: "pending" };
      states = next;
    },
    state(id) { return states[id]; },
    updateSource(id, source) {
      const i = cells.findIndex((c) => c.id === id);
      if (i === -1) return;
      cells[i] = { ...cells[i], source };
      cells = [...cells];
      const prev = states[id];
      states = { ...states, [id]: { ...(prev ?? { cellId: id }), status: "stale" } };
    },
    cellNumber(id) { return orderById.get(id) ?? 0; },
    get ready() { return ready; },
    get running() { return running; },
    get mode() { return mode; },
    get readonly() { return readonly; },
  });
</script>

<div class="workbook-notebook" class:running class:ready data-mode={mode}>
  {@render children?.()}
</div>

<style>
  /* No default styles on the wrapper — plain block, full container
     width. Consumers style `.workbook-notebook` via :global() to set
     max-width, padding, font, theme tokens, etc. Don't add anything
     here that overrides the consumer; Svelte's scoped class
     specificity beats a :global selector. */
</style>
