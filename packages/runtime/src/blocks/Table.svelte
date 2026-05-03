<script lang="ts">
  import type { TableBlock } from "../types";
  let { block }: { block: TableBlock } = $props();
  const numeric = $derived(new Set(block.numericColumns ?? []));

  function fmt(v: string | number | null): string {
    if (v === null || v === undefined) return "—";
    return String(v);
  }
</script>

<figure
  class="flex flex-col gap-2 overflow-hidden rounded-[18px] border border-border bg-surface p-3"
>
  {#if block.title}
    <figcaption class="flex items-center gap-2 px-1 pt-1">
      <span
        class="rounded-full border border-border bg-surface-soft px-2 py-0.5 text-[10px] uppercase tracking-wider text-fg-muted"
        >table</span
      >
      <h3 class="text-[14px] font-semibold tracking-tight">{block.title}</h3>
    </figcaption>
  {/if}
  <div class="overflow-x-auto">
    <table class="w-full border-collapse text-[13px]">
      <thead class="bg-surface-soft">
        <tr>
          {#each block.headers as h, i (h)}
            <th
              class="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-fg-muted {numeric.has(
                i,
              )
                ? 'text-right'
                : 'text-left'}"
            >
              {h}
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each block.rows as row, ri (ri)}
          <tr class="border-t border-border">
            {#each row as cell, ci (ci)}
              <td
                class="px-3 py-2 {numeric.has(ci)
                  ? 'text-right tabular-nums'
                  : ''} {ci === 0 ? 'font-medium' : ''}"
              >
                {fmt(cell)}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if block.caption}
    <p class="px-1 pb-1 text-[12.5px] text-fg-muted">
      {block.caption}
    </p>
  {/if}
</figure>
