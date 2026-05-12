<script lang="ts">
  /**
   * High-level chat-app shell — wraps `useChatSession` + `ChatPanel` +
   * `ChatCanvas` in a customizable layout preset.
   *
   * Three presets, one component:
   *   - `split`   chat one side, canvas the other, draggable divider
   *   - `canvas`  canvas full-bleed, chat hidden behind a floating bubble
   *   - `rail`    multi-tab app rail (caller supplies a `rail` snippet)
   */
  import type { Snippet } from "svelte";
  import {
    useChatSession,
    type ChatSession,
    type ChatSessionOptions,
  } from "./useChatSession.svelte";
  import { builtins as defaultDropHandlers } from "./dropHandlers";
  import type { BlockRegistry } from "../blockRegistry";
  import ChatPanel from "./ChatPanel.svelte";
  import ChatCanvas from "./ChatCanvas.svelte";

  type Preset = "split" | "canvas" | "rail";
  type ChatPosition = "left" | "right" | "bottom";
  type CanvasMode = "inset" | "full-bleed";
  type ChatDefaultState = "expanded" | "collapsed" | "hidden";

  type Props = {
    systemPrompt?: string;
    tools?: ChatSessionOptions["tools"];
    dropHandlers?: ChatSessionOptions["dropHandlers"];
    defaultModel?: ChatSessionOptions["defaultModel"];
    storagePrefix?: ChatSessionOptions["storagePrefix"];
    llmClient?: ChatSessionOptions["llmClient"];
    maxIterations?: ChatSessionOptions["maxIterations"];
    session?: ChatSession;

    preset?: Preset;
    chatPosition?: ChatPosition;
    canvasMode?: CanvasMode;
    chatDefaultState?: ChatDefaultState;
    chatCollapsible?: boolean;
    chatHideable?: boolean;
    splitRatio?: number;
    resizable?: boolean;

    title?: string;
    showModelPicker?: boolean;
    blockRegistry?: BlockRegistry;
    models?: { id: string; label: string }[];

    canvas?: Snippet<[ChatSession]>;
    chatHeader?: Snippet<[ChatSession]>;
    chatComposer?: Snippet<[ChatSession]>;
    chatEmpty?: Snippet<[]>;
    rail?: Snippet<[ChatSession]>;
  };

  let {
    systemPrompt = "You are a helpful assistant embedded in a workbook.",
    tools,
    dropHandlers = defaultDropHandlers,
    defaultModel,
    storagePrefix,
    llmClient,
    maxIterations,
    session: externalSession,

    preset = "split",
    chatPosition = "left",
    // Default to full-bleed — vibe-coding layout. Authors who want
    // the inset card-on-card look opt into `canvasMode="inset"`.
    canvasMode = "full-bleed",
    chatDefaultState = "expanded",
    // Default OFF — the rail-collapse behavior is enough for vibe-
    // coding layouts; the floating-bubble pattern is a customer-
    // support widget aesthetic, not what coding tools want.
    chatHideable = false,
    chatCollapsible = true,
    splitRatio = 0.33,
    resizable = true,

    title,
    showModelPicker,
    blockRegistry,
    models,

    canvas,
    chatHeader,
    chatComposer,
    chatEmpty,
    rail,
  }: Props = $props();

  const session: ChatSession =
    externalSession ??
    useChatSession({
      systemPrompt,
      tools,
      dropHandlers,
      defaultModel,
      storagePrefix,
      llmClient,
      maxIterations,
    });

  let chatVisible = $state(chatDefaultState !== "hidden");
  let chatExpanded = $state(chatDefaultState !== "collapsed");

  function toggleCollapsed() {
    chatExpanded = !chatExpanded;
  }
  function toggleHidden() {
    chatVisible = !chatVisible;
    if (chatVisible) chatExpanded = true;
  }

  let ratio = $state(splitRatio);
  let dragging = $state(false);
  let containerEl = $state<HTMLElement | null>(null);

  function startResize() {
    if (!resizable) return;
    dragging = true;
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging || !containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    if (chatPosition === "bottom") {
      const fromTop = e.clientY - rect.top;
      let r = 1 - fromTop / rect.height;
      r = Math.max(0.15, Math.min(0.75, r));
      ratio = r;
    } else {
      const fromLeft = e.clientX - rect.left;
      let r =
        chatPosition === "left"
          ? fromLeft / rect.width
          : 1 - fromLeft / rect.width;
      r = Math.max(0.15, Math.min(0.75, r));
      ratio = r;
    }
  }
  function onPointerUp() {
    dragging = false;
  }

  $effect(() => {
    if (!dragging) return;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  });

  const chatTrackPercent = $derived(
    chatExpanded ? `${Math.round(ratio * 100)}%` : "44px",
  );
  const splitDirection = $derived(
    chatPosition === "bottom"
      ? "column"
      : chatPosition === "right"
        ? "row-reverse"
        : "row",
  );
</script>

{#if preset === "split"}
  <div
    bind:this={containerEl}
    class="root"
    class:inset={canvasMode === "inset"}
    style:flex-direction={splitDirection}
  >
    {#if chatVisible}
      <aside
        class="chat-side"
        style:flex={`0 0 ${chatTrackPercent}`}
      >
        {#if chatExpanded}
          <ChatPanel
            {session}
            {blockRegistry}
            {showModelPicker}
            {title}
            {models}
            onCollapse={chatCollapsible ? toggleCollapsed : undefined}
            header={chatHeader}
            composer={chatComposer}
            empty={chatEmpty}
          />
        {:else}
          <button
            type="button"
            onclick={toggleCollapsed}
            class="rail-collapsed"
            title="Expand chat"
            aria-label="Expand chat"
          >
            <!-- right-chevron-out-of-bar — mirror of the collapse icon -->
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path
                d="M7 4l4 4-4 4M3 3v10"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        {/if}
      </aside>

      {#if resizable && chatExpanded}
        <div
          role="separator"
          aria-orientation={chatPosition === "bottom" ? "horizontal" : "vertical"}
          tabindex="0"
          onpointerdown={startResize}
          class="divider"
          class:divider-h={chatPosition === "bottom"}
          class:divider-v={chatPosition !== "bottom"}
          class:dragging
        ></div>
      {/if}
    {/if}

    <main class="canvas-side">
      {#if canvas}
        {@render canvas(session)}
      {:else}
        <ChatCanvas {session} {blockRegistry} />
      {/if}
    </main>

    {#if !chatVisible}
      <button type="button" onclick={toggleHidden} class="summon-bubble" title="Show chat">💬</button>
    {/if}
  </div>
{:else if preset === "canvas"}
  <div class="root canvas-only">
    <main class="canvas-full">
      {#if canvas}
        {@render canvas(session)}
      {:else}
        <ChatCanvas {session} {blockRegistry} persistentDropTarget={false} />
      {/if}
    </main>

    {#if chatVisible}
      <aside class="canvas-overlay">
        <ChatPanel
          {session}
          {blockRegistry}
          {showModelPicker}
          {title}
          {models}
          header={chatHeader}
          composer={chatComposer}
          empty={chatEmpty}
        />
        <button type="button" onclick={toggleHidden} class="ctrl-btn ctrl-btn-overlay" title="Hide chat">×</button>
      </aside>
    {:else}
      <button type="button" onclick={toggleHidden} class="summon-bubble" title="Open chat">💬</button>
    {/if}
  </div>
{:else if preset === "rail"}
  <div class="root rail-mode">
    <aside class="rail-side">
      {#if rail}
        {@render rail(session)}
      {:else}
        <ChatPanel
          {session}
          {blockRegistry}
          {showModelPicker}
          {title}
          {models}
          header={chatHeader}
          composer={chatComposer}
          empty={chatEmpty}
        />
      {/if}
    </aside>
    <main class="rail-main">
      {#if canvas}
        {@render canvas(session)}
      {:else}
        <ChatCanvas {session} {blockRegistry} />
      {/if}
    </main>
  </div>
{/if}

<style>
  .root {
    position: relative;
    display: flex;
    height: 100%;
    width: 100%;
    overflow: hidden;
    background: var(--wb-chat-bg, #ffffff);
    /* Inset look ("inset" canvas mode) gets a soft outer padding +
     * gap so each pane reads as a card. Default is full-bleed —
     * vibe-coding aesthetic; panels touch and a thin divider
     * separates them. */
    padding: 0;
    gap: 0;
    box-sizing: border-box;
  }
  @media (prefers-color-scheme: dark) {
    .root { background: var(--wb-chat-bg, #0a0a0a); }
  }
  .root.inset {
    padding: 12px;
    gap: 12px;
  }

  .chat-side, .canvas-side {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  /* Default (full-bleed): chat-side reads as the recessed rail
   * (slightly darker / softer); canvas-side is the brighter primary
   * work surface. The hierarchy mirrors VSCode/Linear — sidebar
   * recedes, main area pops. */
  .chat-side {
    background: var(--wb-chat-surface, #f6f6f7);
  }
  .canvas-side {
    background: var(--wb-chat-bg, #ffffff);
    flex: 1 1 0;
  }
  @media (prefers-color-scheme: dark) {
    .chat-side {
      background: var(--wb-chat-surface, #131316);
    }
    .canvas-side {
      background: var(--wb-chat-bg, #0a0a0a);
    }
  }
  /* Inset look — both panels get the same surface tint + radius;
   * outer .root padding does the visual separation. */
  .root.inset .chat-side,
  .root.inset .canvas-side {
    border-radius: var(--wb-chat-radius, 10px);
    background: var(--wb-chat-surface, #fafafa);
  }
  @media (prefers-color-scheme: dark) {
    .root.inset .chat-side,
    .root.inset .canvas-side {
      background: var(--wb-chat-surface, #141414);
    }
  }

  .divider {
    flex-shrink: 0;
    background: transparent;
    transition: background 120ms ease;
  }
  .divider-v {
    width: 6px;
    cursor: col-resize;
  }
  .divider-h {
    height: 6px;
    cursor: row-resize;
  }
  .divider:hover, .divider.dragging {
    background: var(--wb-chat-border, #e5e5e5);
  }
  @media (prefers-color-scheme: dark) {
    .divider:hover, .divider.dragging {
      background: var(--wb-chat-border, #262626);
    }
  }

  .rail-collapsed {
    height: 100%;
    width: 100%;
    border: 0;
    background: transparent;
    color: var(--wb-chat-fg-muted, #666);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }
  .rail-collapsed:hover {
    color: var(--wb-chat-fg, #0a0a0a);
    background: var(--wb-chat-surface-soft, rgba(0, 0, 0, 0.04));
  }
  @media (prefers-color-scheme: dark) {
    .rail-collapsed:hover {
      color: var(--wb-chat-fg, #f5f5f5);
      background: var(--wb-chat-surface-soft, rgba(255, 255, 255, 0.04));
    }
  }

  /* canvas-overlay close button (canvas preset) */
  .ctrl-btn-overlay {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 30;
    width: 24px;
    height: 24px;
    border: 0;
    background: transparent;
    color: var(--wb-chat-fg-muted, #666);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    border-radius: 5px;
  }
  .ctrl-btn-overlay:hover {
    color: var(--wb-chat-fg, #0a0a0a);
    background: var(--wb-chat-surface-soft, rgba(0, 0, 0, 0.04));
  }
  @media (prefers-color-scheme: dark) {
    .ctrl-btn-overlay:hover {
      color: var(--wb-chat-fg, #f5f5f5);
      background: var(--wb-chat-surface-soft, rgba(255, 255, 255, 0.04));
    }
  }

  .summon-bubble {
    position: absolute;
    bottom: 16px;
    right: 16px;
    z-index: 10;
    width: 48px;
    height: 48px;
    border-radius: 999px;
    border: 1px solid var(--wb-chat-border, #e5e5e5);
    background: var(--wb-chat-bg, #ffffff);
    color: var(--wb-chat-fg, #0a0a0a);
    font-size: 20px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 120ms ease;
  }
  @media (prefers-color-scheme: dark) {
    .summon-bubble {
      border-color: var(--wb-chat-border, #262626);
      background: var(--wb-chat-bg, #0a0a0a);
      color: var(--wb-chat-fg, #f5f5f5);
    }
  }
  .summon-bubble:hover { transform: scale(1.05); }

  /* Canvas-only preset */
  .canvas-full {
    height: 100%;
    width: 100%;
  }
  .canvas-overlay {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    width: 400px;
    max-width: 88%;
    border-left: 1px solid var(--wb-chat-border, #e5e5e5);
    background: var(--wb-chat-bg, #ffffff);
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.15);
  }
  @media (prefers-color-scheme: dark) {
    .canvas-overlay {
      border-left-color: var(--wb-chat-border, #262626);
      background: var(--wb-chat-bg, #0a0a0a);
    }
  }

  /* Rail preset */
  .rail-side {
    display: flex;
    flex-direction: column;
    width: 320px;
    flex-shrink: 0;
    min-height: 0;
    overflow: hidden;
    border-right: 1px solid var(--wb-chat-border, #e5e5e5);
    background: var(--wb-chat-bg, #ffffff);
  }
  @media (prefers-color-scheme: dark) {
    .rail-side {
      border-right-color: var(--wb-chat-border, #262626);
      background: var(--wb-chat-bg, #0a0a0a);
    }
  }
  .rail-main {
    flex: 1 1 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
</style>
