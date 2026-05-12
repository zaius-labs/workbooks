<script lang="ts">
  /**
   * Composer — textarea + send button bound to a `useChatSession`.
   *
   * Auto-resizes within a sensible range. ⌘/Ctrl+Enter sends. Enter
   * alone inserts a newline (matches Slack/Discord/most chat UX).
   */
  import type { ChatSession } from "./useChatSession.svelte";

  let { session }: { session: ChatSession } = $props();

  let input = $state("");
  let textareaEl = $state<HTMLTextAreaElement | null>(null);

  function autoresize() {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    textareaEl.style.height =
      Math.max(40, Math.min(textareaEl.scrollHeight, 240)) + "px";
  }

  $effect(() => {
    void input;
    autoresize();
  });

  async function send() {
    if (!input.trim() || session.busy) return;
    const text = input;
    input = "";
    await session.send(text);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  }

  const disabled = $derived(!session.hasKey);
</script>

<form
  class="composer"
  onsubmit={(e) => {
    e.preventDefault();
    void send();
  }}
>
  <textarea
    bind:this={textareaEl}
    bind:value={input}
    onkeydown={onKeydown}
    placeholder={disabled ? "Connect an API key to start" : "Ask anything…"}
    {disabled}
    rows="1"
    class="composer-input"
  ></textarea>
  {#if session.busy}
    <button
      type="button"
      onclick={() => session.abort()}
      class="composer-btn composer-btn-stop"
      title="Abort the in-flight turn"
    >stop</button>
  {:else}
    <button
      type="submit"
      disabled={disabled || !input.trim()}
      class="composer-btn composer-btn-send"
    >send</button>
  {/if}
</form>

<style>
  .composer {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    flex-shrink: 0;
    padding: 8px;
    background: transparent;
  }
  .composer-input {
    flex: 1;
    min-height: 40px;
    max-height: 240px;
    resize: none;
    border: 0;
    background: var(--wb-chat-bg, #ffffff);
    color: var(--wb-chat-fg, #0a0a0a);
    border-radius: 8px;
    padding: 9px 12px;
    font: inherit;
    font-size: 13px;
    line-height: 1.5;
    outline: none;
    box-shadow: 0 0 0 1px var(--wb-chat-border, rgba(0,0,0,0.06));
    transition: box-shadow 120ms ease;
  }
  @media (prefers-color-scheme: dark) {
    .composer-input {
      background: var(--wb-chat-bg, #0a0a0a);
      color: var(--wb-chat-fg, #f5f5f5);
      box-shadow: 0 0 0 1px var(--wb-chat-border, rgba(255,255,255,0.06));
    }
  }
  .composer-input::placeholder {
    color: var(--wb-chat-fg-faint, #999);
  }
  .composer-input:focus {
    box-shadow: 0 0 0 1.5px var(--wb-chat-fg-muted, #666);
  }
  .composer-input:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .composer-btn {
    border: 0;
    border-radius: 8px;
    padding: 9px 14px;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }
  .composer-btn-send {
    background: var(--wb-chat-accent, #0a0a0a);
    color: var(--wb-chat-accent-fg, #ffffff);
  }
  @media (prefers-color-scheme: dark) {
    .composer-btn-send {
      background: var(--wb-chat-accent, #f5f5f5);
      color: var(--wb-chat-accent-fg, #0a0a0a);
    }
  }
  .composer-btn-send:hover:not(:disabled) { opacity: 0.9; }
  .composer-btn-send:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
  .composer-btn-stop {
    background: rgba(239, 68, 68, 0.1);
    color: var(--wb-chat-error, #ef4444);
  }
  .composer-btn-stop:hover { background: rgba(239, 68, 68, 0.18); }
</style>
