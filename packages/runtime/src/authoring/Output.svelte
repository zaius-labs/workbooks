<script lang="ts">
  /**
   * <Output> — render a cell's output reactively.
   *
   * Two modes:
   *   <Output for="cell-id" />   — looks up state from the DAG context
   *   <Output value={state} />   — renders a CellState directly (escape
   *                                 hatch for hand-rolled state mgmt)
   *
   * Default UI dispatches on output `kind` and renders something
   * sensible:
   *   text   → <pre>
   *   table  → small grid (first 20 rows from sql_table preview)
   *   image  → <img src="data:...">
   *   error  → minimal error panel with message + traceback
   *   stream → live <pre> as content arrives
   *
   * Authors take over rendering via the `render` snippet:
   *
   *   <Output for="cell-id">
   *     {#snippet render(state)}
   *       <MyVisualizer data={state.output} />
   *     {/snippet}
   *   </Output>
   *
   * Or compose with kind-specific snippets (table, image, etc.).
   */

  import type { Snippet } from "svelte";
  import { requireAuthoringContext } from "./context";
  import type { CellState } from "../reactiveExecutor";
  import type { CellOutput } from "../wasmBridge";

  type Props = {
    /** Cell id whose output to render. Required unless `value` is given. */
    for?: string;
    /** Direct state — bypasses the context lookup. Useful when the
     *  parent already holds a CellState and wants to render it. */
    value?: CellState | null | undefined;
    /** Take over the entire render path. */
    render?: Snippet<[CellState]>;
    /** Per-kind override snippets. */
    text?: Snippet<[Extract<CellOutput, { kind: "text" }>]>;
    table?: Snippet<[Extract<CellOutput, { kind: "table" }>]>;
    image?: Snippet<[Extract<CellOutput, { kind: "image" }>]>;
    error?: Snippet<[Extract<CellOutput, { kind: "error" }>]>;
    /** Pass-through HTML class for the wrapper. */
    class?: string;
  };

  let {
    for: cellId,
    value,
    render,
    text,
    table,
    image,
    error: errorSnippet,
    class: klass = "",
  }: Props = $props();

  const ctx = requireAuthoringContext("Output");

  const state = $derived(
    value !== undefined ? value : (cellId ? ctx.getCellState(cellId) : undefined),
  );

  const firstOutput = $derived<CellOutput | undefined>(
    state?.outputs?.[0],
  );

  // Pretty-print a table preview from the SQL-string format the runtime
  // emits. The format is generally tab- or space-separated rows; we
  // don't try to be clever — wrapping in <pre> is honest and robust.
  function tablePreview(sqlTable: string): string {
    return sqlTable.length > 8000
      ? sqlTable.slice(0, 8000) + "\n…"
      : sqlTable;
  }
</script>

<div class="wb-output {klass}">
  {#if !state}
    <!-- Cell hasn't registered yet, or no state available. Render
         nothing rather than a confusing placeholder. -->
  {:else if state.status === "pending" || state.status === "running"}
    <div class="wb-output__pending">{state.status}…</div>
  {:else if render}
    {@render render(state)}
  {:else if state.status === "error"}
    {#if errorSnippet}
      {@render errorSnippet({ kind: "error", message: state.error ?? "unknown error" })}
    {:else}
      <div class="wb-output__error">
        <strong>error</strong>
        <pre>{state.error ?? "unknown error"}</pre>
      </div>
    {/if}
  {:else if firstOutput}
    {@const out = firstOutput}
    {#if out.kind === "text"}
      {#if text}
        {@render text(out)}
      {:else}
        <pre class="wb-output__text">{out.content}</pre>
      {/if}
    {:else if out.kind === "image"}
      {#if image}
        {@render image(out)}
      {:else}
        <img class="wb-output__image" src="data:{out.mime_type};base64,{out.content}" alt="" />
      {/if}
    {:else if out.kind === "table"}
      {#if table}
        {@render table(out)}
      {:else}
        <pre class="wb-output__table">{tablePreview(out.sql_table)}</pre>
        {#if out.row_count !== undefined}
          <p class="wb-output__meta">{out.row_count} rows</p>
        {/if}
      {/if}
    {:else if out.kind === "stream"}
      <pre class="wb-output__stream">{out.content}</pre>
    {/if}
  {/if}
</div>

<style>
  .wb-output__pending {
    font: 11px/1 ui-monospace, "SF Mono", Menlo, monospace;
    color: #8a909c;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 6px 0;
  }
  .wb-output__error {
    padding: 12px;
    border: 1px solid #ef4444;
    border-radius: 4px;
    background: #fef2f2;
    color: #991b1b;
    font: 13px/1.5 ui-monospace, "SF Mono", Menlo, monospace;
  }
  .wb-output__error pre {
    margin: 4px 0 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .wb-output__error-tb { opacity: 0.7; font-size: 11px; }
  .wb-output__text,
  .wb-output__table,
  .wb-output__stream {
    margin: 0;
    padding: 12px;
    border: 1px solid #e5e2db;
    border-radius: 4px;
    background: #fafaf7;
    font: 12px/1.5 ui-monospace, "SF Mono", Menlo, monospace;
    color: #0f1115;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
  }
  .wb-output__image { max-width: 100%; height: auto; display: block; border-radius: 4px; }
  .wb-output__meta { font: 11px/1 ui-monospace; color: #8a909c; margin: 4px 0 0; }
</style>
