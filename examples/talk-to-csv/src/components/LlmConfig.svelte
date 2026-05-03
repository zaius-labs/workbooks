<script>
  let { config = $bindable() } = $props();
  let expanded = $state(false);
</script>

<div class="border border-border bg-surface">
  <button
    type="button"
    onclick={() => (expanded = !expanded)}
    class="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-page/50"
  >
    <div>
      <div class="text-sm font-semibold">
        LLM panel
        <span class="text-[11px] font-mono text-fg-muted ml-2">
          {config.apiKey ? "enabled" : "off — using canned questions only"}
        </span>
      </div>
      <div class="text-[11px] text-fg-muted">
        Optional: paste an OpenRouter key to translate any question via an LLM.
      </div>
    </div>
    <span class="text-[11px] uppercase tracking-wider text-fg-muted font-mono">
      {expanded ? "hide" : "show"}
    </span>
  </button>

  {#if expanded}
    <div class="border-t border-border px-4 py-3 space-y-3">
      <div>
        <label class="block text-[11px] uppercase tracking-wider text-fg-muted font-mono mb-2">
          OpenRouter API key
        </label>
        <input
          type="password"
          bind:value={config.apiKey}
          placeholder="sk-or-v1-…"
          class="input-mono w-full border border-border bg-page px-3 py-2 focus:outline-none focus:border-fg"
        />
      </div>
      <div>
        <label class="block text-[11px] uppercase tracking-wider text-fg-muted font-mono mb-2">
          model
        </label>
        <input
          type="text"
          bind:value={config.model}
          class="input-mono w-full border border-border bg-page px-3 py-2 focus:outline-none focus:border-fg"
        />
        <p class="text-[11px] text-fg-faint mt-1.5">
          Try <span class="font-mono">anthropic/claude-haiku-4-5</span>,
          <span class="font-mono">openai/gpt-4o-mini</span>,
          <span class="font-mono">google/gemini-2.0-flash-001</span>.
        </p>
      </div>
      <label class="flex items-start gap-2 text-[11px] text-fg-muted">
        <input type="checkbox" bind:checked={config.includeSampleRows} />
        <span>
          Include 5 sample rows in the LLM prompt (helps disambiguate columns
          but does send 5 rows of decrypted data over the wire).
        </span>
      </label>
      <p class="text-[11px] text-fg-faint border-t border-border pt-3">
        Keys are kept in memory only — closed tab forgets them. Requests go
        directly from your browser to OpenRouter.
      </p>
    </div>
  {/if}
</div>
