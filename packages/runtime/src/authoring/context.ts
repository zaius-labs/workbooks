/**
 * Authoring context — what the SDK's Svelte components share through
 * setContext / getContext.
 *
 * The existing `workbookContext.ts` is for *rendering* a finalized
 * WorkbookDocument JSON (in the signal app). This context is for
 * *authoring* — `<WorkbookApp><Cell><Output></WorkbookApp>` style
 * declarative workbooks.
 *
 * Authors should rarely import from here. The Svelte components
 * (WorkbookApp, Cell, Input, Output, Chart) call setContext /
 * getContext under the hood. Hooks (useCell, useDAG, useRuntime) are
 * the public API for advanced cases.
 */

import { getContext, setContext } from "svelte";
import type { ReactiveExecutor, CellState } from "../reactiveExecutor";
import type { Cell as CellSpec } from "../wasmBridge";

const KEY = Symbol("workbook-authoring-context");

/**
 * Reactive cell-state map. Keys are cell IDs; values are the latest
 * CellState the executor emitted. This is a Svelte $state object so
 * downstream components re-render automatically on state transitions.
 *
 * We expose it through a getter rather than the bare Map so consumers
 * can use Svelte 5's `$derived` against `cellStates()` returns without
 * worrying about whether the underlying ref is reactive.
 */
export type CellStatesMap = ReadonlyMap<string, CellState>;

export interface AuthoringContext {
  /** Register a cell with the DAG. Idempotent — calling with the same
   *  id replaces the prior spec and re-runs downstream. */
  registerCell(cell: CellSpec): void;
  /** Unregister a cell (e.g. when its <Cell> component is destroyed). */
  unregisterCell(cellId: string): void;
  /** Push an input value into the executor. */
  setInput(name: string, value: unknown): void;
  /** Read an input's current value. */
  getInput(name: string): unknown;
  /** Reactive accessor for a single cell's state. Returns `undefined`
   *  before the cell has registered or run. */
  getCellState(cellId: string): CellState | undefined;
  /** Reactive accessor for the full cell-state map. Useful for
   *  building a DAG inspector / overview. */
  getAllCellStates(): CellStatesMap;
  /** The underlying executor — exposed for advanced use (manual
   *  runCell, listCells, etc.). May be null before the runtime has
   *  finished booting. */
  getExecutor(): ReactiveExecutor | null;
  /** The wasm-bindgen bindings (runPolarsSql, etc.). May be null
   *  before the runtime has finished booting. */
  getRuntime(): unknown;
  /** True once loadRuntime() has resolved and the executor is ready
   *  to accept cells/inputs. Components that gate on "runtime is
   *  ready" — e.g. <Output> — read this. */
  isBooted(): boolean;
  /** Promise that resolves when the runtime has booted. Useful for
   *  components that need to wait before doing anything. */
  ready(): Promise<void>;
}

export function setAuthoringContext(ctx: AuthoringContext): void {
  setContext(KEY, ctx);
}

export function getAuthoringContext(): AuthoringContext | null {
  return (getContext(KEY) as AuthoringContext | undefined) ?? null;
}

/** Hard-fail variant — throws if a component is used outside <WorkbookApp>.
 *  Components like <Cell>, <Input>, <Output> require the context, so
 *  the error message points the author at the missing wrapper. */
export function requireAuthoringContext(component: string): AuthoringContext {
  const ctx = getAuthoringContext();
  if (!ctx) {
    throw new Error(
      `<${component}> must be used inside a <WorkbookApp> component. ` +
      `Wrap your authoring tree:\n\n` +
      `  <WorkbookApp>\n` +
      `    <${component} ... />\n` +
      `  </WorkbookApp>`,
    );
  }
  return ctx;
}
