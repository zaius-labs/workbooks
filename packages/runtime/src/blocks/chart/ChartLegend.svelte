<script lang="ts">
  /**
   * Custom HTML legend strip rendered ABOVE the chart canvas when any
   * series carries a brand or emoji. Replaces the engine's auto-legend
   * (which only does colored dots) so favicons and emoji glyphs can
   * stand in for swatches.
   *
   * Behavior:
   *   - emoji wins over brand favicon wins over colored dot
   *   - clicking a brand-bound series item opens the brand URL
   *     (otherwise it's a non-interactive label)
   *   - layout is a wrapping flex strip with consistent gaps
   */
  import type { ChartSeries } from "../../types";
  import {
    colorForSeries,
    type BrandResolver,
  } from "./palette";
  import { DEFAULT_BRAND_ICON } from "./brandIcon";

  let {
    series,
    brandResolver,
  }: {
    series: ChartSeries[];
    brandResolver?: BrandResolver;
  } = $props();

  type LegendItem = {
    label: string;
    color: string;
    emoji?: string;
    faviconUrl?: string;
    href?: string;
  };

  const items = $derived<LegendItem[]>(
    series.map((s, i) => {
      const brand = s.brand && brandResolver ? brandResolver(s.brand) : null;
      return {
        label: s.label,
        color: colorForSeries(s, i, brandResolver),
        emoji: s.emoji ?? brand?.emoji,
        faviconUrl: brand?.faviconUrl,
        href: brand ? undefined : undefined, // no href yet; brand badges in-text already link
      };
    }),
  );
</script>

<div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-fg-muted">
  {#each items as item, i (i)}
    <span class="inline-flex items-center gap-1.5">
      {#if item.emoji}
        <span class="sd-legend-glyph" aria-hidden="true">{item.emoji}</span>
      {:else if item.faviconUrl}
        <img
          src={item.faviconUrl}
          class="sd-legend-favicon"
          alt=""
          loading="lazy"
          referrerpolicy="no-referrer"
          onerror={(e) => {
            const img = e.currentTarget as HTMLImageElement;
            if (img.src !== DEFAULT_BRAND_ICON) {
              img.src = DEFAULT_BRAND_ICON;
            }
          }}
        />
      {:else}
        <span
          class="sd-legend-swatch"
          style:background={item.color}
          aria-hidden="true"
        ></span>
      {/if}
      <span>{item.label}</span>
    </span>
  {/each}
</div>

<style>
  .sd-legend-glyph {
    display: inline-block;
    line-height: 1;
    font-size: 13px;
  }
  .sd-legend-favicon {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 2px;
    object-fit: cover;
    box-shadow: 0 0 0 1px color-mix(in srgb, currentColor 8%, transparent);
  }
  .sd-legend-swatch {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
</style>
