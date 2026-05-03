/**
 * Authoring hooks. The runes-based escape hatch for components that
 * want fine-grained control beyond <Cell>/<Input>/<Output>.
 *
 *   useCell(id)     reactive single-cell state
 *   useDAG()        reactive whole-cell-graph view
 *   useRuntime()    raw wasm + bundle accessors (after boot)
 *
 * All three must be called inside a component that's a descendant of
 * <WorkbookApp>. Calling them outside throws — the error message
 * points at the missing wrapper.
 *
 * Why .svelte.ts: these functions use $derived under the hood, which
 * Svelte 5 only allows in .svelte and .svelte.ts modules.
 */

import { requireAuthoringContext } from "./context";
import type { CellState, ReactiveExecutor } from "../reactiveExecutor";
import type { CellStatesMap } from "./context";

/**
 * Reactive subscription to a single cell's state. Returns a getter
 * function that always reflects the latest state.
 *
 *   const cell = useCell("by_region");
 *   $effect(() => console.log(cell().status));
 *
 * The getter pattern keeps the rune chain unbroken — if we returned a
 * plain CellState we'd snapshot it at call time and lose reactivity.
 */
export function useCell(id: string): () => CellState | undefined {
  const ctx = requireAuthoringContext("useCell");
  return () => ctx.getCellState(id);
}

/**
 * Reactive view of every cell's state. Returns a getter for the
 * whole map. Useful for inspectors / overviews that want to render
 * the DAG.
 *
 *   const all = useDAG();
 *   $effect(() => {
 *     for (const [id, state] of all()) {
 *       console.log(id, state.status);
 *     }
 *   });
 */
export function useDAG(): () => CellStatesMap {
  const ctx = requireAuthoringContext("useDAG");
  return () => ctx.getAllCellStates();
}

/**
 * Direct access to the runtime bindings (wasm-bindgen exports +
 * the bundle's helpers). Returns null until the runtime has booted —
 * call ctx.ready() if you need to await.
 *
 *   const runtime = useRuntime();
 *   $effect(() => {
 *     const r = runtime();
 *     if (r) {
 *       const result = r.runPolarsSql("SELECT 1", "");
 *     }
 *   });
 */
export function useRuntime(): () => unknown {
  const ctx = requireAuthoringContext("useRuntime");
  return () => ctx.getRuntime();
}

/** Direct access to the executor. Useful when you need to call
 *  runCell/runAll imperatively (e.g. a "Run all" button). Returns
 *  null until the runtime has booted. */
export function useExecutor(): () => ReactiveExecutor | null {
  const ctx = requireAuthoringContext("useExecutor");
  return () => ctx.getExecutor();
}

/**
 * Subscribe to a Loro CRDT doc registered via <Doc id="..."> (or
 * authored as a raw <wb-doc>).
 *
 * Returns a getter that resolves to the Loro doc handle once the
 * runtime has registered it. The handle exposes Loro's full API for
 * mutations; changes round-trip through Cmd+S into the .html
 * file on save. No IDB, no localStorage — the file is the database.
 *
 *   const composition = useDoc("composition");
 *   $effect(() => {
 *     const doc = composition();
 *     if (doc) doc.getText("body").insert(0, "hello");
 *   });
 *
 * Returns null while the runtime is booting; consumers should null-
 * check on every read. Pair with useRuntime() to await ready.
 */
export function useDoc(id: string): () => unknown {
  requireAuthoringContext("useDoc");
  return () => {
    if (typeof window === "undefined") return null;
    type RuntimeApi = { getDocHandle?: (id: string) => unknown };
    const rt = (window as Window & { __wbRuntime?: RuntimeApi }).__wbRuntime;
    if (!rt || typeof rt.getDocHandle !== "function") return null;
    try { return rt.getDocHandle(id); } catch { return null; }
  };
}

/**
 * Read + append to a registered <wb-memory> stream. Returns a getter
 * that resolves to a small interface:
 *
 *   const memory = useMemory("chat-thread");
 *   const m = memory();
 *   if (m) {
 *     await m.append([{ ts: Date.now(), role: "user", text: "hi" }]);
 *     const bytes = await m.export();   // current Arrow IPC bytes
 *   }
 *
 * Save handler captures current state on Cmd+S; nothing IDB-shaped.
 */
export interface MemoryHandle {
  /** Append rows to the memory stream. The runtime serializes them
   *  via Arrow IPC and updates the in-memory state. */
  append(rows: Record<string, unknown>[]): Promise<void>;
  /** Export current state as Arrow IPC bytes. Mostly useful for
   *  custom serialization; the save handler does this automatically. */
  export(): Promise<Uint8Array>;
}

export function useMemory(id: string): () => MemoryHandle | null {
  requireAuthoringContext("useMemory");
  return () => {
    if (typeof window === "undefined") return null;
    type RuntimeApi = {
      appendMemory?: (id: string, rows: Record<string, unknown>[]) => Promise<void>;
      exportMemory?: (id: string) => Promise<Uint8Array>;
    };
    const rt = (window as Window & { __wbRuntime?: RuntimeApi }).__wbRuntime;
    if (!rt || typeof rt.exportMemory !== "function") return null;
    return {
      append: (rows) => rt.appendMemory?.(id, rows) ?? Promise.resolve(),
      export: () => rt.exportMemory!(id),
    };
  };
}
