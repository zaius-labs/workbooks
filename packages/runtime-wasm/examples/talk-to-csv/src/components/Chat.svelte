<script>
  let { turns, activeId, onPick } = $props();

  function fmtCount(n, busy, error) {
    if (busy) return "…";
    if (error) return "error";
    if (n == null) return "—";
    return `${n.toLocaleString()} row${n === 1 ? "" : "s"}`;
  }
</script>

<div class="space-y-3">
  {#each turns as turn (turn.id)}
    {@const active = turn.id === activeId}
    <button
      type="button"
      onclick={() => onPick(turn.id)}
      class="w-full text-left border bg-surface block p-3 transition-colors {active ? 'border-fg' : 'border-border hover:border-fg-muted'}"
    >
      <div class="flex items-baseline justify-between mb-1.5 gap-2">
        <div class="text-[10px] uppercase tracking-wider text-fg-muted font-mono">
          {turn.source === "llm" ? "via llm" : "canned"}
        </div>
        <div class="text-[10px] uppercase tracking-wider font-mono {turn.error ? 'text-fg' : 'text-fg-muted'}">
          {fmtCount(turn.rows?.length, turn.busy, turn.error)}
        </div>
      </div>
      <div class="text-sm mb-2 leading-snug">{turn.question}</div>
      {#if turn.error}
        <pre class="text-[11px] font-mono text-fg whitespace-pre-wrap">{turn.error}</pre>
      {:else}
        <pre class="text-[11px] font-mono text-fg-muted whitespace-pre-wrap leading-snug">{turn.sql}</pre>
      {/if}
    </button>
  {/each}
</div>
