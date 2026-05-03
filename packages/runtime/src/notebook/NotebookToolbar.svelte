<!--
  <NotebookToolbar> — Run All / Clear / status. Reads the surrounding
  <Notebook> via context. Authors who want a custom toolbar can build
  one against `getNotebookContext()`.
-->
<script>
  import { getNotebookContext } from "./context";
  let { showClear = true } = $props();
  const nb = getNotebookContext();
</script>

<div class="nb-toolbar" class:running={nb.running}>
  <button
    class="nb-btn primary"
    onclick={() => nb.runAll()}
    disabled={!nb.ready || nb.running}
    title="Run all cells from top to bottom"
  >
    {nb.running ? "running…" : "Run All"}
  </button>
  {#if showClear}
    <button
      class="nb-btn"
      onclick={() => nb.clear()}
      disabled={nb.running}
      title="Clear cell outputs (does not re-run)"
    >
      Clear outputs
    </button>
  {/if}
  <span class="nb-toolbar-status">
    {#if !nb.ready}initializing wasm…{/if}
  </span>
</div>

<style>
  .nb-toolbar {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px;
    border: 1px solid var(--nb-line, #d6d6d6); border-radius: 4px;
    background: var(--nb-bg, #ffffff);
    margin: 0 0 12px;
  }
  .nb-btn {
    padding: 6px 12px; font-size: 13px;
    border: 1px solid var(--nb-line, #d6d6d6); border-radius: 4px;
    background: var(--nb-bg, #ffffff); color: var(--nb-ink, #000);
    cursor: pointer;
    font-family: inherit;
  }
  .nb-btn:hover:not(:disabled) {
    background: var(--nb-bg-3, #ebebeb);
    border-color: var(--nb-ink-3, #707070);
  }
  .nb-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .nb-btn.primary {
    background: var(--nb-ink, #000);
    color: var(--nb-bg, #fff);
    border-color: var(--nb-ink, #000);
  }
  .nb-btn.primary:hover:not(:disabled) {
    background: var(--nb-ink-2, #2a2a2a);
    border-color: var(--nb-ink-2, #2a2a2a);
  }
  .nb-toolbar-status {
    margin-left: auto;
    font-family: var(--nb-mono, "JetBrains Mono", ui-monospace, monospace);
    font-size: 11px; color: var(--nb-ink-3, #707070);
    text-transform: uppercase; letter-spacing: 0.06em;
  }
</style>
