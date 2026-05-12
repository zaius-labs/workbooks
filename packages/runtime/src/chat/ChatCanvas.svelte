<script lang="ts">
  /**
   * Canvas surface bound to a `useChatSession` — a vertical stack of
   * the blocks the agent has emitted, plus a drop zone for files the
   * user wants to feed to the agent.
   *
   * Empty state = the entire canvas IS the drop zone (full-bleed). As
   * soon as blocks land, the drop zone collapses to a thin strip at
   * the top so dragging more files in is still discoverable.
   */
  import type { Snippet } from "svelte";
  import type { ChatSession } from "./useChatSession.svelte";
  import type { WorkbookBlock } from "../types";
  import type { BlockRegistry } from "../blockRegistry";
  import { defaultBlockRegistry } from "../blockRegistry";
  import WorkbookBlockRender from "../WorkbookBlock.svelte";

  type Props = {
    session: ChatSession;
    blockRegistry?: BlockRegistry;
    persistentDropTarget?: boolean;
    onUnhandledDrop?: (file: File) => void;
    empty?: Snippet<[]>;
    block?: Snippet<[WorkbookBlock]>;
    children?: Snippet<[]>;
  };

  let {
    session,
    blockRegistry = defaultBlockRegistry,
    persistentDropTarget = true,
    onUnhandledDrop,
    empty,
    block,
    children,
  }: Props = $props();

  let isDragging = $state(false);

  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer) return;
    if (Array.from(e.dataTransfer.types).includes("Files")) {
      e.preventDefault();
      isDragging = true;
    }
  }
  function onDragLeave(e: DragEvent) {
    if (e.target !== e.currentTarget) return;
    isDragging = false;
  }
  async function onDrop(e: DragEvent) {
    e.preventDefault();
    isDragging = false;
    if (!e.dataTransfer) return;
    const files = Array.from(e.dataTransfer.files);
    for (const f of files) {
      try {
        await session.dropFile(f);
        onUnhandledDrop?.(f);
      } catch (err) {
        console.error("dropFile failed:", err);
      }
    }
  }
  async function onPickFiles(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    for (const f of files) await session.dropFile(f);
    input.value = "";
  }

  const blocks = $derived(session.canvasBlocks);
  const showFullDropZone = $derived(blocks.length === 0 && !children);
</script>

<div
  role="region"
  aria-label="Canvas"
  class="canvas"
  class:dragging={isDragging}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  {@render children?.()}

  {#if showFullDropZone}
    <label class="dropzone-full">
      <div class="dropzone-card" class:dropzone-card-dragging={isDragging}>
        {#if empty}
          {@render empty()}
        {:else}
          <span class="dropzone-title">Drop a file to start</span>
          <span class="dropzone-lede">
            CSVs become tables, JSON renders as a tree, images preview
            in place. The agent will see what you dropped and can run
            tools against it.
          </span>
          <span class="dropzone-hint">or click to pick from your computer</span>
        {/if}
      </div>
      <input type="file" multiple class="hidden-input" onchange={onPickFiles} />
    </label>
  {:else}
    <div class="block-scroll">
      <div class="block-list">
        {#each blocks as wbblock, i (i)}
          {#if block}
            {@render block(wbblock)}
          {:else}
            <WorkbookBlockRender block={wbblock} registry={blockRegistry} />
          {/if}
        {/each}
      </div>
    </div>

    {#if persistentDropTarget}
      <label class="drop-strip" class:drop-strip-dragging={isDragging}>
        <span>+ drop another file</span>
        <input type="file" multiple class="hidden-input" onchange={onPickFiles} />
      </label>
    {/if}
  {/if}

  {#if isDragging}
    <div class="drop-overlay">
      <span class="drop-pill">Release to drop</span>
    </div>
  {/if}
</div>

<style>
  .canvas {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    background: var(--wb-chat-bg, #ffffff);
    color: var(--wb-chat-fg, #0a0a0a);
    font-family: var(--wb-chat-font, ui-sans-serif, system-ui, -apple-system, sans-serif);
  }
  @media (prefers-color-scheme: dark) {
    .canvas {
      background: var(--wb-chat-bg, #0a0a0a);
      color: var(--wb-chat-fg, #f5f5f5);
    }
  }
  .canvas.dragging {
    box-shadow: inset 0 0 0 2px var(--wb-chat-success, #059669);
  }

  .dropzone-full {
    display: flex;
    flex-direction: column;
    height: 100%;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 24px;
    text-align: center;
    cursor: pointer;
  }
  .dropzone-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    border: 2px dashed var(--wb-chat-border, #e5e5e5);
    border-radius: 16px;
    padding: 48px 32px;
    transition: border-color 120ms ease, background 120ms ease;
    max-width: 28rem;
  }
  @media (prefers-color-scheme: dark) {
    .dropzone-card { border-color: var(--wb-chat-border, #262626); }
  }
  .dropzone-card-dragging {
    border-color: var(--wb-chat-success, #059669) !important;
    background: rgba(5, 150, 105, 0.05);
  }
  .dropzone-title {
    font-size: 16px;
    font-weight: 500;
    color: var(--wb-chat-fg, #0a0a0a);
  }
  @media (prefers-color-scheme: dark) {
    .dropzone-title { color: var(--wb-chat-fg, #f5f5f5); }
  }
  .dropzone-lede {
    font-size: 13px;
    color: var(--wb-chat-fg-muted, #666);
    line-height: 1.5;
  }
  @media (prefers-color-scheme: dark) {
    .dropzone-lede { color: var(--wb-chat-fg-muted, #a0a0a0); }
  }
  .dropzone-hint {
    margin-top: 8px;
    font-size: 11px;
    color: var(--wb-chat-fg-faint, #999);
  }

  .hidden-input {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .block-scroll {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }
  .block-list {
    margin: 0 auto;
    max-width: 48rem;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 24px 16px;
  }

  .drop-strip {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    flex-shrink: 0;
    cursor: pointer;
    border-top: 1px dashed var(--wb-chat-border, #e5e5e5);
    padding: 8px 12px;
    font-size: 11px;
    color: var(--wb-chat-fg-muted, #666);
    transition: background 120ms ease;
  }
  @media (prefers-color-scheme: dark) {
    .drop-strip { border-top-color: var(--wb-chat-border, #262626); }
  }
  .drop-strip:hover { background: var(--wb-chat-surface-soft, #f3f3f3); }
  @media (prefers-color-scheme: dark) {
    .drop-strip:hover { background: var(--wb-chat-surface-soft, #1c1c1c); }
  }
  .drop-strip-dragging {
    background: rgba(5, 150, 105, 0.05);
  }

  .drop-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    background: rgba(5, 150, 105, 0.1);
    backdrop-filter: blur(2px);
  }
  .drop-pill {
    background: var(--wb-chat-success, #059669);
    color: #ffffff;
    padding: 6px 16px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 500;
  }
</style>
