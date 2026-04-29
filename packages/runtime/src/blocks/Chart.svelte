<script lang="ts">
  import type { ChartBlock, ChartSeries } from "../types";
  import { onMount } from "svelte";
  import { getCitationContext } from "../citationContext";
  import ChartLegend from "./chart/ChartLegend.svelte";
  import type { BrandResolver } from "./chart/palette";

  let { block }: { block: ChartBlock } = $props();

  /** Plot covers the simple statistical viz family; ECharts covers the
   *  structural/exotic ones; Plotly covers ML-specific viz. The agent
   *  never picks the engine — it picks the viz kind and we route. */
  const PLOT_KINDS = new Set(["line", "bar", "scatter", "area", "histogram"]);
  const ECHARTS_KINDS = new Set([
    "heatmap",
    "treemap",
    "sunburst",
    "sankey",
    "radar",
    "parallel-coords",
  ]);
  const PLOTLY_KINDS = new Set([
    "roc",
    "pr-curve",
    "calibration",
    "partial-dependence",
    "parcoords-ml",
    "3d-scatter",
    "shap-beeswarm",
    "shap-waterfall",
  ]);

  /* Brand resolver — wires the chart engines to doc.brands[] via the
   * citation context Workbook.svelte sets up. Renderers use it to color
   * series by brand and pick brand favicons for the custom legend. */
  const ctx = getCitationContext();
  const brandResolver: BrandResolver | undefined = ctx
    ? (id: string) => {
        const b = ctx.resolveBrand(id);
        if (!b) return null;
        return {
          name: b.brand.name,
          color: b.brand.color,
          faviconUrl: b.faviconUrl,
          emoji: b.brand.emoji,
        };
      }
    : undefined;

  /* Series array — present on chart kinds that have one. We use it to
   * decide whether to render the custom HTML legend strip (replacing
   * the engine's auto-legend) when any series carries a brand or
   * emoji marker. */
  const series = $derived.by<ChartSeries[] | null>(() => {
    const d = block.data;
    if (
      d.kind === "line" ||
      d.kind === "bar" ||
      d.kind === "area" ||
      d.kind === "radar"
    ) {
      return d.series;
    }
    return null;
  });

  const hasCustomLegend = $derived(
    !!series && series.some((s) => s.brand || s.emoji),
  );

  let target = $state<HTMLDivElement | null>(null);
  let error = $state<string | null>(null);

  onMount(() => {
    if (!target) return;
    const node = target;
    const kind = block.data.kind;
    let cleanup: (() => void) | null = null;
    let cancelled = false;

    /* When the host renders the custom legend, suppress engine legends
     * to avoid the double-legend UX. */
    const suppressEngineLegend = hasCustomLegend;

    (async () => {
      try {
        if (PLOT_KINDS.has(kind)) {
          const { renderPlot } = await import("./chart/renderPlot");
          if (cancelled) return;
          cleanup = renderPlot(node, block, {
            brandResolver,
            suppressEngineLegend,
          });
        } else if (ECHARTS_KINDS.has(kind)) {
          const { renderECharts } = await import("./chart/renderECharts");
          if (cancelled) return;
          cleanup = renderECharts(node, block, {
            brandResolver,
            suppressEngineLegend,
          });
        } else if (PLOTLY_KINDS.has(kind)) {
          const { renderPlotly } = await import("./chart/renderPlotly");
          const cleanupFn = await renderPlotly(node, block);
          if (cancelled) {
            cleanupFn();
            return;
          }
          cleanup = cleanupFn;
        } else {
          error = `Unsupported chart kind: ${kind}`;
        }
      } catch (e) {
        error = e instanceof Error ? e.message : "Chart render failed";
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
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
        {block.data.kind}
      </span>
      <h3 class="text-[14px] font-semibold tracking-tight">{block.title}</h3>
    </figcaption>
  {/if}

  {#if hasCustomLegend && series}
    <ChartLegend {series} {brandResolver} />
  {/if}

  <div
    bind:this={target}
    class="chart-target min-h-[240px] w-full text-fg"
    role="img"
    aria-label={block.title ?? block.data.kind}
  ></div>

  {#if error}
    <p class="text-[12px] text-rose-700 dark:text-rose-300">{error}</p>
  {/if}

  {#if block.caption}
    <p class="text-[12.5px] text-fg-muted">{block.caption}</p>
  {/if}
</figure>

<style>
  /* Plot inserts a <figure> with its own legend; let it size naturally. */
  .chart-target :global(svg) {
    max-width: 100%;
    height: auto;
  }
  .chart-target :global(.plot-figure) {
    margin: 0;
  }
</style>
