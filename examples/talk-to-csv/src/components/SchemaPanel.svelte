<script>
  let { schema, rowCount, sample, expanded = $bindable(false) } = $props();
</script>

<div class="border border-border bg-surface">
  <button
    type="button"
    onclick={() => (expanded = !expanded)}
    class="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-page/50"
  >
    <div class="flex items-center gap-3">
      <span class="inline-block w-2 h-2 bg-secure rounded-full"></span>
      <div>
        <div class="text-sm font-semibold">unlocked · table `data`</div>
        <div class="text-[11px] text-fg-muted font-mono">
          {schema.length} columns · {rowCount.toLocaleString()} rows · plaintext in WASM
        </div>
      </div>
    </div>
    <span class="text-[11px] uppercase tracking-wider text-fg-muted font-mono">
      {expanded ? "hide" : "show"} schema
    </span>
  </button>

  {#if expanded}
    <div class="border-t border-border px-4 py-3 space-y-3">
      <div>
        <div class="text-[11px] uppercase tracking-wider text-fg-muted font-mono mb-2">
          columns the LLM sees
        </div>
        <div class="flex flex-wrap gap-1.5">
          {#each schema as col}
            <span class="text-[12px] font-mono px-2 py-1 border border-border bg-page">
              {col.name}<span class="text-fg-faint">: {col.type}</span>
            </span>
          {/each}
        </div>
      </div>

      {#if sample && sample.length}
        <div>
          <div class="text-[11px] uppercase tracking-wider text-fg-muted font-mono mb-2">
            sample rows the LLM sees (5 of {rowCount.toLocaleString()})
          </div>
          <pre class="text-[11px] font-mono bg-page border border-border p-3 overflow-x-auto">{JSON.stringify(sample, null, 2)}</pre>
        </div>
      {/if}
    </div>
  {/if}
</div>
