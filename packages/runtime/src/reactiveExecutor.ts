/**
 * Reactive cell executor (P3.7).
 *
 * Builds a static DAG from a workbook's cells (using `cellAnalyzer.ts`'s
 * `reads`/`provides` extraction), runs cells in topological order, and
 * re-runs only the downstream subgraph when an input changes — debounced
 * so a user dragging a slider doesn't spam the runtime with duplicate
 * executions.
 *
 * State machine per cell:
 *   pending → running → ok | error
 *   ok      → stale (when an upstream changes) → running → …
 *
 * Failure isolation: if a cell errors, downstream cells go to `stale`
 * rather than running with bad inputs. The executor surfaces the error
 * via `onCellError` and marks downstream cells skipped.
 *
 * Status: P3.7 baseline. Tier 1 (browser, single-runtime) only —
 * no parallel execution within a generation. Streaming outputs (P3.9)
 * and structured parameter injection (P3.11) extend this.
 */

import { analyzeCell } from "./cellAnalyzer";
import type {
  Cell,
  CellOutput,
  RunCellResponse,
  RuntimeClient,
} from "./wasmBridge";

export type CellStatus = "pending" | "running" | "ok" | "error" | "stale";

export interface CellState {
  cellId: string;
  status: CellStatus;
  outputs?: CellOutput[];
  error?: string;
  /** Microsecond-resolution ms for the last successful run. */
  lastRunMs?: number;
}

export interface ExecutorOptions {
  client: RuntimeClient;
  /** Initial cells. Replaceable via `setCell()`. */
  cells: Cell[];
  /** Initial named inputs. Replaceable via `setInput()`. */
  inputs?: Record<string, unknown>;
  /**
   * Called once per cell every time its state transitions. The view layer
   * uses this to render run badges / outputs / errors as they land.
   */
  onCellState?: (state: CellState) => void;
  /**
   * Debounce window for input-driven re-exec. Multiple `setInput()` calls
   * within this window collapse into one execution pass.
   */
  debounceMs?: number;
  /** Workbook slug — passed to initRuntime. */
  workbookSlug?: string;
}

export class ReactiveExecutor {
  private readonly client: RuntimeClient;
  private cells: Map<string, Cell> = new Map();
  private inputs: Map<string, unknown> = new Map();
  private states: Map<string, CellState> = new Map();
  private readonly onCellState: (state: CellState) => void;
  private readonly debounceMs: number;
  private readonly workbookSlug: string;

  private runtimeId: string | null = null;
  private runtimePromise: Promise<string> | null = null;

  /** Generation counter — bumped on each run so stale runs short-circuit. */
  private generation = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ExecutorOptions) {
    this.client = opts.client;
    this.onCellState = opts.onCellState ?? (() => {});
    this.debounceMs = opts.debounceMs ?? 200;
    this.workbookSlug = opts.workbookSlug ?? "live";
    for (const cell of opts.cells) this.cells.set(cell.id, cell);
    if (opts.inputs) {
      for (const [k, v] of Object.entries(opts.inputs)) this.inputs.set(k, v);
    }
    for (const [id] of this.cells) {
      this.states.set(id, { cellId: id, status: "pending" });
    }
  }

  /**
   * Update an input value. Schedules a debounced re-execution of any cell
   * that reads this input (and their downstream cascade).
   */
  setInput(name: string, value: unknown): void {
    this.inputs.set(name, value);
    this.scheduleRun([name]);
  }

  /**
   * Replace a cell's source/spec. Re-runs that cell and everything
   * downstream of it.
   */
  setCell(cell: Cell): void {
    this.cells.set(cell.id, cell);
    if (!this.states.has(cell.id)) {
      this.states.set(cell.id, { cellId: cell.id, status: "pending" });
    }
    this.scheduleRun(analyzeCell(cell).provides);
  }

  /** Execute all cells from scratch. */
  runAll(): Promise<void> {
    return this.executeFrom(null);
  }

  destroy(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.runtimeId) {
      this.client.destroyRuntime(this.runtimeId).catch(() => {
        /* best-effort */
      });
    }
  }

  // --------------------------------------------------------------

  private scheduleRun(changedProvides: string[]): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.executeFrom(changedProvides).catch((err) => {
        // Top-level executor failures (init failures etc.) — surface on every cell.
        for (const id of this.cells.keys()) {
          this.transition(id, { status: "error", error: String(err) });
        }
      });
    }, this.debounceMs);
  }

  private async ensureRuntime(): Promise<string> {
    if (this.runtimeId) return this.runtimeId;
    if (this.runtimePromise) return this.runtimePromise;
    this.runtimePromise = (async () => {
      const resp = await this.client.initRuntime({
        workbookSlug: this.workbookSlug,
        environment: {},
      });
      this.runtimeId = resp.runtimeId;
      return resp.runtimeId;
    })();
    return this.runtimePromise;
  }

  /**
   * Execute the subgraph of cells reachable from `changedProvides`. If
   * `changedProvides` is null, runs every cell (initial load / runAll).
   */
  private async executeFrom(changedProvides: string[] | null): Promise<void> {
    const gen = ++this.generation;
    const runtimeId = await this.ensureRuntime();

    const order = topologicalOrder([...this.cells.values()]);
    const dirty = changedProvides == null
      ? new Set(order.map((c) => c.id))
      : computeDirtySet(order, new Set(changedProvides));

    // Mark stale eagerly so the UI shows a "queued" state immediately.
    for (const cell of order) {
      if (dirty.has(cell.id)) {
        this.transition(cell.id, { status: "stale" });
      }
    }

    for (const cell of order) {
      if (gen !== this.generation) return; // a newer run superseded us
      if (!dirty.has(cell.id)) continue;

      // Skip if any upstream cell errored.
      const analysis = analyzeCell(cell);
      const upstreamErrored = analysis.reads.some((name) => {
        const provider = providerOf(name, [...this.cells.values()]);
        if (!provider) return false;
        return this.states.get(provider.id)?.status === "error";
      });
      if (upstreamErrored) {
        this.transition(cell.id, {
          status: "stale",
          error: "upstream error",
        });
        continue;
      }

      this.transition(cell.id, { status: "running" });
      const start = performance.now();
      try {
        const params = this.collectParams(cell);
        const resp: RunCellResponse = await this.client.runCell({
          runtimeId,
          cell,
          params,
        });
        const elapsed = performance.now() - start;
        this.transition(cell.id, {
          status: "ok",
          outputs: resp.outputs,
          lastRunMs: elapsed,
        });
      } catch (err) {
        this.transition(cell.id, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Collect param bindings for `cell` — workbook inputs + upstream cell
   * outputs. Each name in `cell` reads (per cellAnalyzer) is resolved:
   *   1. as a workbook input (`this.inputs`)
   *   2. as the parsed scalar output of an upstream cell that `provides`
   *      that name (using the cell that produced it most recently)
   *
   * Scalar coercion: text/plain outputs that parse as a number return a
   * JS number; otherwise the raw string. Non-text outputs come through
   * stringified (callers that want richer typing extend this in P3.11).
   */
  private collectParams(cell: Cell): Record<string, unknown> {
    const a = analyzeCell(cell);
    const params: Record<string, unknown> = {};
    const allCells = [...this.cells.values()];

    for (const name of a.reads) {
      if (this.inputs.has(name)) {
        params[name] = this.inputs.get(name);
        continue;
      }
      const provider = allCells.find((c) =>
        analyzeCell(c).provides.includes(name),
      );
      if (!provider) continue;
      const state = this.states.get(provider.id);
      if (state?.status !== "ok" || !state.outputs?.length) continue;
      params[name] = scalarFromOutputs(state.outputs);
    }
    return params;
  }

  private transition(cellId: string, patch: Partial<CellState>): void {
    const prev = this.states.get(cellId) ?? { cellId, status: "pending" };
    const next: CellState = { ...prev, ...patch, cellId };
    this.states.set(cellId, next);
    this.onCellState(next);
  }
}

// --------------------------------------------------------------

/**
 * Topological sort of the cell graph. Cycles are broken in declaration
 * order — cells in a cycle still run, but in an unspecified order within
 * the cycle. (P3 doesn't ban cycles outright; static analysis sometimes
 * produces false self-edges.)
 */
function topologicalOrder(cells: Cell[]): Cell[] {
  const byId = new Map(cells.map((c) => [c.id, c]));
  const providers = new Map<string, string>(); // name → cell id
  for (const cell of cells) {
    const a = analyzeCell(cell);
    for (const name of a.provides) providers.set(name, cell.id);
  }

  const visited = new Set<string>();
  const onStack = new Set<string>();
  const order: Cell[] = [];

  const visit = (cellId: string) => {
    if (visited.has(cellId) || onStack.has(cellId)) return;
    onStack.add(cellId);
    const cell = byId.get(cellId);
    if (cell) {
      const a = analyzeCell(cell);
      for (const dep of a.reads) {
        const upstream = providers.get(dep);
        if (upstream && upstream !== cellId) visit(upstream);
      }
      order.push(cell);
    }
    onStack.delete(cellId);
    visited.add(cellId);
  };

  for (const cell of cells) visit(cell.id);
  return order;
}

/**
 * Walk forward from `seedNames` to find every cell that (transitively)
 * reads something an upstream provides.
 */
function computeDirtySet(order: Cell[], seedNames: Set<string>): Set<string> {
  const dirtyProvides = new Set(seedNames);
  const dirtyCells = new Set<string>();
  for (const cell of order) {
    const a = analyzeCell(cell);
    if (a.reads.some((name) => dirtyProvides.has(name))) {
      dirtyCells.add(cell.id);
      for (const name of a.provides) dirtyProvides.add(name);
    }
  }
  return dirtyCells;
}

function providerOf(name: string, cells: Cell[]): Cell | undefined {
  for (const cell of cells) {
    if (analyzeCell(cell).provides.includes(name)) return cell;
  }
  return undefined;
}

function scalarFromOutputs(outputs: CellOutput[]): unknown {
  for (const out of outputs) {
    if (out.kind !== "text") continue;
    const trimmed = out.content.trim();
    const n = Number(trimmed);
    if (!Number.isNaN(n) && Number.isFinite(n)) return n;
    return trimmed;
  }
  return outputs[0];
}
