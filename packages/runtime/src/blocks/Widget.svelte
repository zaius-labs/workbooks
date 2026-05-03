<script lang="ts">
  /* Widget block render shell (epic core-6vr / B1).
   *
   * Phase B is render-only: shows the wrapped composition's id +
   * paramBinding count without mounting the /i/[slug] runtime in-place.
   * Mounting + binding resolution lands in Phase C alongside the shared
   * binding-resolver helper that step actions also use. */

  import type { WidgetBlock } from "../types";

  let { block }: { block: WidgetBlock } = $props();

  const bindingCount = $derived(Object.keys(block.paramBindings ?? {}).length);
</script>

<div
  class="rounded-[14px] border border-border bg-surface-soft px-4 py-3"
>
  <div class="flex flex-wrap items-center gap-2">
    <span class="text-[14px] font-medium text-fg">
      {block.title ?? "Widget"}
    </span>
    <span
      class="rounded-md border border-border px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-fg-muted"
    >
      Composition
    </span>
  </div>
  <div class="mt-1 text-[12px] text-fg-muted">
    <span>composition · {block.compositionId}</span>
    {#if bindingCount > 0}
      <span class="mx-1.5">·</span>
      <span>{bindingCount} binding{bindingCount === 1 ? "" : "s"}</span>
    {/if}
  </div>
  <div
    class="mt-2 rounded-md border border-dashed border-border bg-surface px-3 py-4 text-center text-[12px] text-fg-muted"
    title="Composition mount lands in Phase C"
  >
    Composition preview · Phase C wires the live mount
  </div>
</div>
