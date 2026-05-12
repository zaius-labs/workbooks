<script lang="ts">
  /**
   * Model picker — button-style trigger that opens a searchable modal.
   *
   * Replaces the cramped native `<select>` with a Cmd-K-style popup so
   * users can scan + filter through all available models. The OpenRouter
   * catalog (200+ models) is pulled lazily and cached for 24h; offline /
   * curated lists work too via the `models` prop.
   */
  import type { ChatSession } from "./useChatSession.svelte";
  import { openrouterCatalog } from "./openrouterCatalog.svelte";
  import ModelSearchModal from "./ModelSearchModal.svelte";

  type Model = { id: string; label: string };

  type Props = {
    session: ChatSession;
    models?: Model[];
  };

  const STARTER_MODELS: Model[] = [
    { id: "openai/gpt-4o-mini", label: "GPT-4o mini" },
    { id: "openai/gpt-4o", label: "GPT-4o" },
    { id: "anthropic/claude-3.5-haiku", label: "Claude 3.5 Haiku" },
    { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
    { id: "google/gemini-2.0-flash-001", label: "Gemini 2.0 Flash" },
    { id: "deepseek/deepseek-chat", label: "DeepSeek V3" },
  ];

  let { session, models }: Props = $props();

  let modalOpen = $state(false);

  /* Trigger label — show the active model's friendly name when we have
   * it, otherwise fall back to the raw id. Truncated at the CSS layer. */
  const activeName = $derived.by((): string => {
    if (models) {
      return models.find((m) => m.id === session.model)?.label ?? session.model;
    }
    const fromCatalog = openrouterCatalog.get(session.model);
    if (fromCatalog) return fromCatalog.name;
    const starter = STARTER_MODELS.find((m) => m.id === session.model);
    if (starter) return starter.label;
    return session.model;
  });

  /* The modal needs the curated list when authors override; otherwise
   * it pulls from the live catalog itself. We pass the curated list
   * through verbatim. */
  const modalModels = $derived(models ?? undefined);
</script>

<button
  type="button"
  class="picker-btn"
  onclick={() => (modalOpen = true)}
  title="Choose model (search 200+ via OpenRouter)"
>
  <span class="picker-name">{activeName}</span>
  <svg
    class="picker-chev"
    viewBox="0 0 12 12"
    width="10"
    height="10"
    aria-hidden="true"
  >
    <path
      d="M3 4.5l3 3 3-3"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</button>

<ModelSearchModal
  {session}
  models={modalModels}
  bind:open={modalOpen}
  onClose={() => (modalOpen = false)}
/>

<style>
  .picker-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--wb-chat-fg-muted, #666);
    padding: 3px 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    outline: none;
    max-width: 180px;
  }
  .picker-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .picker-chev {
    flex-shrink: 0;
    opacity: 0.6;
  }
  .picker-btn:hover {
    background: rgba(0, 0, 0, 0.04);
    color: var(--wb-chat-fg, #0a0a0a);
  }
  @media (prefers-color-scheme: dark) {
    .picker-btn { color: var(--wb-chat-fg-muted, #a0a0a0); }
    .picker-btn:hover {
      background: rgba(255, 255, 255, 0.04);
      color: var(--wb-chat-fg, #f5f5f5);
    }
  }
  .picker-btn:focus-visible {
    box-shadow: 0 0 0 1.5px var(--wb-chat-fg-muted, #666);
  }
</style>
