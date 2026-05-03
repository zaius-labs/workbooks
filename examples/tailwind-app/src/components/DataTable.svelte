<script>
  let { rows = [], columns = null } = $props();
  let cols = $derived(columns ?? (rows[0] ? Object.keys(rows[0]) : []));

  function formatNumber(n) {
    if (Number.isInteger(n)) return n.toLocaleString();
    if (Math.abs(n) < 1) return n.toFixed(3);
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
</script>

<div class="border border-border rounded bg-surface overflow-x-auto">
  {#if !rows.length}
    <div class="p-6 text-center text-fg-faint italic text-sm">no rows</div>
  {:else}
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-border bg-page">
          {#each cols as c}
            <th class="text-left font-medium px-3 py-2 text-fg-muted">{c}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each rows as row, i (i)}
          <tr class="border-b border-border last:border-b-0 hover:bg-page/60">
            {#each cols as c}
              {@const v = row[c]}
              <td class="px-3 py-2" class:tabular-nums={typeof v === "number"} class:text-right={typeof v === "number"}>
                {typeof v === "number" ? formatNumber(v) : v}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
