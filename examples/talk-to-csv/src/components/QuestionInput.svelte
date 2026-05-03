<script>
  let { onAsk, busy } = $props();
  let value = $state("");

  const SUGGESTIONS = [
    "top 5 revenue",
    "by region",
    "by segment",
    "by product",
    "highest churn",
    "total revenue",
    "orders that didn't renew",
  ];

  function submit(e) {
    e?.preventDefault();
    if (!value.trim() || busy) return;
    onAsk(value.trim());
    value = "";
  }

  function pick(s) {
    value = s;
    submit();
  }
</script>

<form onsubmit={submit} class="space-y-3">
  <div class="flex gap-2">
    <input
      type="text"
      bind:value
      placeholder="ask a question — e.g. top 5 revenue by region"
      disabled={busy}
      class="input-mono flex-1 border border-border bg-surface px-3 py-2 focus:outline-none focus:border-fg disabled:opacity-50"
    />
    <button
      type="submit"
      disabled={busy || !value.trim()}
      class="bg-fg text-page px-4 text-sm uppercase tracking-wider font-mono hover:bg-fg/90 disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {busy ? "…" : "ask"}
    </button>
  </div>

  <div class="flex flex-wrap gap-1.5">
    {#each SUGGESTIONS as s}
      <button
        type="button"
        onclick={() => pick(s)}
        disabled={busy}
        class="text-[11px] font-mono px-2 py-1 border border-border hover:border-fg disabled:opacity-40"
      >
        {s}
      </button>
    {/each}
  </div>
</form>
