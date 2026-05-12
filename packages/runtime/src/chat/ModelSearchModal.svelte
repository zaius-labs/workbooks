<script lang="ts">
  /**
   * Searchable model picker modal. Cmd-K-style.
   *
   *   - Empty query → shows the curated "Recommended" set (a focused
   *     cross-section of labs most users reach for).
   *   - Any query → searches the full OpenRouter catalog (or the
   *     author-supplied `models` list when overridden), grouped by
   *     provider.
   *   - ↑/↓ navigate, Enter selects, Esc closes.
   *
   * Provider icons are derived favicons (Google's S2 service maps
   * `anthropic/...` → anthropic.com favicon). No icon-asset bundling.
   */
  import type { ChatSession } from "./useChatSession.svelte";
  import {
    openrouterCatalog,
    iconForModelId,
    RECOMMENDED_MODEL_IDS,
    type CatalogModel,
  } from "./openrouterCatalog.svelte";

  type Model = {
    id: string;
    label: string;
    provider?: string;
    iconUrl?: string | null;
  };

  type Props = {
    session: ChatSession;
    /** Author-supplied curated list. When set, that's what we filter
     *  through — no OpenRouter fetch. */
    models?: Model[];
    /** Whether the modal is currently open. Bindable. */
    open: boolean;
    /** Close-the-modal callback. */
    onClose: () => void;
  };

  let { session, models, open = $bindable(), onClose }: Props = $props();

  let query = $state("");
  let highlightIdx = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLElement | null>(null);

  /* Build the full model list. Author-supplied wins; otherwise use the
   * OpenRouter catalog. Each entry is augmented with iconUrl. */
  const allModels = $derived.by((): Model[] => {
    if (models) {
      return models.map((m) => ({
        ...m,
        provider: m.provider ?? m.id.split("/")[0],
        iconUrl: m.iconUrl ?? iconForModelId(m.id),
      }));
    }
    if (openrouterCatalog.models.length > 0) {
      return openrouterCatalog.models.map((m: CatalogModel) => ({
        id: m.id,
        label: m.name,
        provider: m.provider,
        iconUrl: m.iconUrl,
      }));
    }
    return [];
  });

  /* The recommended subset — anything in RECOMMENDED_MODEL_IDS that
   * actually exists in the active catalog. Order is the recommend
   * list's order, not the catalog's. */
  const recommended = $derived.by((): Model[] => {
    const byId = new Map(allModels.map((m) => [m.id, m]));
    const out: Model[] = [];
    for (const id of RECOMMENDED_MODEL_IDS) {
      const m = byId.get(id);
      if (m) out.push(m);
    }
    return out;
  });

  /* Search results when the user types. Substring match across both
   * id and label so "claude" and "anthropic" both find the same set. */
  const searchResults = $derived.by((): Model[] => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allModels.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.label.toLowerCase().includes(q),
    );
  });

  /** What the list actually shows — recommended when empty, search
   *  results otherwise. */
  const visible = $derived(query.trim() ? searchResults : recommended);

  /** Group search results by provider. Recommended stays as a flat list
   *  (the list order IS the curated order). */
  const grouped = $derived.by((): { provider: string; models: Model[] }[] => {
    if (!query.trim()) return [];
    const groups = new Map<string, Model[]>();
    for (const m of searchResults) {
      const p = m.provider ?? m.id.split("/")[0] ?? "other";
      const arr = groups.get(p) ?? [];
      arr.push(m);
      groups.set(p, arr);
    }
    return [...groups.entries()].map(([provider, models]) => ({ provider, models }));
  });

  $effect(() => {
    if (open) {
      query = "";
      highlightIdx = 0;
      void openrouterCatalog.ensure();
      requestAnimationFrame(() => inputEl?.focus());
    }
  });

  $effect(() => {
    if (highlightIdx >= visible.length) highlightIdx = Math.max(0, visible.length - 1);
  });

  function pick(id: string) {
    session.setModel(id);
    onClose();
  }

  function onKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      highlightIdx = Math.min(visible.length - 1, highlightIdx + 1);
      scrollHighlightIntoView();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlightIdx = Math.max(0, highlightIdx - 1);
      scrollHighlightIntoView();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = visible[highlightIdx];
      if (m) pick(m.id);
    }
  }

  function scrollHighlightIntoView() {
    requestAnimationFrame(() => {
      const el = listEl?.querySelector(`[data-idx="${highlightIdx}"]`);
      el?.scrollIntoView({ block: "nearest" });
    });
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div class="backdrop" onclick={onClose} role="presentation"></div>
  <div class="modal" role="dialog" aria-modal="true" aria-label="Choose a model">
    <div class="search-row">
      <svg class="search-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path d="M10.5 10.5l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
      <input
        bind:this={inputEl}
        bind:value={query}
        placeholder={openrouterCatalog.loading ? "Loading models…" : "Search models…"}
        class="search-input"
        autocomplete="off"
        spellcheck="false"
      />
      {#if openrouterCatalog.error && !models}
        <div class="catalog-status" title={openrouterCatalog.error}>offline</div>
      {/if}
    </div>

    <div bind:this={listEl} class="list">
      {#if allModels.length === 0}
        <div class="empty">
          {#if openrouterCatalog.loading}
            Fetching models from OpenRouter…
          {:else}
            No models available.
          {/if}
        </div>
      {:else if !query.trim()}
        <!-- Recommended view -->
        {#if recommended.length === 0}
          <div class="empty">No recommended models in this catalog yet.</div>
        {:else}
          <div class="group-label">Recommended</div>
          {#each recommended as m, idx (m.id)}
            <button
              type="button"
              data-idx={idx}
              class="model-row"
              class:active={idx === highlightIdx}
              class:selected={m.id === session.model}
              onmousemove={() => (highlightIdx = idx)}
              onclick={() => pick(m.id)}
            >
              {#if m.iconUrl}
                <img class="model-icon" src={m.iconUrl} alt="" loading="lazy" referrerpolicy="no-referrer" />
              {:else}
                <span class="model-icon model-icon-placeholder"></span>
              {/if}
              <div class="model-text">
                <span class="model-name">{m.label}</span>
                <span class="model-id">{m.id}</span>
              </div>
              {#if m.id === session.model}
                <span class="model-check">✓</span>
              {/if}
            </button>
          {/each}
          <div class="hint">Type to search the full catalog ({allModels.length} models)</div>
        {/if}
      {:else if grouped.length === 0}
        <div class="empty">No matches for "{query}"</div>
      {:else}
        <!-- Search view -->
        {#each grouped as group (group.provider)}
          <div class="group-label">{group.provider}</div>
          {#each group.models as m (m.id)}
            {@const idx = searchResults.indexOf(m)}
            <button
              type="button"
              data-idx={idx}
              class="model-row"
              class:active={idx === highlightIdx}
              class:selected={m.id === session.model}
              onmousemove={() => (highlightIdx = idx)}
              onclick={() => pick(m.id)}
            >
              {#if m.iconUrl}
                <img class="model-icon" src={m.iconUrl} alt="" loading="lazy" referrerpolicy="no-referrer" />
              {:else}
                <span class="model-icon model-icon-placeholder"></span>
              {/if}
              <div class="model-text">
                <span class="model-name">{m.label}</span>
                <span class="model-id">{m.id}</span>
              </div>
              {#if m.id === session.model}
                <span class="model-check">✓</span>
              {/if}
            </button>
          {/each}
        {/each}
      {/if}
    </div>

    <div class="footer">
      <span><kbd>↑↓</kbd> navigate</span>
      <span><kbd>↵</kbd> select</span>
      <span><kbd>esc</kbd> close</span>
      <span class="grow"></span>
      {#if query.trim()}
        <span class="count">{searchResults.length} of {allModels.length}</span>
      {:else}
        <span class="count">{recommended.length} recommended · {allModels.length} total</span>
      {/if}
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
    background: rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(4px);
  }
  .modal {
    position: fixed;
    z-index: 100;
    top: 12vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(560px, 92vw);
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--wb-chat-bg, #ffffff);
    border-radius: 12px;
    box-shadow:
      0 0 0 1px var(--wb-chat-border, rgba(0, 0, 0, 0.08)),
      0 24px 64px rgba(0, 0, 0, 0.2);
    color: var(--wb-chat-fg, #0a0a0a);
    font-family: var(--wb-chat-font, ui-sans-serif, system-ui, -apple-system, sans-serif);
  }
  @media (prefers-color-scheme: dark) {
    .modal {
      background: var(--wb-chat-bg, #141414);
      color: var(--wb-chat-fg, #f5f5f5);
      box-shadow:
        0 0 0 1px var(--wb-chat-border, rgba(255, 255, 255, 0.08)),
        0 24px 64px rgba(0, 0, 0, 0.6);
    }
  }

  .search-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 12px 4px 14px;
    border-bottom: 1px solid var(--wb-chat-border, rgba(0, 0, 0, 0.06));
  }
  @media (prefers-color-scheme: dark) {
    .search-row {
      border-bottom-color: var(--wb-chat-border, rgba(255, 255, 255, 0.06));
    }
  }
  .search-icon {
    color: var(--wb-chat-fg-faint, #999);
    flex-shrink: 0;
  }
  .search-input {
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 15px;
    padding: 12px 0;
  }
  .search-input::placeholder {
    color: var(--wb-chat-fg-faint, #999);
  }
  .catalog-status {
    font-size: 11px;
    color: var(--wb-chat-fg-faint, #999);
    padding: 0 4px;
  }

  .list {
    flex: 1;
    overflow-y: auto;
    padding: 4px;
  }

  .group-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--wb-chat-fg-faint, #999);
    padding: 12px 12px 4px;
    font-weight: 600;
  }

  .model-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    text-align: left;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    padding: 8px 10px;
    border-radius: 6px;
    cursor: pointer;
  }
  .model-row.active {
    background: var(--wb-chat-surface-soft, rgba(0, 0, 0, 0.04));
  }
  @media (prefers-color-scheme: dark) {
    .model-row.active {
      background: var(--wb-chat-surface-soft, rgba(255, 255, 255, 0.06));
    }
  }
  .model-icon {
    width: 18px;
    height: 18px;
    border-radius: 4px;
    object-fit: contain;
    flex-shrink: 0;
    background: var(--wb-chat-surface-soft, rgba(0, 0, 0, 0.04));
  }
  .model-icon-placeholder {
    background: var(--wb-chat-surface-soft, rgba(0, 0, 0, 0.04));
  }
  @media (prefers-color-scheme: dark) {
    .model-icon, .model-icon-placeholder {
      background: var(--wb-chat-surface-soft, rgba(255, 255, 255, 0.06));
    }
  }
  .model-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .model-name {
    font-size: 13.5px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .model-id {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    color: var(--wb-chat-fg-faint, #999);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .model-check {
    color: var(--wb-chat-success, #059669);
    font-size: 13px;
    flex-shrink: 0;
  }

  .empty {
    padding: 32px;
    text-align: center;
    font-size: 13px;
    color: var(--wb-chat-fg-muted, #666);
  }

  .hint {
    text-align: center;
    padding: 16px 12px 8px;
    font-size: 11px;
    color: var(--wb-chat-fg-faint, #999);
  }

  .footer {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    border-top: 1px solid var(--wb-chat-border, rgba(0, 0, 0, 0.06));
    font-size: 11px;
    color: var(--wb-chat-fg-faint, #999);
  }
  @media (prefers-color-scheme: dark) {
    .footer { border-top-color: var(--wb-chat-border, rgba(255, 255, 255, 0.06)); }
  }
  .footer kbd {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px;
    padding: 1px 5px;
    margin-right: 4px;
    border-radius: 3px;
    background: var(--wb-chat-surface-soft, rgba(0, 0, 0, 0.06));
    color: var(--wb-chat-fg-muted, #666);
  }
  @media (prefers-color-scheme: dark) {
    .footer kbd { background: var(--wb-chat-surface-soft, rgba(255, 255, 255, 0.06)); }
  }
  .grow { flex: 1; }
  .count { font-feature-settings: "tnum"; }
</style>
