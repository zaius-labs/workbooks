<script>
  let { step } = $props();
  let open = $state(false);

  let argsPretty = $derived.by(() => {
    try { return JSON.stringify(JSON.parse(step.argumentsJson || "{}"), null, 2); }
    catch { return String(step.argumentsJson || ""); }
  });
  let argsPreview = $derived(argsPretty.replace(/\s+/g, " ").trim());
</script>

<div class="step" class:open>
  <button class="head" onclick={() => open = !open}>
    <span class="arrow">▸</span>
    <span class="name">{step.name}</span>
    <span class="preview">{argsPreview}</span>
  </button>
  {#if open}
    <div class="body">
      <div class="label">arguments</div>
      <pre>{argsPretty}</pre>
      <div class="label">result</div>
      <pre class="result">{step.result ?? ""}</pre>
    </div>
  {/if}
</div>

<style>
  .step {
    margin: 6px 0; border: 1px solid #d6d6d6; border-radius: 4px;
    background: #f5f5f5;
    font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12px;
    overflow: hidden;
  }
  .head {
    width: 100%; display: flex; gap: 8px; align-items: center;
    padding: 4px 8px; cursor: pointer; color: #2a2a2a;
    background: transparent; border: 0; font: inherit; text-align: left;
  }
  .head:hover { background: #ebebeb; }
  .arrow { color: #707070; transition: transform 120ms cubic-bezier(0.16, 1, 0.3, 1); }
  .step.open .arrow { transform: rotate(90deg); }
  .name { color: #000; font-weight: 600; }
  .preview {
    color: #707070; flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .body { padding: 6px 8px; border-top: 1px solid #d6d6d6; }
  .label {
    color: #707070; text-transform: uppercase; letter-spacing: 0.06em;
    font-size: 10px; margin-bottom: 4px;
  }
  pre { margin: 0 0 8px; white-space: pre-wrap; color: #000; }
  pre.result {
    color: #2a2a2a; max-height: 220px; overflow: auto;
    background: #fff; padding: 6px 8px; border-radius: 4px; border: 1px solid #d6d6d6;
  }
</style>
