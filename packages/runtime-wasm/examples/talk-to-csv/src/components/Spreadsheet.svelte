<script>
  let { rows, title = "data", subtitle = "", busy = false } = $props();

  function fmtCell(v) {
    if (v == null) return "";
    if (typeof v === "number") {
      if (Number.isInteger(v) && Math.abs(v) < 10000) return String(v);
      if (Number.isInteger(v)) return v.toLocaleString();
      return v.toFixed(2);
    }
    return String(v);
  }

  let cols = $derived(rows && rows.length ? Object.keys(rows[0]) : []);
</script>

<div class="border border-border bg-surface flex flex-col h-full overflow-hidden">
  <div class="px-4 py-2.5 border-b border-border flex items-baseline justify-between flex-shrink-0">
    <div>
      <div class="text-sm font-semibold">{title}</div>
      {#if subtitle}
        <div class="text-[11px] text-fg-muted font-mono">{subtitle}</div>
      {/if}
    </div>
    {#if rows && rows.length}
      <div class="text-[11px] text-fg-muted font-mono">
        {rows.length.toLocaleString()} × {cols.length}
      </div>
    {/if}
  </div>

  <div class="flex-1 overflow-auto">
    {#if busy}
      <div class="p-8 text-center text-sm text-fg-muted font-mono">running query…</div>
    {:else if !rows || !rows.length}
      <div class="p-8 text-center text-sm text-fg-muted">no rows</div>
    {:else}
      <table class="text-[12px] font-mono w-full border-collapse">
        <thead class="sticky top-0 bg-surface z-10">
          <tr class="border-b border-border">
            <th class="text-right px-2 py-1.5 text-[10px] text-fg-faint font-normal w-10">#</th>
            {#each cols as col}
              <th class="text-left px-2 py-1.5 text-[10px] text-fg-muted uppercase tracking-wider font-normal whitespace-nowrap">
                {col}
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each rows as row, i}
            <tr class="border-b border-border last:border-0 {i % 2 ? '' : 'bg-page/30'}">
              <td class="text-right px-2 py-1 text-fg-faint align-top">{i + 1}</td>
              {#each cols as col}
                <td class="px-2 py-1 align-top whitespace-nowrap">{fmtCell(row[col])}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>
