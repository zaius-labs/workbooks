<script lang="ts">
  import type { CalloutBlock } from "../types";
  let { block }: { block: CalloutBlock } = $props();

  /* bg-X-50, text-X-700/800/900 already have global dark overrides
   * in app.css. Borders DON'T — pastel borders read too bright on dark
   * surfaces. Add explicit `dark:border-X-700/30` so the border stays
   * tonally consistent across modes. */
  const palette = $derived(
    block.tone === "warn"
      ? {
          bg: "bg-amber-50",
          border: "border-amber-300/60 dark:border-amber-700/30",
          icon: "text-amber-700",
          text: "text-amber-900",
        }
      : block.tone === "error"
        ? {
            bg: "bg-rose-50",
            border: "border-rose-300/60 dark:border-rose-700/30",
            icon: "text-rose-700",
            text: "text-rose-900",
          }
        : block.tone === "success"
          ? {
              bg: "bg-emerald-50",
              border: "border-emerald-300/60 dark:border-emerald-700/30",
              icon: "text-emerald-700",
              text: "text-emerald-900",
            }
          : {
              bg: "bg-surface-soft",
              border: "border-border",
              icon: "text-fg-muted",
              text: "text-fg",
            },
  );
</script>

<aside
  class="flex items-start gap-3 rounded-[14px] border {palette.border} {palette.bg} px-4 py-3"
>
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="mt-0.5 shrink-0 {palette.icon}"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
  <div class="flex flex-1 flex-col gap-1 {palette.text}">
    {#if block.title}
      <p class="text-[13px] font-semibold">{block.title}</p>
    {/if}
    <p class="text-[13px] leading-relaxed">{block.text}</p>
  </div>
</aside>
