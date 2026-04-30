<script>
  import { env, MODEL_PRESETS } from "../lib/env.svelte.js";
  import { settingsSections } from "../lib/pluginApi.svelte.js";

  let { open = $bindable(false) } = $props();

  let dialogEl;
  let revealKey = $state(false);

  $effect(() => {
    if (!dialogEl) return;
    if (open && !dialogEl.open) dialogEl.showModal();
    if (!open && dialogEl.open) dialogEl.close();
  });

  function close() { open = false; }
  function onKeydown(e) { if (e.key === "Escape") close(); }

  function openOpenRouterKeysPage() {
    window.open("https://openrouter.ai/keys", "_blank", "noopener,noreferrer");
  }
</script>

<dialog
  bind:this={dialogEl}
  onclose={close}
  onkeydown={onKeydown}
  class="bg-surface text-fg rounded-lg border border-border shadow-2xl
         backdrop:bg-black/60 backdrop:backdrop-blur-sm
         w-[min(480px,calc(100vw-32px))] p-0"
>
  <div class="flex items-baseline justify-between px-5 py-3 border-b border-border">
    <h3 class="font-mono text-[12px] uppercase tracking-wider text-fg-muted m-0 font-semibold">
      ai settings
    </h3>
    <button
      onclick={close}
      class="text-fg-muted hover:text-fg cursor-pointer text-base leading-none bg-transparent border-0 p-1"
      aria-label="Close"
    >×</button>
  </div>

  <div class="p-5 space-y-5">
    <!-- OpenRouter API key -->
    <div class="space-y-1.5">
      <label for="hf-or-key" class="block font-mono text-[11px] uppercase tracking-wider text-fg-muted">
        openrouter api key
      </label>
      <div class="flex gap-2">
        <input
          id="hf-or-key"
          type={revealKey ? "text" : "password"}
          placeholder="sk-or-…"
          autocomplete="off"
          spellcheck="false"
          value={env.values.OPENROUTER_API_KEY ?? ""}
          oninput={(e) => env.set("OPENROUTER_API_KEY", e.currentTarget.value)}
          class="flex-1 bg-page border border-border rounded px-3 py-2 font-mono text-[12px] text-fg
                 focus:outline-1 focus:outline-accent focus:border-accent"
        />
        <button
          onclick={() => revealKey = !revealKey}
          class="px-3 rounded border border-border bg-page text-fg-muted hover:text-fg hover:border-border-2 cursor-pointer font-mono text-[11px]"
          title={revealKey ? "Hide" : "Show"}
        >{revealKey ? "hide" : "show"}</button>
      </div>
      <div class="flex items-center justify-between gap-2">
        <button
          onclick={openOpenRouterKeysPage}
          class="font-mono text-[11px] text-fg-muted hover:text-fg cursor-pointer underline underline-offset-2"
        >Open openrouter.ai/keys ↗</button>
        <span class="font-mono text-[10px] text-fg-faint">
          Stored locally · sent only to OpenRouter.
        </span>
      </div>
    </div>

    <!-- Model — free-text with preset suggestions via <datalist>. -->
    <div class="space-y-1.5">
      <label for="hf-model" class="block font-mono text-[11px] uppercase tracking-wider text-fg-muted">
        model
      </label>
      <input
        id="hf-model"
        type="text"
        list="hf-model-presets"
        placeholder="anthropic/claude-haiku-4.5"
        spellcheck="false"
        autocomplete="off"
        value={env.model}
        oninput={(e) => env.setModel(e.currentTarget.value)}
        class="w-full bg-page border border-border rounded px-3 py-2 font-mono text-[12px] text-fg
               focus:outline-1 focus:outline-accent focus:border-accent"
      />
      <datalist id="hf-model-presets">
        {#each MODEL_PRESETS as m}
          <option value={m.id}>{m.label}</option>
        {/each}
      </datalist>
      <span class="font-mono text-[10px] text-fg-faint">
        Any OpenRouter model id works · see openrouter.ai/models for the full list.
      </span>
    </div>

    {#each settingsSections as section (section.pluginId + ":" + section.label)}
      <div class="pt-2 border-t border-border">
        <h3 class="font-mono text-[10px] uppercase tracking-wider text-fg-muted mb-2">
          {section.label}
          <span class="text-fg-faint">· plugin · {section.pluginId}</span>
        </h3>
        <section.component />
      </div>
    {/each}

    <div class="flex items-center justify-between pt-2 border-t border-border">
      <span class="font-mono text-[11px]"
            class:text-accent={env.satisfied}
            class:text-fg-faint={!env.satisfied}>
        {env.satisfied ? "● connected" : "○ no key"}
      </span>
      <button
        onclick={close}
        class="px-3 py-1.5 rounded border border-accent bg-accent text-accent-fg font-mono text-[12px] font-semibold hover:opacity-90 cursor-pointer"
      >done</button>
    </div>
  </div>
</dialog>

<style>
  dialog { margin: auto; max-height: calc(100vh - 32px); overflow: visible; }
  dialog:not([open]) { display: none !important; }
</style>
