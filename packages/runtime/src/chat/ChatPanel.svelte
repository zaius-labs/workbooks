<script lang="ts">
  /**
   * Chat panel — UI surface bound to a `useChatSession` instance.
   *
   * Renders thread items + a composer. Stateless beyond local UI state
   * (input value, scroll position). All conversation state lives on
   * the session.
   *
   * Styling: self-contained scoped Svelte styles using CSS custom
   * properties. Authors override the look by setting `--wb-chat-bg`,
   * `--wb-chat-fg`, etc. on a parent element. No external CSS
   * framework needed — the portable .html is genuinely portable.
   */
  import type { Snippet } from "svelte";
  import type { ChatSession } from "./useChatSession.svelte";
  import type { BlockRegistry } from "../blockRegistry";
  import { defaultBlockRegistry } from "../blockRegistry";
  import WorkbookBlockRender from "../WorkbookBlock.svelte";
  import { renderMarkdown } from "../markdown";
  import KeyPrompt from "./KeyPrompt.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import Composer from "./Composer.svelte";

  type Props = {
    session: ChatSession;
    blockRegistry?: BlockRegistry;
    showModelPicker?: boolean;
    title?: string;
    models?: { id: string; label: string }[];
    /** Optional callback — when provided, the header renders a
     *  collapse-to-rail button alongside the model picker. */
    onCollapse?: () => void;
    header?: Snippet<[ChatSession]>;
    composer?: Snippet<[ChatSession]>;
    empty?: Snippet<[]>;
    children?: Snippet<[]>;
  };

  let {
    session,
    blockRegistry = defaultBlockRegistry,
    showModelPicker = true,
    title = "Chat",
    models,
    onCollapse,
    header,
    composer,
    empty,
    children,
  }: Props = $props();

  let scrollEl = $state<HTMLElement | null>(null);

  $effect(() => {
    void session.thread.length;
    void session.busy;
    if (scrollEl) {
      requestAnimationFrame(() => {
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
      });
    }
  });

  function humanSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

<section class="chat-panel">
  {#if header}
    {@render header(session)}
  {:else}
    <header class="chat-header">
      <button
        type="button"
        class="header-btn"
        disabled={session.thread.length === 0 || session.busy}
        onclick={() => session.reset()}
        title="Start a fresh thread"
      >+ new</button>
      <div class="header-title">{title}</div>
      <div class="header-right">
        {#if showModelPicker}
          <ModelPicker {session} {models} />
        {/if}
        {#if onCollapse}
          <button
            type="button"
            class="header-icon-btn"
            onclick={onCollapse}
            title="Collapse to rail"
            aria-label="Collapse chat"
          >
            <!-- left-chevron-into-bar icon — communicates "tuck this away" -->
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M9 4l-4 4 4 4M13 3v10"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        {/if}
      </div>
    </header>
  {/if}

  <div bind:this={scrollEl} class="thread-scroll">
    {#if !session.hasKey}
      <div class="thread-center">
        <KeyPrompt {session} />
      </div>
    {:else if session.thread.length === 0}
      {#if empty}
        {@render empty()}
      {:else}
        <div class="thread-center thread-empty">
          Drop a file on the canvas, or ask the agent something.
        </div>
      {/if}
    {:else}
      <ol class="thread-list">
        {#each session.thread as item (item.id)}
          {#if item.kind === "user"}
            <li class="msg msg-user">
              {item.text}
              {#if item.attachments && item.attachments.length > 0}
                <div class="msg-meta">
                  {item.attachments.length} attachment{item.attachments.length === 1 ? "" : "s"}
                </div>
              {/if}
            </li>
          {:else if item.kind === "assistant"}
            <li class="msg msg-assistant">
              <div class="msg-prose">
                {@html renderMarkdown(item.text || "")}
              </div>
              {#if item.streaming}
                <span class="cursor"></span>
              {/if}
            </li>
          {:else if item.kind === "tool_call"}
            <li class="msg msg-tool">
              <details class="tool-card">
                <summary class="tool-summary">
                  <span class="tool-name">{item.toolName}</span>
                  {#if item.error}
                    <span class="status status-error">error</span>
                  {:else if item.result === undefined}
                    <span class="status status-running">running…</span>
                  {:else}
                    <span class="status status-done">done</span>
                  {/if}
                </summary>
                <div class="tool-body">
                  {#if item.argsJson && item.argsJson !== "{}"}
                    <pre class="pre">{item.argsJson}</pre>
                  {/if}
                  {#if item.error}
                    <pre class="pre pre-error">{item.error}</pre>
                  {:else if item.result !== undefined && item.result.length < 600}
                    <pre class="pre">{item.result}</pre>
                  {/if}
                </div>
              </details>
              {#if item.block}
                <div class="tool-block">
                  <WorkbookBlockRender block={item.block} registry={blockRegistry} />
                </div>
              {/if}
            </li>
          {:else if item.kind === "drop"}
            <li class="msg msg-drop">
              <span class="drop-icon">📎</span>
              <span class="drop-name">{item.filename}</span>
              <span class="drop-meta">
                · {item.mimeType || "?"} · {humanSize(item.size)}
              </span>
              {#if item.block}
                <span class="drop-block">→ {item.block.kind}</span>
              {/if}
            </li>
          {/if}
        {/each}
      </ol>
    {/if}
  </div>

  {#if session.lastError}
    <div class="error-bar">{session.lastError}</div>
  {/if}

  {@render children?.()}

  {#if composer}
    {@render composer(session)}
  {:else}
    <Composer {session} />
  {/if}
</section>

<style>
  .chat-panel {
    --_bg: var(--wb-chat-bg, #ffffff);
    --_surface: var(--wb-chat-surface, #fafafa);
    --_surface-soft: var(--wb-chat-surface-soft, #f0f0f0);
    --_fg: var(--wb-chat-fg, #0a0a0a);
    --_fg-muted: var(--wb-chat-fg-muted, #666);
    --_fg-faint: var(--wb-chat-fg-faint, #999);
    --_border: var(--wb-chat-border, rgba(0,0,0,0.08));
    --_accent: var(--wb-chat-accent, #0a0a0a);
    --_accent-fg: var(--wb-chat-accent-fg, #ffffff);
    --_error: var(--wb-chat-error, #ef4444);
    --_warning: var(--wb-chat-warning, #d97706);
    --_success: var(--wb-chat-success, #059669);
    --_radius: var(--wb-chat-radius, 8px);
    display: flex;
    flex: 1 1 0;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: transparent;
    color: var(--_fg);
    font-family: var(--wb-chat-font, ui-sans-serif, system-ui, -apple-system, sans-serif);
    font-size: 14px;
    line-height: 1.5;
  }
  @media (prefers-color-scheme: dark) {
    .chat-panel {
      --_bg: var(--wb-chat-bg, #0a0a0a);
      --_surface: var(--wb-chat-surface, #141414);
      --_surface-soft: var(--wb-chat-surface-soft, #1f1f1f);
      --_fg: var(--wb-chat-fg, #f5f5f5);
      --_fg-muted: var(--wb-chat-fg-muted, #a0a0a0);
      --_fg-faint: var(--wb-chat-fg-faint, #707070);
      --_border: var(--wb-chat-border, rgba(255,255,255,0.08));
      --_accent: var(--wb-chat-accent, #f5f5f5);
      --_accent-fg: var(--wb-chat-accent-fg, #0a0a0a);
    }
  }

  .chat-header {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 8px;
    height: 38px;
    flex-shrink: 0;
    padding: 0 8px 0 12px;
    border-bottom: 1px solid var(--_border);
  }
  .header-right {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    justify-self: end;
  }
  .header-icon-btn {
    width: 24px;
    height: 24px;
    border: 0;
    background: transparent;
    color: var(--_fg-muted);
    cursor: pointer;
    border-radius: 5px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .header-icon-btn:hover {
    color: var(--_fg);
    background: var(--_surface-soft);
  }
  .header-btn {
    border: 0;
    background: transparent;
    color: var(--_fg-muted);
    font: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
  }
  .header-btn:hover:not(:disabled) {
    color: var(--_fg);
    background: var(--_surface-soft);
  }
  .header-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .header-title {
    text-align: center;
    font-size: 13px;
    font-weight: 600;
    color: var(--_fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .thread-scroll {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }
  .thread-center {
    display: flex;
    height: 100%;
    align-items: center;
    justify-content: center;
    padding: 24px;
    text-align: center;
  }
  .thread-empty {
    color: var(--_fg-muted);
    font-size: 13px;
  }
  .thread-list {
    list-style: none;
    margin: 0;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  /* Messages */
  .msg {
    max-width: 92%;
    font-size: 13px;
    color: var(--_fg);
  }
  .msg-user {
    align-self: flex-end;
    max-width: 88%;
    background: var(--_surface-soft);
    border-radius: 16px;
    padding: 8px 12px;
  }
  .msg-meta {
    font-size: 11px;
    color: var(--_fg-muted);
    margin-top: 4px;
  }
  .msg-assistant .msg-prose :global(p) {
    margin: 0 0 8px;
  }
  .msg-assistant .msg-prose :global(p:last-child) {
    margin-bottom: 0;
  }
  .msg-assistant .msg-prose :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    background: var(--_surface-soft);
    padding: 1px 4px;
    border-radius: 3px;
  }
  .msg-assistant .msg-prose :global(pre) {
    background: var(--_surface-soft);
    border-radius: 6px;
    padding: 8px 12px;
    overflow-x: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    margin: 8px 0;
  }
  .msg-assistant .msg-prose :global(a) {
    color: var(--_fg);
    text-decoration: underline;
  }
  .cursor {
    display: inline-block;
    width: 6px;
    height: 12px;
    background: var(--_fg-muted);
    opacity: 0.6;
    margin-left: 2px;
    animation: blink 1s infinite;
    vertical-align: text-bottom;
  }
  @keyframes blink {
    0%, 50% { opacity: 0.6; }
    51%, 100% { opacity: 0; }
  }

  /* Tool cards */
  .msg-tool {
    font-size: 12px;
  }
  .tool-card {
    border-radius: 6px;
    background: var(--_surface-soft);
  }
  .tool-summary {
    cursor: pointer;
    user-select: none;
    padding: 6px 10px;
    color: var(--_fg-muted);
    list-style: none;
  }
  .tool-summary::-webkit-details-marker { display: none; }
  .tool-summary::before {
    content: "▸ ";
    color: var(--_fg-faint);
    margin-right: 2px;
  }
  details[open] .tool-summary::before {
    content: "▾ ";
  }
  .tool-name {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--_fg);
  }
  .status {
    margin-left: 8px;
    font-size: 11px;
    font-weight: 500;
  }
  .status-error { color: var(--_error); }
  .status-running { color: var(--_warning); }
  .status-done { color: var(--_success); }

  .tool-body {
    padding: 0 10px 8px 22px;
    color: var(--_fg-muted);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .pre {
    overflow-x: auto;
    background: var(--_surface);
    border-radius: 4px;
    padding: 6px 8px;
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    line-height: 1.4;
    color: var(--_fg);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .pre-error {
    background: rgba(239, 68, 68, 0.08);
    color: var(--_error);
  }
  .tool-block {
    margin-top: 8px;
  }

  .msg-drop {
    align-self: flex-end;
    max-width: 88%;
    background: var(--_surface-soft);
    border-radius: 16px;
    padding: 6px 12px;
    font-size: 12px;
    color: var(--_fg-muted);
  }
  .drop-name {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--_fg);
  }
  .drop-meta {
    color: var(--_fg-faint);
    font-size: 11px;
  }
  .drop-block {
    color: var(--_success);
    margin-left: 4px;
  }

  .error-bar {
    border-top: 1px solid rgba(239, 68, 68, 0.4);
    background: rgba(239, 68, 68, 0.08);
    color: var(--_error);
    font-size: 12px;
    padding: 8px 12px;
  }
</style>
