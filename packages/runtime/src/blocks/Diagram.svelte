<script lang="ts">
  import type { DiagramBlock } from "../types";
  import { onMount } from "svelte";
  import { sanitizeSvg } from "../util/sanitize";

  let { block }: { block: DiagramBlock } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let error = $state<string | null>(null);

  /** Stable id per instance — mermaid wants a unique id per render. */
  const renderId = `mermaid-${Math.random().toString(36).slice(2, 9)}`;

  onMount(() => {
    if (!host) return;
    const node = host;
    let cancelled = false;

    (async () => {
      try {
        if (block.syntax !== "mermaid") {
          error = `Unsupported diagram syntax: ${block.syntax}`;
          return;
        }
        const mermaid = (await import("mermaid")).default;
        if (cancelled) return;
        const isDark =
          typeof document !== "undefined" &&
          document.documentElement.classList.contains("dark");
        const cs = getComputedStyle(document.documentElement);
        const cssVar = (name: string, fallback: string) =>
          cs.getPropertyValue(name).trim() || fallback;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: isDark ? "dark" : "default",
          themeVariables: {
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
            primaryColor: cssVar("--chart-1", "#1d8cd8"),
            primaryTextColor: cssVar("--color-fg", isDark ? "#f4f4f5" : "#0f0f0f"),
            primaryBorderColor: cssVar("--chart-1", "#1d8cd8"),
            lineColor: cssVar(
              "--color-fg-muted",
              isDark ? "rgba(255,255,255,0.4)" : "rgba(15,15,15,0.4)",
            ),
            secondaryColor: cssVar("--chart-2", "#f14285"),
            tertiaryColor: cssVar("--chart-3", "#ffb35b"),
          },
        });
        const { svg } = await mermaid.render(renderId, block.source);
        if (cancelled) return;
        // Mermaid runs in securityLevel: "strict" mode (configured
        // above), but sanitize anyway — the rendered SVG can still
        // contain author-controlled label text and the strict mode
        // is a Mermaid-internal concern, not a sanitizer. closes core-0id.2
        node.innerHTML = sanitizeSvg(svg);
      } catch (e) {
        error = e instanceof Error ? e.message : "Mermaid render failed";
      }
    })();

    return () => {
      cancelled = true;
      node.innerHTML = "";
    };
  });
</script>

<figure
  class="flex flex-col gap-3 rounded-[18px] border border-border bg-surface p-4"
>
  {#if block.title}
    <figcaption class="flex items-center gap-2">
      <span
        class="rounded-full border border-border bg-surface-soft px-2 py-0.5 text-[10px] uppercase tracking-wider text-fg-muted"
      >
        {block.syntax}
      </span>
      <h3 class="text-[14px] font-semibold tracking-tight">{block.title}</h3>
    </figcaption>
  {/if}

  <div bind:this={host} class="diagram-host w-full overflow-x-auto"></div>

  {#if error}
    <p class="text-[12px] text-rose-700 dark:text-rose-300">{error}</p>
  {/if}

  {#if block.caption}
    <p class="text-[12.5px] text-fg-muted">{block.caption}</p>
  {/if}
</figure>

<style>
  .diagram-host :global(svg) {
    max-width: 100%;
    height: auto;
  }
</style>
