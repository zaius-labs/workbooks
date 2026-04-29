<script>
  import Cell from "./Cell.svelte";
  import { notebook } from "../lib/notebook.svelte.js";
</script>

<div class="panel">
  <div class="head">
    <strong>notebook</strong>
    <span class="hint">cells re-run on dependency change · agent edits land here live</span>
  </div>
  <div class="body">
    {#if !notebook.ready}
      <div class="loading">initializing wasm…</div>
    {:else}
      {#each notebook.cellOrder as id (id)}
        {#if notebook.byId[id]}
          <Cell entry={notebook.byId[id]} />
        {/if}
      {/each}
    {/if}
  </div>
</div>

<style>
  .panel { border: 1px solid #d6d6d6; border-radius: 4px; background: #fff; }
  .head {
    padding: 12px 16px; border-bottom: 1px solid #d6d6d6;
    display: flex; align-items: baseline; gap: 12px;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 12px; color: #707070;
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .head strong { color: #000; font-weight: 600; }
  .hint { text-transform: none; letter-spacing: 0; color: #707070; }
  .body { padding: 16px; display: grid; gap: 12px; }
  .loading { color: #a8a8a8; font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 13px; padding: 12px 0; }
</style>
