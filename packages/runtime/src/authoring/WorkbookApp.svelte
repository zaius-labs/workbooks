<script lang="ts">
  /**
   * <WorkbookApp> — root of a declarative authoring tree.
   *
   * Boots the workbook runtime (WASM + bundle), creates the cell-DAG
   * executor, and exposes both through a Svelte context that <Cell>,
   * <Input>, <Output>, <Chart>, <Agent>, <Chat> consume. Authors write:
   *
   *   <WorkbookApp>
   *     <Input name="csv" default={initial} bind:value={csv} />
   *     <Cell id="by_region" language="polars" reads="csv">
   *       SELECT region, SUM(revenue) FROM data GROUP BY region
   *     </Cell>
   *     <Output for="by_region" />
   *   </WorkbookApp>
   *
   * Naming rationale: the existing <Workbook> component renders a
   * finalized WorkbookDocument JSON (used by the signal app); we don't
   * want to break that surface. <WorkbookApp> is the authoring root.
   *
   * The component renders a `<div class="wb-app">` wrapper by default
   * so authors can target it with CSS. Slot props expose `runtime`,
   * `executor`, `booted`, and `error` for advanced UIs that want to
   * surface load/error states themselves.
   */

  import { onMount, onDestroy, untrack } from "svelte";
  import type { Snippet } from "svelte";
  import {
    setAuthoringContext,
    type AuthoringContext,
    type CellStatesMap,
  } from "./context";
  import type { ReactiveExecutor, CellState } from "../reactiveExecutor";
  import type { Cell as CellSpec } from "../wasmBridge";

  type Props = {
    /** Children — the authoring tree. */
    children?: Snippet<[{
      runtime: unknown;
      executor: ReactiveExecutor | null;
      booted: boolean;
      error: Error | null;
    }]>;
    /** Slot for a custom loading state. Default is invisible (null). */
    loading?: Snippet;
    /** Slot for a custom error state. Default renders a minimal panel. */
    errorPanel?: Snippet<[Error]>;
    /** Optional pre-built runtime; useful for testing or for authors who
     *  want to share a runtime across multiple <WorkbookApp> roots. If
     *  omitted, we lazy-load via virtual:workbook-runtime. */
    runtime?: unknown;
    /** Stable workbook slug for telemetry / debug logging. Defaults to
     *  "live". The executor uses this in its log lines. */
    slug?: string;
    /** Pass-through HTML class for the wrapper div. */
    class?: string;
  };
  let {
    children,
    loading,
    errorPanel,
    runtime: runtimeProp,
    slug = "live",
    class: klass = "",
  }: Props = $props();

  // ---- reactive state ----------------------------------------------------

  // runtime starts null and is set in onMount once the wasm bundle has
  // resolved (or runtimeProp was supplied). Don't seed from runtimeProp
  // here — Svelte's prop reactivity rules mean a non-static initial
  // capture warns; the boot path handles the supplied case explicitly.
  let runtime = $state<unknown>(null);
  let executor = $state<ReactiveExecutor | null>(null);
  let booted = $state(false);
  let error = $state<Error | null>(null);

  // Cell-state map. Replaced (not mutated) on each transition so $derived
  // reads against the map invalidate cleanly.
  let cellStates = $state<Map<string, CellState>>(new Map());

  // Buffers for cells/inputs registered before the executor exists.
  // Drained once the runtime finishes booting.
  const pendingCells = new Map<string, CellSpec>();
  const pendingInputs = new Map<string, unknown>();

  // Promise that resolves when the runtime is ready. Components that
  // need to wait for boot (e.g. an <Output> that wants to imperatively
  // call executor.runCell on click) hook this.
  let resolveReady: () => void;
  const readyPromise = new Promise<void>((r) => { resolveReady = r; });

  // ---- context shape -----------------------------------------------------

  const ctx: AuthoringContext = {
    registerCell(cell) {
      pendingCells.set(cell.id, cell);
      if (executor) executor.setCell(cell);
    },
    unregisterCell(cellId) {
      pendingCells.delete(cellId);
      // ReactiveExecutor doesn't currently expose a removeCell — leave
      // the cell registered; the next runAll will skip it because
      // nothing reads it. Tracked as a follow-up.
    },
    setInput(name, value) {
      pendingInputs.set(name, value);
      if (executor) executor.setInput(name, value);
    },
    getInput(name) {
      return pendingInputs.get(name);
    },
    getCellState(cellId) {
      return cellStates.get(cellId);
    },
    getAllCellStates(): CellStatesMap {
      return cellStates;
    },
    getExecutor() {
      return executor;
    },
    getRuntime() {
      return runtime;
    },
    isBooted() {
      return booted;
    },
    ready() {
      return readyPromise;
    },
  };

  setAuthoringContext(ctx);

  // ---- runtime boot ------------------------------------------------------

  onMount(async () => {
    try {
      let wasm: any;
      let bundle: any;

      if (runtimeProp) {
        // Caller supplied a pre-built runtime. Expected shape:
        //   { wasm, bundle } — same as virtual:workbook-runtime returns.
        const supplied = runtimeProp as { wasm: unknown; bundle: unknown };
        wasm = supplied.wasm;
        bundle = supplied.bundle;
      } else {
        // Lazy-load. The dynamic import shape lets bundlers code-split
        // the runtime away from user app code. virtual:workbook-runtime
        // is provided by the workbook-cli vite plugin at build time;
        // in dev it points at the runtime-wasm pkg/.
        // @ts-expect-error — virtual module resolved at build time
        const mod = await import("virtual:workbook-runtime");
        const { wasm: w, bundle: b } = await mod.loadRuntime();
        wasm = w;
        bundle = b;
      }

      if (!bundle?.createRuntimeClient) {
        throw new Error(
          "workbook runtime bundle is missing createRuntimeClient — " +
          "is the bundle out of date?",
        );
      }

      const client = bundle.createRuntimeClient(wasm);
      const ReactiveExecutorCtor = bundle.ReactiveExecutor;
      if (!ReactiveExecutorCtor) {
        throw new Error("workbook runtime bundle is missing ReactiveExecutor");
      }

      // Drain pending cells/inputs into the constructor so the first
      // run happens with everything in place.
      const exec = new ReactiveExecutorCtor({
        client,
        cells: [...pendingCells.values()],
        inputs: Object.fromEntries(pendingInputs),
        workbookSlug: slug,
        onCellState: (state: CellState) => {
          // Immutable map update so $state runes pick up the change.
          const next = new Map(cellStates);
          next.set(state.cellId, state);
          cellStates = next;
        },
      });

      executor = exec;
      runtime = wasm;
      booted = true;
      resolveReady();

      // Expose the runtime client globally so the cli's save handler
      // (workbook-cli/src/runtime-inject/saveHandler.mjs) can call
      // exportDoc/exportMemory on Cmd+S, refreshing every <wb-doc>
      // and <wb-memory> element with current state before serializing
      // the file. This is what makes "the file IS the database" work
      // — Loro CRDT mutations and Arrow-memory appends round-trip
      // back into the .html on save.
      if (typeof window !== "undefined") {
        (window as Window & { __wbRuntime?: unknown }).__wbRuntime = client;
      }

      await exec.runAll();
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
      // Resolve the readiness promise even on error so consumers
      // hooking it don't hang forever; they can check `error` and
      // `booted` separately.
      resolveReady();
    }
  });

  onDestroy(() => {
    if (executor) {
      try { executor.destroy(); } catch { /* ignore */ }
    }
  });

  // Default error panel — minimal, monochrome, replaceable by passing
  // an `errorPanel` snippet. We resist styling here so the SDK doesn't
  // impose a design system; authors who want richer error UI replace
  // the slot.
</script>

<div class="wb-app {klass}">
  {#if error && errorPanel}
    {@render errorPanel(error)}
  {:else if error}
    <div class="wb-app__error">
      <strong>workbook failed to load:</strong>
      <pre>{error.message}</pre>
    </div>
  {:else if !booted && loading}
    {@render loading()}
  {/if}

  {@render children?.({ runtime, executor, booted, error })}
</div>

<style>
  .wb-app__error {
    padding: 16px;
    border: 1px solid #ef4444;
    border-radius: 6px;
    background: #fef2f2;
    color: #991b1b;
    font: 13px/1.5 ui-monospace, "SF Mono", Menlo, monospace;
  }
  .wb-app__error pre {
    margin: 4px 0 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
