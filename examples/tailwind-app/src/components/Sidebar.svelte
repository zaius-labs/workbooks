<script>
  let { region = $bindable("all"), threshold = $bindable(0) } = $props();
</script>

<aside class="border-r border-border bg-surface p-5 flex flex-col gap-5 min-w-[220px]">
  <div>
    <div class="text-[11px] uppercase tracking-wider text-fg-muted font-mono mb-2">
      filters
    </div>
    <div class="text-xs text-fg-muted">
      Filters re-run the wasm query reactively. Drag the slider — only
      affected cells re-execute.
    </div>
  </div>

  <label class="flex flex-col gap-1.5">
    <span class="text-[11px] uppercase tracking-wider text-fg-muted font-mono">region</span>
    <select
      bind:value={region}
      class="text-sm px-2.5 py-1.5 border border-border rounded bg-page text-fg focus:outline-none focus:border-fg"
    >
      <option value="all">all regions</option>
      <option value="us">us</option>
      <option value="eu">eu</option>
      <option value="apac">apac</option>
    </select>
  </label>

  <label class="flex flex-col gap-1.5">
    <span class="text-[11px] uppercase tracking-wider text-fg-muted font-mono">
      churn threshold ≤ {threshold.toFixed(2)}
    </span>
    <input
      type="range"
      min="0" max="0.25" step="0.01"
      bind:value={threshold}
      class="accent-accent"
    />
  </label>
</aside>
