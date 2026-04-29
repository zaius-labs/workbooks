<script>
  import { onMount } from "svelte";
  import Notebook from "./components/Notebook.svelte";
  import Chat from "./components/Chat.svelte";
  import { notebook } from "./lib/notebook.svelte.js";
  import { env } from "./lib/env.svelte.js";

  // Boot — wire wasm + bundle into the notebook store, run starter
  // cells, then unblock the chat composer. We do this in an effect so
  // the UI can render the loading state without flicker.
  let bootError = $state(null);

  onMount(async () => {
    try { await notebook.init(); }
    catch (e) { bootError = e?.message ?? String(e); }
  });
</script>

<div class="page">
  <header>
    <span class="brand">workbook<span class="accent">/</span>notebook-agent</span>
    <span class="hint">— an agent that reads + writes the notebook below as it works.</span>
  </header>

  <div class="keyrow">
    <span class="hint">openrouter key</span>
    <input
      type="password"
      placeholder="sk-or-…"
      autocomplete="off"
      value={env.values.OPENROUTER_API_KEY ?? ""}
      oninput={(e) => env.set("OPENROUTER_API_KEY", e.currentTarget.value)}
    />
    <span class="keystate" class:set={env.satisfied} class:unset={!env.satisfied}>
      {env.satisfied ? "key set" : "no key"}
    </span>
  </div>

  {#if bootError}
    <div class="boot-error">boot failed: {bootError}</div>
  {/if}

  <Notebook />
  <Chat runtimeReady={notebook.ready} />
</div>

<style>
  :global(html, body) {
    margin: 0;
    background: #fff;
    color: #000;
    font-family: -apple-system, "SF Pro Text", "Inter", system-ui, sans-serif;
    line-height: 1.55;
  }
  .page {
    max-width: 980px; margin: 0 auto;
    padding: 24px 20px;
    display: grid; gap: 20px;
  }
  header { display: flex; gap: 12px; align-items: baseline; }
  .brand {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 13px; font-weight: 600; letter-spacing: 0.04em;
  }
  .accent { color: #2a2a2a; }
  .hint { font-size: 13px; color: #707070; }
  .keyrow {
    display: flex; gap: 12px; align-items: center;
    padding: 12px 16px;
    background: #f5f5f5; border: 1px solid #d6d6d6; border-radius: 4px;
  }
  .keyrow input {
    flex: 1; padding: 6px 10px;
    border: 1px solid #d6d6d6; border-radius: 4px;
    font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12px;
    background: #fff; color: #000;
  }
  .keyrow input:focus { outline: 1px solid #000; outline-offset: -1px; border-color: #000; }
  .keystate {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 12px; padding: 2px 8px;
    border-radius: 999px; border: 1px solid #d6d6d6;
  }
  .keystate.set   { color: #000;     border-color: #707070; background: #fff; }
  .keystate.unset { color: #707070;  border-color: #d6d6d6; background: #f5f5f5; }
  .boot-error {
    padding: 10px 14px;
    border: 2px solid #000; border-radius: 4px;
    color: #000; font-weight: 600; white-space: pre-wrap;
    font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 13px;
  }
</style>
