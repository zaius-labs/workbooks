// Notebook state — wraps ReactiveExecutor in Svelte 5 runes so the
// UI can reactively re-render when cells append, edit, or transition
// status. Module-level singleton: one notebook per page.
//
// Why a thin wrapper instead of using the executor directly: the
// executor stores cells/states internally in Maps. Svelte's reactive
// graph needs to see assignments to detect changes. We mirror the
// executor's view into $state objects on each onCellState callback,
// and keep a parallel `cells` array to drive iteration.

import { loadRuntime } from "virtual:workbook-runtime";

let runtime = null;       // { wasm, bundle } — lazily initialized

/** Returns the shared runtime, initializing wasm + bundle on first call. */
export async function getRuntime() {
  if (!runtime) runtime = await loadRuntime();
  return runtime;
}

// ----- Reactive notebook state ---------------------------------------

const SLUG = "notebook-agent";
const SAMPLE_CSV = `region,revenue,churn
us,12000,0.04
us,8400,0.11
eu,15600,0.02
eu,3200,0.18
apac,21000,0.05
apac,4400,0.22`;

const STARTER_CELLS = [
  {
    id: "doubled",
    language: "rhai",
    source: "n * 2",
    provides: ["doubled"],
    dependsOn: ["n"],
  },
  {
    id: "by_region",
    language: "polars",
    source: `SELECT region, SUM(revenue) AS total, AVG(churn) AS avg_churn
FROM data
GROUP BY region
ORDER BY total DESC`,
  },
];

// Inline VFS — localStorage-backed, namespaced. Polars cells read
// CSV files from here; agent's query_data tool reuses it.
const VFS_PREFIX = `${SLUG}.vfs.`;
export const vfs = {
  exists(p) { return localStorage.getItem(VFS_PREFIX + p) !== null; },
  readText(p) {
    const v = localStorage.getItem(VFS_PREFIX + p);
    if (v === null) throw new Error(`no such file: ${p}`);
    return v;
  },
  writeText(p, s) {
    localStorage.setItem(VFS_PREFIX + p, String(s ?? ""));
    return String(s ?? "").length;
  },
};
if (!vfs.exists("/workspace/customers.csv")) {
  vfs.writeText("/workspace/customers.csv", SAMPLE_CSV);
}

// ----- Reactive state objects ----------------------------------------

// Map of cellId → { cell, state }. We hold a parallel order array so
// iteration in templates is stable (cells in append order).
class NotebookStore {
  cellOrder = $state([]);
  byId = $state({});           // id → { cell, state }
  ready = $state(false);
  executor = null;

  async init() {
    const { wasm, bundle } = await getRuntime();
    const client = bundle.createRuntimeClient({ loadWasm: async () => wasm });
    this.executor = new bundle.ReactiveExecutor({
      client,
      cells: STARTER_CELLS,
      inputs: { n: 21 },
      workbookSlug: SLUG,
      debounceMs: 120,
      onCellState: (state) => this.handleStateChange(state),
    });
    for (const c of STARTER_CELLS) {
      this.cellOrder.push(c.id);
      this.byId[c.id] = { cell: c, state: { cellId: c.id, status: "pending" } };
    }
    await this.executor.runAll();
    this.ready = true;
  }

  /** Called from the executor on every cell-state transition. */
  handleStateChange(state) {
    const id = state.cellId;
    if (!this.byId[id]) {
      // Agent appended a new cell — pull it from the executor and
      // record so the template renders it.
      const cell = this.executor.getCell(id);
      if (cell) {
        this.cellOrder = [...this.cellOrder, id];
        this.byId[id] = { cell, state };
      }
      return;
    }
    // Mirror cell source too in case it was edited.
    const cell = this.executor.getCell(id);
    if (cell) {
      this.byId[id] = { cell, state };
    } else {
      this.byId[id] = { ...this.byId[id], state };
    }
  }
}

export const notebook = new NotebookStore();
