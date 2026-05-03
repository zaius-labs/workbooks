/**
 * Notebook context — shared between <Notebook> and child cell/toolbar
 * components via Svelte's context API. Defines the API surface every
 * cell-style component talks to:
 *
 *   - register(id, lang, source) → void
 *       Called by NotebookCell on mount to declare itself to the
 *       executor. Idempotent across re-mounts.
 *
 *   - run(id) → Promise<void>
 *       Force-run a single cell. Pulls latest edited source from the
 *       cell store and pushes into ReactiveExecutor.setCell, which
 *       cascades to downstream cells.
 *
 *   - runAll() → Promise<void>
 *   - clear() → void
 *
 *   - state(id) → CellState | undefined
 *       Reactive accessor. The Notebook holds a $state map; this just
 *       reads from it (Svelte auto-tracks).
 *
 *   - updateSource(id, source) → void
 *       Called by editable cell sources on input. Marks the cell stale
 *       (status: "stale") so the chrome can show "edited, not re-run".
 *
 * Authors who want a custom chrome import these functions and roll
 * their own UI; they don't have to talk to ReactiveExecutor directly.
 */

import { getContext, setContext } from "svelte";
import type { CellState } from "../reactiveExecutor";
import type { Cell } from "../wasmBridge";

const KEY = Symbol("workbook-notebook-context");

/** Rendering mode for cells inside this Notebook.
 *  - "notebook": Jupyter-shaped gutter with play button, status, editable source.
 *  - "document": prose-first; cell source rendered as a quoted figure
 *    with no gutter or run button. Output appears below.
 *  - "headless": no chrome; cells run silently. Useful when the
 *    consumer is rendering output via custom UI (e.g. a chart).
 */
export type NotebookMode = "notebook" | "document" | "headless";

export interface NotebookApi {
  register(cell: Cell): void;
  run(id: string): Promise<void>;
  runAll(): Promise<void>;
  clear(): void;
  state(id: string): CellState | undefined;
  updateSource(id: string, source: string): void;
  /** Number among siblings, 1-indexed, in registration order. */
  cellNumber(id: string): number;
  /** True while the executor is mid-run. */
  readonly running: boolean;
  /** True once the runtime has finished its first runAll. */
  readonly ready: boolean;
  /** Rendering mode; cells consult this to pick chrome. */
  readonly mode: NotebookMode;
  /** When true, cells default to read-only source. */
  readonly readonly: boolean;
}

export function setNotebookContext(api: NotebookApi): void {
  setContext(KEY, api);
}

export function getNotebookContext(): NotebookApi {
  const api = getContext<NotebookApi | undefined>(KEY);
  if (!api) {
    throw new Error(
      "<NotebookCell> / <NotebookToolbar> must be used inside a <Notebook>",
    );
  }
  return api;
}
