<script>
  import { onMount, onDestroy } from "svelte";
  import ToolStep from "./ToolStep.svelte";
  import { agent } from "../lib/agent.svelte.js";
  import { env } from "../lib/env.svelte.js";
  import {
    chatInputActions,
    chatSendHooks,
    registerChatController,
  } from "../lib/pluginApi.svelte.js";

  let input = $state("");
  let textareaEl;
  let scrollEl;

  // Register a controller so plugins can drive the input + read
  // thread state via wb.chat.setInput / .getInput / .getThread.
  // Cleared on unmount.
  const unregister = registerChatController({
    setInput: (t) => { input = t; queueMicrotask(autoresize); },
    getInput: () => input,
    getThread: () => agent.thread,
  });
  onDestroy(unregister);

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
    let text = input;

    // Plugins can transform (or veto) the message before send via
    // wb.chat.onSend(fn). Hooks run in registration order; if any
    // returns null/false, the send is aborted (the user keeps their
    // text in the input).
    for (const hook of chatSendHooks) {
      try {
        const r = await hook.fn(text);
        if (r === null || r === false) return;
        if (typeof r === "string") text = r;
      } catch (e) {
        console.warn(`chat onSend hook from ${hook.pluginId} threw:`, e);
      }
    }

    input = "";
    autoresize();
    await agent.send(text);
    requestAnimationFrame(scrollToBottom);
  }

  function runInputAction(action) {
    try {
      const r = action.onClick();
      if (r && typeof r.then === "function") {
        r.catch((e) => console.warn(`chat input action ${action.pluginId}:`, e));
      }
    } catch (e) {
      console.warn(`chat input action ${action.pluginId}:`, e);
    }
  }

  function autoresize() {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    textareaEl.style.height = Math.max(80, Math.min(textareaEl.scrollHeight, 280)) + "px";
  }
  function onKeydown(e) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  }
  function scrollToBottom() {
    if (!scrollEl) return;
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  $effect(() => {
    void agent.streaming;
    void agent.thread;
    requestAnimationFrame(scrollToBottom);
  });
</script>

<section class="flex flex-col min-h-0 flex-1">
  <div bind:this={scrollEl} class="flex-1 overflow-y-auto px-4 py-4 space-y-3 relative">
    {#if agent.thread.length > 0 && !agent.busy}
      <button
        onclick={() => agent.clearThread()}
        class="absolute top-2 right-3 z-10 px-2 py-0.5 rounded font-mono text-[10px] text-fg-faint hover:text-fg cursor-pointer"
        title="Start a fresh thread (clears chat history; the composition + assets stay)"
      >+ new thread</button>
    {/if}

    {#if !agent.thread.length && !agent.streaming}
      <div class="text-fg-muted text-sm px-1">
        Ask the agent to redesign, retime, or add a scene. The player rebuilds on every change.
      </div>
    {/if}

    {#each agent.thread as turn, i (i)}
      {#if turn.role === "user"}
        <!-- User turn: subtle bubble that visually punctuates the
             thread between agent responses. Lives flush-right inside
             the column to evoke the "your message" affordance from
             other chat UIs without sacrificing readable line width. -->
        <div class="user-turn rounded-lg border border-border bg-surface px-3.5 py-2.5">
          <div class="text-[10px] uppercase tracking-wider mb-1 font-mono text-fg-faint">you</div>
          {#each turn.segments as seg, j (j)}
            {#if seg.kind === "text" && seg.text}
              <div class="text-sm text-fg whitespace-pre-wrap leading-relaxed">{seg.text}</div>
            {/if}
          {/each}
        </div>
      {:else}
        <!-- Agent turn: flat, full-width, supports tool steps and
             markdown text. The accent label anchors the role. -->
        <div class="agent-turn space-y-2 px-1">
          <div class="text-[10px] uppercase tracking-wider font-mono text-accent">agent</div>
          {#each turn.segments as seg, j (j)}
            {#if seg.kind === "text" && seg.text}
              <div class="prose-text text-sm leading-relaxed text-fg">
                {@html renderMarkdown(seg.text)}
              </div>
            {:else if seg.kind === "tool"}
              <ToolStep step={seg} />
            {/if}
          {/each}
        </div>
      {/if}
    {/each}

    {#if agent.streaming}
      <div class="agent-turn space-y-2 px-1">
        <div class="text-[10px] uppercase tracking-wider font-mono text-accent flex items-center gap-2">
          agent
          <span class="dot" aria-hidden="true"></span>
        </div>
        {#each agent.streaming.segments as seg, j (j)}
          {#if seg.kind === "text" && seg.text}
            <div class="prose-text text-sm leading-relaxed text-fg">
              {@html renderMarkdown(seg.text)}
            </div>
          {:else if seg.kind === "tool"}
            <ToolStep step={seg} />
          {/if}
        {/each}
      </div>
    {/if}
  </div>

  <div class="border-t border-border px-4 py-3">
    <div
      class="composer relative rounded-xl border border-border bg-surface
             focus-within:border-accent focus-within:ring-1 focus-within:ring-accent
             transition-colors"
      class:disabled={!env.satisfied}
    >
      <textarea
        bind:this={textareaEl}
        bind:value={input}
        oninput={autoresize}
        onkeydown={onKeydown}
        rows="1"
        placeholder={env.satisfied ? "Ask the agent to build, retime, or restyle a scene… (⌘↩ to send)" : "Click the gear icon to connect a provider"}
        disabled={!env.satisfied}
        class="w-full resize-none min-h-[80px] max-h-[280px] px-3.5 pt-3 pb-12
               bg-transparent text-fg text-sm font-sans leading-relaxed
               focus:outline-none disabled:text-fg-muted placeholder:text-fg-faint"
      ></textarea>

      <!-- Plugin-registered chat input actions — bottom-left of the
           composer. Plugins push entries via wb.chat.addInputAction;
           teardown removes them. -->
      {#if chatInputActions.length > 0}
        <div class="absolute left-2 bottom-2 flex gap-1">
          {#each chatInputActions as action (action.pluginId + ":" + action.label)}
            <button
              type="button"
              onclick={() => runInputAction(action)}
              title={action.label + (action.shortcut ? ` (${action.shortcut})` : "")}
              aria-label={action.label}
              class="h-8 min-w-8 px-2 rounded-lg flex items-center justify-center
                     border border-border bg-surface text-fg-muted cursor-pointer
                     hover:text-fg hover:border-border-2 active:scale-95 transition
                     font-mono text-[11px]"
            >
              {#if action.icon}<span>{action.icon}</span>{/if}
            </button>
          {/each}
        </div>
      {/if}

      <!-- Send button overlaid in the bottom-right of the composer. -->
      <button
        onclick={send}
        disabled={agent.busy || !env.satisfied || !input.trim()}
        title="Send (⌘↩)"
        aria-label={agent.busy ? "Sending" : "Send"}
        class="absolute right-2 bottom-2 h-8 w-8 rounded-lg flex items-center justify-center
               border border-accent bg-accent text-accent-fg cursor-pointer
               hover:opacity-90 active:scale-95 transition
               disabled:opacity-40 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:border-border disabled:text-fg-muted"
      >
        {#if agent.busy}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
            <circle cx="7" cy="7" r="5" opacity="0.25"/>
            <path d="M12 7a5 5 0 0 0-5-5" class="spin"/>
          </svg>
        {:else}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M7 11.5V2.5"/>
            <path d="M3 6.5L7 2.5L11 6.5"/>
          </svg>
        {/if}
      </button>
    </div>
  </div>
</section>

<style>
  .prose-text :global(p) { margin: 0 0 8px; }
  .prose-text :global(p:last-child) { margin-bottom: 0; }
  .prose-text :global(code) {
    font-family: var(--font-mono); font-size: 0.92em;
    background: var(--color-surface-2); border: 1px solid var(--color-border);
    border-radius: 3px; padding: 1px 5px;
  }
  .prose-text :global(pre) {
    margin: 8px 0; padding: 8px 10px;
    background: var(--color-surface-2); border: 1px solid var(--color-border);
    border-radius: 4px; overflow: auto;
    font-family: var(--font-mono); font-size: 12px;
  }
  .prose-text :global(pre code) { background: transparent; border: 0; padding: 0; }
  .prose-text :global(ul), .prose-text :global(ol) { margin: 0 0 8px; padding-left: 22px; }

  .composer.disabled { background: var(--color-surface-2); }
  .composer textarea { display: block; }
  .spin {
    transform-origin: 7px 7px;
    animation: composer-spin 0.8s linear infinite;
  }
  @keyframes composer-spin {
    to { transform: rotate(360deg); }
  }

  /* Streaming indicator next to "agent" while a reply is in-flight. */
  .dot {
    width: 6px; height: 6px; border-radius: 999px;
    background: var(--color-accent);
    animation: chat-pulse 1.2s ease-in-out infinite;
  }
  @keyframes chat-pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.35; }
  }

  /* Smooth scroll-into-view + a tiny entrance for the user bubble so
   * follow-ups feel like they snap in instead of jumping. */
  .user-turn { animation: bubble-in 200ms ease-out; }
  @keyframes bubble-in {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: none; }
  }
</style>
