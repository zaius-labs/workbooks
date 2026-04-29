<script lang="ts">
  import type { MetricBlock } from "../types";

  let { block }: { block: MetricBlock } = $props();

  const delta = $derived(block.delta);
  const deltaText = $derived(
    delta === undefined
      ? null
      : `${delta > 0 ? "+" : ""}${delta}${block.deltaUnit === "percent" ? "%" : ""}`,
  );
  const trend = $derived(
    delta === undefined
      ? "none"
      : delta > 0
        ? "up"
        : delta < 0
          ? "down"
          : "flat",
  );
</script>

<div
  class="flex flex-col gap-1 rounded-[14px] border border-border bg-surface px-4 py-3"
>
  <span
    class="text-[10px] uppercase tracking-wider text-fg-muted"
    >{block.label}</span
  >
  <span class="text-[22px] font-semibold leading-none tracking-tight">
    {block.value}
  </span>
  {#if deltaText}
    <span
      class="text-[11.5px] {trend === 'up'
        ? 'text-emerald-700'
        : trend === 'down'
          ? 'text-rose-700'
          : 'text-fg-muted'}"
    >
      {deltaText}
      {#if block.deltaLabel}<span class="text-fg-muted">
          · {block.deltaLabel}</span
        >{/if}
    </span>
  {/if}
</div>
