<script>
  let { step } = $props();
  let open = $state(false);

  let argsPretty = $derived.by(() => {
    try { return JSON.stringify(JSON.parse(step.argumentsJson || "{}"), null, 2); }
    catch { return String(step.argumentsJson || ""); }
  });
  let argsPreview = $derived(argsPretty.replace(/\s+/g, " ").trim());
</script>

<div class="my-1.5 rounded border border-border bg-surface-2 font-mono text-[12px] overflow-hidden">
  <button
    onclick={() => open = !open}
    class="w-full flex items-center gap-2 px-2 py-1 text-fg-muted hover:bg-border text-left cursor-pointer"
  >
    <span class="text-fg-faint transition-transform" class:rotate-90={open}>▸</span>
    <span class="text-fg font-semibold">{step.name}</span>
    <span class="text-fg-faint flex-1 min-w-0 truncate">{argsPreview}</span>
  </button>
  {#if open}
    <div class="px-2 py-1.5 border-t border-border space-y-1.5">
      <div class="text-[10px] uppercase tracking-wider text-fg-faint">arguments</div>
      <pre class="m-0 whitespace-pre-wrap break-words text-fg">{argsPretty}</pre>
      <div class="text-[10px] uppercase tracking-wider text-fg-faint">result</div>
      <pre class="m-0 max-h-44 overflow-auto rounded border border-border bg-page p-1.5 text-fg-muted whitespace-pre-wrap">{step.result ?? ""}</pre>
    </div>
  {/if}
</div>
