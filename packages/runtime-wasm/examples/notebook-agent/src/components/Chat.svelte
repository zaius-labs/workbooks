<script>
  import { onMount } from "svelte";
  import ToolStep from "./ToolStep.svelte";
  import { agent } from "../lib/agent.svelte.js";
  import { env } from "../lib/env.svelte.js";

  let { runtimeReady = false } = $props();

  let input = $state("");
  let textareaEl;
  let scrollEl;

  const EXAMPLES = [
    "what cells are in the notebook?",
    "read by_region and tell me which region has lowest churn",
    "append a polars cell that returns rows where churn > 0.10",
    "edit the doubled cell to compute n * 3 + 1 instead",
  ];

  // markdown renderer pulled from the runtime bundle on first use
  let renderMarkdown = $state((s) => escapeHtml(String(s ?? "")));
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;"
        : c === '"' ? "&quot;" : "&#39;");
  }
  onMount(async () => {
    const { loadRuntime } = await import("virtual:workbook-runtime");
    const { bundle } = await loadRuntime();
    if (bundle.renderMarkdown) renderMarkdown = bundle.renderMarkdown;
  });

  async function send() {
    if (!input.trim()) return;
    const text = input;
    input = "";
    autoresize();
    await agent.send(text);
    requestAnimationFrame(scrollToBottom);
  }

  function autoresize() {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    textareaEl.style.height = Math.min(textareaEl.scrollHeight, 200) + "px";
  }
  function onKeydown(e) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  }
  function scrollToBottom() {
    if (!scrollEl) return;
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  // Auto-scroll on every streaming update.
  $effect(() => {
    void agent.streaming;
    void agent.thread;
    requestAnimationFrame(scrollToBottom);
  });
</script>

<div class="panel">
  <div class="head">
    <strong>agent</strong>
    <span class="hint">tools: list_cells / read_cell / append_cell / edit_cell / query_data</span>
  </div>
  <div class="body">
    <div class="thread" bind:this={scrollEl}>
      {#each agent.thread as turn, i (i)}
        <div class="turn {turn.role}">
          <div class="meta">{turn.role === "user" ? "you" : "agent"}</div>
          {#each turn.segments as seg, j (j)}
            {#if seg.kind === "text" && seg.text}
              <div class="text">{@html renderMarkdown(seg.text)}</div>
            {:else if seg.kind === "tool"}
              <ToolStep step={seg} />
            {/if}
          {/each}
        </div>
      {/each}
      {#if agent.streaming}
        <div class="turn assistant">
          <div class="meta">agent</div>
          {#each agent.streaming.segments as seg, j (j)}
            {#if seg.kind === "text" && seg.text}
              <div class="text">{@html renderMarkdown(seg.text)}</div>
            {:else if seg.kind === "tool"}
              <ToolStep step={seg} />
            {/if}
          {/each}
        </div>
      {/if}
    </div>

    <div class="compose">
      <textarea
        bind:this={textareaEl}
        bind:value={input}
        oninput={autoresize}
        onkeydown={onKeydown}
        rows="1"
        placeholder={runtimeReady ? "ask the agent to add or change a cell…" : "loading runtime…"}
        disabled={!runtimeReady || !env.satisfied}
      ></textarea>
      <button onclick={send} disabled={!runtimeReady || agent.busy || !env.satisfied}>
        {agent.busy ? "…" : "send"}
      </button>
    </div>

    <div class="examples">
      {#each EXAMPLES as ex}
        <button onclick={() => { input = ex; textareaEl?.focus(); autoresize(); }}>
          {ex}
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .panel { border: 1px solid #d6d6d6; border-radius: 4px; background: #fff; }
  .head {
    padding: 12px 16px; border-bottom: 1px solid #d6d6d6;
    display: flex; align-items: baseline; gap: 12px;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 12px; color: #707070;
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .head strong { color: #000; font-weight: 600; }
  .hint { text-transform: none; letter-spacing: 0; color: #707070; }
  .body { padding: 16px; display: grid; gap: 12px; }
  .thread { display: grid; gap: 12px; max-height: 480px; overflow-y: auto; }
  .turn { display: grid; gap: 4px; }
  .meta {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 12px; color: #707070;
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .turn.user .meta { color: #2a2a2a; }
  .turn.assistant .meta { color: #000; font-weight: 600; }
  .text { line-height: 1.55; font-size: 15px; color: #000; }
  .text :global(p) { margin: 0 0 8px; }
  .text :global(p:last-child) { margin-bottom: 0; }
  .text :global(code) {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 0.92em; background: #f5f5f5;
    padding: 1px 5px; border: 1px solid #d6d6d6; border-radius: 3px;
  }
  .text :global(pre) {
    margin: 8px 0; padding: 8px 10px;
    background: #f5f5f5; border: 1px solid #d6d6d6; border-radius: 4px;
    font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 13px;
    overflow: auto;
  }
  .text :global(pre code) { background: transparent; border: 0; padding: 0; }
  .text :global(strong) { font-weight: 600; }
  .text :global(em) { font-style: italic; }
  .text :global(ul), .text :global(ol) { margin: 0 0 8px; padding-left: 22px; }

  .compose {
    display: flex; gap: 8px; align-items: end;
    padding-top: 12px; border-top: 1px solid #d6d6d6;
    margin-top: 4px;
  }
  .compose textarea {
    flex: 1; min-height: 36px; max-height: 200px; resize: none;
    padding: 8px 10px;
    border: 1px solid #d6d6d6; border-radius: 4px;
    font-family: -apple-system, "SF Pro Text", "Inter", system-ui, sans-serif;
    font-size: 15px; background: #fff; color: #000;
  }
  .compose textarea:focus { outline: 1px solid #000; outline-offset: -1px; border-color: #000; }
  .compose textarea:disabled { background: #f5f5f5; color: #a8a8a8; }
  .compose button {
    padding: 8px 14px;
    border: 1px solid #000; border-radius: 4px;
    background: #000; color: #fff; cursor: pointer;
    font-size: 13px;
  }
  .compose button:hover:not(:disabled) { background: #2a2a2a; border-color: #2a2a2a; }
  .compose button:disabled { opacity: 0.5; cursor: not-allowed; }

  .examples { display: flex; flex-wrap: wrap; gap: 6px; }
  .examples button {
    background: transparent; color: #2a2a2a; border: 1px solid #d6d6d6;
    border-radius: 999px; padding: 3px 10px;
    font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12px;
    cursor: pointer;
  }
  .examples button:hover { background: #f5f5f5; color: #000; border-color: #707070; }
</style>
