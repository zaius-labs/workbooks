<script lang="ts">
  /**
   * Empty-state prompt: "connect your OpenRouter key to start."
   */
  import type { ChatSession } from "./useChatSession.svelte";

  let { session }: { session: ChatSession } = $props();

  let keyInput = $state("");
  let showKey = $state(false);
</script>

<div class="key-prompt">
  <div class="title">Connect an API key</div>
  <div class="lede">
    The agent uses
    <a href="https://openrouter.ai" target="_blank" rel="noopener" class="link">OpenRouter</a>
    to reach 100+ models with one key. Your key stays in this browser
    (localStorage) — it's never sent anywhere except OpenRouter.
  </div>

  <form
    class="form"
    onsubmit={(e) => {
      e.preventDefault();
      if (keyInput.trim()) {
        session.setKey(keyInput.trim());
        keyInput = "";
      }
    }}
  >
    <div class="key-row">
      <input
        type={showKey ? "text" : "password"}
        bind:value={keyInput}
        placeholder="sk-or-v1-…"
        autocomplete="off"
        spellcheck="false"
        class="key-input"
      />
      <button
        type="button"
        onclick={() => (showKey = !showKey)}
        class="show-toggle"
      >{showKey ? "hide" : "show"}</button>
    </div>
    <button
      type="submit"
      disabled={!keyInput.trim()}
      class="connect-btn"
    >Connect</button>
  </form>

  <div class="hint">
    No account?
    <a href="https://openrouter.ai/keys" target="_blank" rel="noopener" class="link">
      Get a free key →
    </a>
  </div>
</div>

<style>
  .key-prompt {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    text-align: center;
    max-width: 26rem;
  }
  .title {
    font-size: 15px;
    font-weight: 600;
    color: var(--wb-chat-fg, #0a0a0a);
  }
  @media (prefers-color-scheme: dark) {
    .title { color: var(--wb-chat-fg, #f5f5f5); }
  }
  .lede {
    font-size: 12px;
    color: var(--wb-chat-fg-muted, #666);
    line-height: 1.55;
  }
  @media (prefers-color-scheme: dark) {
    .lede { color: var(--wb-chat-fg-muted, #a0a0a0); }
  }
  .link {
    color: inherit;
    text-decoration: underline;
  }
  .link:hover { color: var(--wb-chat-fg, #0a0a0a); }
  .form {
    margin-top: 8px;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .key-row {
    position: relative;
    width: 100%;
  }
  .key-input {
    width: 100%;
    border: 0;
    background: var(--wb-chat-bg, #ffffff);
    color: var(--wb-chat-fg, #0a0a0a);
    border-radius: 8px;
    padding: 9px 56px 9px 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    outline: none;
    box-sizing: border-box;
    box-shadow: 0 0 0 1px var(--wb-chat-border, rgba(0,0,0,0.06));
  }
  @media (prefers-color-scheme: dark) {
    .key-input {
      background: var(--wb-chat-bg, #0a0a0a);
      color: var(--wb-chat-fg, #f5f5f5);
      box-shadow: 0 0 0 1px var(--wb-chat-border, rgba(255,255,255,0.06));
    }
  }
  .key-input::placeholder { color: var(--wb-chat-fg-faint, #999); }
  .key-input:focus { box-shadow: 0 0 0 1.5px var(--wb-chat-fg-muted, #666); }
  .show-toggle {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    border: 0;
    background: transparent;
    color: var(--wb-chat-fg-muted, #666);
    font: inherit;
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
  }
  .show-toggle:hover { color: var(--wb-chat-fg, #0a0a0a); }
  .connect-btn {
    border: 0;
    background: var(--wb-chat-accent, #0a0a0a);
    color: var(--wb-chat-accent-fg, #ffffff);
    border-radius: 8px;
    padding: 9px 12px;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }
  @media (prefers-color-scheme: dark) {
    .connect-btn {
      background: var(--wb-chat-accent, #f5f5f5);
      color: var(--wb-chat-accent-fg, #0a0a0a);
    }
  }
  .connect-btn:hover:not(:disabled) { opacity: 0.9; }
  .connect-btn:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
  .hint {
    margin-top: 4px;
    font-size: 11px;
    color: var(--wb-chat-fg-faint, #999);
  }
</style>
