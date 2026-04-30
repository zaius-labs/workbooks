<script>
  let { label, value, sublabel = "" } = $props();
</script>

<div class="border border-border rounded bg-surface p-4 flex flex-col gap-1">
  <div class="text-[11px] uppercase tracking-wider text-fg-muted font-mono">
    {label}
  </div>
  <div class="text-2xl font-semibold tabular-nums">{value}</div>
  {#if sublabel}
    <div class="text-xs text-fg-muted">{sublabel}</div>
  {/if}
</div>
