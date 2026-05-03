<!--
  <NotebookCell> — per-cell chrome with play button, status indicator,
  source view, and output rendering. Auto-registers with the
  surrounding <Notebook> on mount.

  Authoring:
    <NotebookCell language="polars" id="hotspots">
    SELECT region, churn FROM data WHERE churn > 0.10
    </NotebookCell>

  The remarkWorkbookCells plugin (CLI) emits this shape from fenced
  workbook code blocks in .svx files, so the markdown author just
  writes ```polars id="hotspots" and gets a chromed cell.

  Class hooks for styling override:
    .nb-cell                  — root
    .nb-cell.running / .ok / .error / .stale / .pending
    .nb-cell-gutter           — left strip with cell number + run button
    .nb-cell-source           — the (editable) source area
    .nb-cell-output           — the result panel

  Source is read-only by default so notebooks can be shipped
  without surprise edits. Pass `editable` to opt into a textarea.
-->
<script>
  import { onMount } from "svelte";
  import { getNotebookContext } from "./context";
  import { renderCellOutput } from "./renderOutput";

  let {
    id,
    language,
    /** Initial source (may also come from children when used inline). */
    source = "",
    /** Workbook input names this cell consumes. The executor looks
     *  these up in the surrounding Notebook's `inputs` map and
     *  passes them to the runtime as cell params. For Polars cells,
     *  `reads="csv"` is the canonical way to wire CSV data. */
    reads = undefined,
    /** Names this cell defines for downstream cells. */
    provides = undefined,
    /** Explicit upstream cell ids; usually inferred from reads. */
    dependsOn = undefined,
    /** Allow user edits. Defaults to !nb.readonly so notebooks
     *  let users edit + re-run, documents stay read-only. */
    editable = undefined,
    /** Optional human label shown next to the cell number. */
    label = "",
    children,
  } = $props();

  // Normalize reads/provides — props arrive as either string ("a")
  // or array (["a", "b"]). Pass through to the executor as arrays.
  function asArray(v) {
    if (v == null) return undefined;
    if (Array.isArray(v)) return v;
    return String(v).split(/[,\s]+/).filter(Boolean);
  }

  // If used in markdown form (children slot), the body text becomes
  // the source. If `source` prop was passed, it wins.
  let _src = $state(source);
  let textareaEl = $state();

  // Pull body text from the rendered children once on mount. We use
  // a hidden span we render below to capture the slot content; if no
  // children, falls back to the prop.
  let bodyEl;
  onMount(() => {
    if (bodyEl && bodyEl.textContent && !source) {
      _src = bodyEl.textContent.replace(/^\s+|\s+$/g, "");
    }
    // `reads` attribute is the ergonomic name (matches html-agent's
    // `<wb-cell reads="csv">`), but the executor's analyzer keys off
    // `cell.dependsOn`. Merge both into dependsOn — explicit always
    // wins over inferred reads.
    const explicit = asArray(dependsOn) ?? asArray(reads);
    nb.register({
      id,
      language,
      source: _src,
      provides: asArray(provides),
      dependsOn: explicit,
    });
  });

  const nb = getNotebookContext();

  // Reactive cell state (pending / running / ok / error / stale)
  let state = $derived(nb.state(id) ?? { cellId: id, status: "pending" });
  let n = $derived(nb.cellNumber(id));
  // Mode from context drives chrome shape. Editable defaults from mode.
  let mode = $derived(nb.mode);
  let canEdit = $derived(editable ?? !nb.readonly);
  let showGutter = $derived(mode === "notebook");
  let visible = $derived(mode !== "headless");

  function onRun() { nb.run(id); }
  function onSourceInput(e) {
    _src = e.currentTarget.value;
    nb.updateSource(id, _src);
  }
</script>

<!-- Capture children (markdown slot text) so onMount can read it. -->
<span bind:this={bodyEl} hidden>{@render children?.()}</span>

{#if visible}
<div class="nb-cell {state.status}" class:nb-mode-document={mode === "document"} data-cell-id={id} data-language={language}>
  {#if showGutter}
    <div class="nb-cell-gutter">
      <button
        class="nb-cell-run"
        onclick={onRun}
        title="Run cell"
        aria-label="Run cell"
        disabled={state.status === "running"}
      >
        {#if state.status === "running"}
          <span class="nb-spinner" aria-hidden="true"></span>
        {:else}
          <span class="nb-play" aria-hidden="true">▶</span>
        {/if}
      </button>
      <span class="nb-cell-num">[{n || "·"}]</span>
    </div>
  {/if}

  <div class="nb-cell-body">
    <div class="nb-cell-head">
      <span class="nb-cell-lang">{language}</span>
      <span class="nb-cell-id">{id}</span>
      {#if label}<span class="nb-cell-label">{label}</span>{/if}
      <span class="nb-cell-status">
        {#if state.status === "running"}running…{:else if state.status === "ok"}{state.lastRunMs != null ? `${state.lastRunMs} ms` : "ok"}{:else if state.status === "error"}error{:else if state.status === "stale"}{state.error ? "upstream error" : "edited (re-run)"}{/if}
      </span>
    </div>

    {#if canEdit}
      <textarea
        class="nb-cell-source nb-editable"
        bind:this={textareaEl}
        value={_src}
        oninput={onSourceInput}
        spellcheck="false"
        rows={Math.max(1, _src.split("\n").length)}
      ></textarea>
    {:else}
      <pre class="nb-cell-source">{_src}</pre>
    {/if}

    <div class="nb-cell-output">
      {#if state.status === "error"}
        <div class="nb-cell-error">{state.error ?? "error"}</div>
      {:else if !state.outputs || !state.outputs.length}
        <div class="nb-cell-empty">—</div>
      {:else}
        {@html renderCellOutput(state.outputs)}
      {/if}
    </div>
  </div>
</div>
{/if}

<style>
  .nb-cell {
    display: grid;
    grid-template-columns: 56px 1fr;
    margin: 16px 0;
    border: 1px solid var(--nb-line, #d6d6d6);
    border-radius: 4px;
    background: var(--nb-bg, #ffffff);
    overflow: hidden;
    transition: border-color 220ms cubic-bezier(0.16, 1, 0.3, 1);
    font-family: var(--nb-mono, "JetBrains Mono", ui-monospace, monospace);
    font-size: 13px;
  }
  .nb-cell.running { border-color: var(--nb-ink-3, #707070); }
  .nb-cell.ok      { border-color: var(--nb-ink-3, #707070); }
  .nb-cell.error   { border: 2px solid var(--nb-error, #dc2626); }
  .nb-cell.stale   { border-style: dashed; }

  .nb-cell-gutter {
    display: flex; flex-direction: column; align-items: center;
    gap: 6px; padding: 8px 6px;
    border-right: 1px solid var(--nb-line, #d6d6d6);
    background: var(--nb-bg-2, #f5f5f5);
    user-select: none;
  }
  .nb-cell-run {
    width: 28px; height: 28px; border-radius: 4px;
    border: 1px solid var(--nb-line, #d6d6d6);
    background: var(--nb-bg, #ffffff);
    color: var(--nb-ink, #000);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; padding: 0;
    transition: background 120ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .nb-cell-run:hover:not(:disabled) {
    background: var(--nb-ink, #000); color: var(--nb-bg, #fff);
    border-color: var(--nb-ink, #000);
  }
  .nb-cell-run:disabled { opacity: 0.6; cursor: not-allowed; }
  .nb-play { font-size: 11px; line-height: 1; transform: translate(1px, 0); }
  .nb-spinner {
    width: 12px; height: 12px; border-radius: 50%;
    border: 2px solid currentColor; border-right-color: transparent;
    animation: nb-spin 700ms linear infinite;
  }
  .nb-cell-num {
    font-size: 11px; color: var(--nb-ink-3, #707070);
    font-family: var(--nb-mono, "JetBrains Mono", ui-monospace, monospace);
  }

  .nb-cell-body { display: grid; }
  .nb-cell-head {
    display: flex; align-items: baseline; gap: 12px;
    padding: 6px 12px; border-bottom: 1px solid var(--nb-line, #d6d6d6);
    background: var(--nb-bg-2, #f5f5f5);
    font-size: 11px; color: var(--nb-ink-3, #707070);
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .nb-cell-lang { color: var(--nb-ink-2, #2a2a2a); font-weight: 600; }
  .nb-cell-id   { color: var(--nb-ink, #000); font-weight: 600; }
  .nb-cell-label { color: var(--nb-ink-2, #2a2a2a); text-transform: none; letter-spacing: 0; }
  .nb-cell-status { margin-left: auto; }

  .nb-cell-source {
    margin: 0; padding: 10px 14px;
    font-family: var(--nb-mono, "JetBrains Mono", ui-monospace, monospace);
    font-size: 13px; line-height: 1.5;
    white-space: pre-wrap; color: var(--nb-ink, #000);
    background: transparent;
    border: 0;
  }
  textarea.nb-cell-source {
    width: 100%; box-sizing: border-box;
    resize: vertical; min-height: 1.5em;
  }
  textarea.nb-cell-source:focus {
    outline: 1px solid var(--nb-ink, #000);
    outline-offset: -1px;
  }

  .nb-cell-output {
    padding: 8px 14px;
    border-top: 1px solid var(--nb-line, #d6d6d6);
    background: var(--nb-bg-2, #f5f5f5);
    font-size: 13px;
  }
  .nb-cell-empty { color: var(--nb-ink-4, #a8a8a8); font-style: italic; }
  .nb-cell-error {
    color: var(--nb-error, #dc2626);
    font-weight: 600;
    white-space: pre-wrap;
  }
  /* Status text in head — pull error to red so the cell head's
     "error" label matches the border + body text. */
  .nb-cell.error .nb-cell-status { color: var(--nb-error, #dc2626); font-weight: 600; }
  /* Stale (upstream error) gets a slightly muted red so it's
     distinguishable from a direct error but obviously broken. */
  .nb-cell.stale .nb-cell-status { color: var(--nb-error, #dc2626); opacity: 0.7; }

  /* Output styling — kept low-specificity so consumers can override. */
  .nb-cell-output :global(table) { border-collapse: collapse; font-size: 13px; background: var(--nb-bg, #fff); }
  .nb-cell-output :global(th),
  .nb-cell-output :global(td) {
    border: 1px solid var(--nb-line, #d6d6d6);
    padding: 4px 10px; text-align: left;
  }
  .nb-cell-output :global(th) { background: var(--nb-bg-2, #f5f5f5); font-weight: 600; }
  .nb-cell-output :global(td.num) { text-align: right; font-feature-settings: "tnum"; }

  @keyframes nb-spin { to { transform: rotate(360deg); } }

  /* Document mode — single-column (no gutter), source as a quoted
     figure, output flush below. The author wraps with <Notebook
     mode="document"> when they want a paper-feel rather than a
     Jupyter-feel. */
  .nb-cell.nb-mode-document {
    grid-template-columns: 1fr;
    border-left: 3px solid var(--nb-ink-3, #707070);
    border-radius: 4px;
    margin: 16px 0;
  }
  .nb-cell.nb-mode-document .nb-cell-head {
    background: transparent;
    color: var(--nb-ink-3, #707070);
  }
</style>
