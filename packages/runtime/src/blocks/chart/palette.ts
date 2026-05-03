/** Brand-derived chart palette. CSS custom properties (`--chart-1..6`,
 *  `--chart-sequential-*`, `--chart-divergent-*`) defined in app.css are
 *  the single source of truth — these static arrays are SSR fallbacks
 *  and the seed used when getComputedStyle returns nothing. Hue-sorted
 *  so multi-series charts read as a spectrum and a single-series chart
 *  defaults to a real color (azure) rather than near-black ink. */
export const PALETTE = [
  "#1d8cd8", // azure       — --chart-1
  "#f14285", // magenta     — --chart-2
  "#ffb35b", // amber       — --chart-3
  "#792acd", // violet      — --chart-4
  "#20f0de", // teal        — --chart-5
  "#fe5a64", // coral       — --chart-6
] as const;

/** Sequential ramp for heatmaps with positive-only magnitudes. Light azure
 *  → deep azure → violet so high values pop without competing with chart
 *  ink. Mirrors --chart-sequential-1..6 in app.css. */
export const SEQUENTIAL_RAMP = [
  "#f0f7fc",
  "#bfddf2",
  "#76b8e0",
  "#1d8cd8",
  "#5a4ec0",
  "#3c1e6e",
] as const;

/** Diverging ramp centered on neutral. Use for signed data
 *  (residuals, deltas). Mirrors --chart-divergent-1..5 in app.css. */
export const DIVERGING_RAMP = [
  "#fe5a64",
  "#fbb59a",
  "#f0eee8",
  "#9bc7e6",
  "#1d8cd8",
] as const;

/** Read a single CSS custom property from <html>. Returns `fallback` when
 *  not in a browser (SSR) or when the var is undefined. */
function readVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

/** Read a numbered run of CSS vars (`--{prefix}-1`, `--{prefix}-2`, …) and
 *  return the resolved values in order. Stops at the first undefined slot
 *  to support palettes that shrink. Falls back to the static array when
 *  no CSS vars are resolvable (SSR / first paint). */
function readNumberedVars(
  prefix: string,
  fallback: readonly string[],
): readonly string[] {
  if (typeof window === "undefined") return fallback;
  const out: string[] = [];
  for (let i = 1; i <= fallback.length; i++) {
    const v = readVar(`--${prefix}-${i}`, "");
    if (!v) break;
    out.push(v);
  }
  return out.length > 0 ? out : fallback;
}

/** Live chart palette — call once per render and pass the result through
 *  `colorForSeries` so a single render is internally consistent (every
 *  series picks from the same snapshot). */
export function resolveChartPalette(): readonly string[] {
  return readNumberedVars("chart", PALETTE);
}

/** Live sequential ramp for heatmap-style viz. */
export function resolveSequentialRamp(): readonly string[] {
  return readNumberedVars("chart-sequential", SEQUENTIAL_RAMP);
}

/** Live diverging ramp for signed-value viz. */
export function resolveDivergingRamp(): readonly string[] {
  return readNumberedVars("chart-divergent", DIVERGING_RAMP);
}

/** Pick the i-th distinct palette color, wrapping. Resolves the live
 *  palette when `palette` is omitted — pass an explicit palette inside
 *  hot loops to avoid re-reading CSS per call. */
export function color(
  i: number,
  override?: string,
  palette: readonly string[] = resolveChartPalette(),
): string {
  return override ?? palette[i % palette.length];
}

/** Resolved brand surface for chart series — what the renderer needs
 *  to know about a brand without depending on the full Brand schema. */
export type BrandResolved = {
  name: string;
  color?: string;
  /** Pre-derived favicon URL (Google service or custom). Always set —
   *  the resolver fills it from the brand's hostname when missing. */
  faviconUrl: string;
  emoji?: string;
};

export type BrandResolver = (id: string) => BrandResolved | null;

/** Color to use for a series at index `i`, given an optional brand
 *  resolver. Precedence: explicit series.color → brand.color → palette.
 *  Pass `palette` from `resolveChartPalette()` once per render. */
export function colorForSeries(
  s: { color?: string; brand?: string },
  i: number,
  resolver?: BrandResolver,
  palette: readonly string[] = resolveChartPalette(),
): string {
  if (s.color) return s.color;
  if (s.brand && resolver) {
    const b = resolver(s.brand);
    if (b?.color) return b.color;
  }
  return palette[i % palette.length];
}
