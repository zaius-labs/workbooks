<script lang="ts">
  import type { HeadingBlock } from "../types";
  let { block }: { block: HeadingBlock } = $props();
  const klass = $derived(
    block.level === 1
      ? "text-[20px] font-semibold tracking-tight"
      : block.level === 2
        ? "text-[17px] font-semibold tracking-tight"
        : block.level === 3
          ? "text-[14px] font-semibold tracking-tight"
          : "text-[13px] font-semibold tracking-tight uppercase text-fg-muted",
  );
</script>

{#if block.level === 1}
  <h1 class={klass}>{block.text}</h1>
{:else if block.level === 2}
  <h2 class={klass}>{block.text}</h2>
{:else if block.level === 3}
  <h3 class={klass}>{block.text}</h3>
{:else}
  <h4 class={klass}>{block.text}</h4>
{/if}
