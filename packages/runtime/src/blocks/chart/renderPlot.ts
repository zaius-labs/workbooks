/** Observable Plot-based renderer for the simple statistical viz family:
 *  line, bar, scatter, area, histogram. Lazy-imported by Chart.svelte so
 *  the bundle only pays for Plot when a chart actually renders. */
import * as Plot from "@observablehq/plot";
import type {
  AreaChartData,
  BarChartData,
  ChartBlock,
  HistogramChartData,
  LineChartData,
  ScatterChartData,
} from "../../types";
import { color, colorForSeries, PALETTE } from "./palette";

const PLOT_DEFAULTS = {
  width: 640,
  height: 240,
  marginLeft: 44,
  marginBottom: 32,
  marginTop: 12,
  marginRight: 16,
} as const;

/** Per-render context the helpers read at call time. Set by renderPlot
 *  before dispatching, cleared by the returned cleanup. Stays
 *  module-scoped so the existing per-kind functions don't need a new
 *  parameter threaded through every signature. */
type PlotOpts = {
  brandResolver?: import("./palette").BrandResolver;
  suppressEngineLegend?: boolean;
};
let CURRENT_OPTS: PlotOpts = {};

/** Common style — Plot inherits CSS color from the parent, which lets us
 *  use --color-fg / --color-fg-muted from the theme. */
function baseStyle(): Plot.PlotOptions["style"] {
  return {
    background: "transparent",
    fontSize: "11px",
    color: "var(--color-fg)",
    overflow: "visible",
  };
}

function flattenLineLike(
  x: (string | number)[],
  series: { label: string; values: number[]; color?: string }[],
): { x: string | number; y: number; series: string; color: string }[] {
  const rows: { x: string | number; y: number; series: string; color: string }[] = [];
  series.forEach((s, i) => {
    const c = color(i, s.color);
    s.values.forEach((y, idx) => {
      rows.push({ x: x[idx], y, series: s.label, color: c });
    });
  });
  return rows;
}

function renderLine(data: LineChartData): (HTMLElement | SVGElement) {
  const rows = flattenLineLike(data.x, data.series);
  const colorMap = Object.fromEntries(
    data.series.map((s, i) => [
      s.label,
      colorForSeries(s, i, CURRENT_OPTS.brandResolver),
    ]),
  );
  return Plot.plot({
    ...PLOT_DEFAULTS,
    style: baseStyle(),
    x: { label: data.xLabel ?? null, grid: false },
    y: { label: data.yLabel ?? null, grid: true },
    color: {
      domain: Object.keys(colorMap),
      range: Object.values(colorMap),
      legend: !CURRENT_OPTS.suppressEngineLegend,
    },
    marks: [
      Plot.ruleY([0], { stroke: "var(--color-border)" }),
      Plot.line(rows, { x: "x", y: "y", stroke: "series", strokeWidth: 1.6, curve: "monotone-x" }),
      Plot.dot(rows, { x: "x", y: "y", fill: "series", r: 2 }),
      /* Hover tooltip — Plot.tip + Plot.pointer tracks the closest datum
       * to the cursor and renders a styled panel with x/y/series. */
      Plot.tip(
        rows,
        Plot.pointer({
          x: "x",
          y: "y",
          channels: { series: "series" },
          format: { series: true, x: true, y: true },
        }),
      ),
    ],
  });
}

function renderArea(data: AreaChartData): (HTMLElement | SVGElement) {
  const rows = flattenLineLike(data.x, data.series);
  const colorMap = Object.fromEntries(
    data.series.map((s, i) => [
      s.label,
      colorForSeries(s, i, CURRENT_OPTS.brandResolver),
    ]),
  );
  /* Plot.areaY stacks by default when fill is a categorical channel; pass
   * z: "series" + offset null to disable stacking for the grouped case. */
  return Plot.plot({
    ...PLOT_DEFAULTS,
    style: baseStyle(),
    x: { label: data.xLabel ?? null },
    y: { label: data.yLabel ?? null, grid: true },
    color: {
      domain: Object.keys(colorMap),
      range: Object.values(colorMap),
      legend: !CURRENT_OPTS.suppressEngineLegend,
    },
    marks: [
      Plot.areaY(rows, {
        x: "x",
        y: "y",
        fill: "series",
        fillOpacity: 0.55,
        stroke: "series",
        strokeWidth: 1.2,
        z: data.stacked ? undefined : "series",
        offset: data.stacked ? undefined : null,
      }),
      Plot.ruleY([0], { stroke: "var(--color-border)" }),
      Plot.tip(
        rows,
        Plot.pointer({
          x: "x",
          y: "y",
          channels: { series: "series" },
          format: { series: true, x: true, y: true },
        }),
      ),
    ],
  });
}

function renderBar(data: BarChartData): (HTMLElement | SVGElement) {
  const rows: { cat: string; value: number; series: string }[] = [];
  data.series.forEach((s) => {
    s.values.forEach((v, idx) => {
      rows.push({ cat: data.categories[idx], value: v, series: s.label });
    });
  });
  const colorMap = Object.fromEntries(
    data.series.map((s, i) => [
      s.label,
      colorForSeries(s, i, CURRENT_OPTS.brandResolver),
    ]),
  );
  const singleSeries = data.series.length === 1;
  const numCats = data.categories.length;
  const avgLabelLen =
    numCats > 0
      ? data.categories.reduce((s, c) => s + c.length, 0) / numCats
      : 0;
  const longLabels = avgLabelLen > 8;
  /* Flip to horizontal when there are many categories with long names —
   * vertical bars stop being readable past ~8 categories or when names
   * average >12 chars. Single-series ranked comparisons read best
   * sorted descending in horizontal form. */
  const horizontal =
    singleSeries && (numCats > 8 || avgLabelLen > 12);
  /* Rotate x tick labels when staying vertical with many or long
   * categories. Bump bottom margin to fit the rotated text. */
  const rotateXTicks = !horizontal && (numCats > 6 || longLabels);
  const marginBottom = rotateXTicks
    ? Math.min(140, 36 + Math.round(avgLabelLen * 5))
    : PLOT_DEFAULTS.marginBottom;
  /* Horizontal needs a wider left margin to fit the category labels. */
  const marginLeft = horizontal
    ? Math.min(200, 24 + Math.round(avgLabelLen * 6))
    : PLOT_DEFAULTS.marginLeft;

  if (horizontal) {
    /* Sort desc by value for the ranked-comparison read. */
    const sorted = [...rows].sort((a, b) => b.value - a.value);
    const domain = sorted.map((r) => r.cat);
    return Plot.plot({
      ...PLOT_DEFAULTS,
      marginLeft,
      style: baseStyle(),
      x: { label: data.yLabel ?? null, grid: true },
      y: {
        label: data.xLabel ?? null,
        domain,
      },
      color: singleSeries
        ? undefined
        : {
            domain: Object.keys(colorMap),
            range: Object.values(colorMap),
            legend: !CURRENT_OPTS.suppressEngineLegend,
          },
      marks: [
        Plot.barX(sorted, {
          x: "value",
          y: "cat",
          fill: singleSeries ? PALETTE[0] : "series",
          sort: singleSeries ? undefined : { y: "x", reverse: true },
        }),
        Plot.ruleX([0], { stroke: "var(--color-border)" }),
        Plot.tip(
          sorted,
          Plot.pointer({
            x: "value",
            y: "cat",
            channels: { series: "series" },
            format: { x: true, y: true, series: !singleSeries },
          }),
        ),
      ],
    });
  }

  return Plot.plot({
    ...PLOT_DEFAULTS,
    marginBottom,
    style: baseStyle(),
    x: {
      label: data.xLabel ?? null,
      padding: 0.18,
      ...(rotateXTicks ? { tickRotate: -38 } : {}),
    },
    y: { label: data.yLabel ?? null, grid: true },
    color: singleSeries
      ? undefined
      : {
          domain: Object.keys(colorMap),
          range: Object.values(colorMap),
          legend: !CURRENT_OPTS.suppressEngineLegend,
        },
    marks: [
      Plot.barY(rows, {
        x: "cat",
        y: "value",
        fill: singleSeries ? PALETTE[0] : "series",
        /* Grouped bars (multi-series, non-stacked) use fx to dodge.
         * Single-series and stacked share the same x slot — no fx. */
        ...(singleSeries || data.stacked ? {} : { fx: "series" }),
      }),
      Plot.ruleY([0], { stroke: "var(--color-border)" }),
      Plot.tip(
        rows,
        Plot.pointer({
          x: "cat",
          y: "value",
          channels: { series: "series" },
          format: { x: true, y: true, series: !singleSeries },
        }),
      ),
    ],
  });
}

function renderScatter(data: ScatterChartData): (HTMLElement | SVGElement) {
  const groups = Array.from(new Set(data.points.map((p) => p.group ?? "")));
  const colorMap = Object.fromEntries(
    groups.map((g, i) => [g, color(i)]),
  );
  return Plot.plot({
    ...PLOT_DEFAULTS,
    style: baseStyle(),
    x: { label: data.xLabel ?? null, grid: true },
    y: { label: data.yLabel ?? null, grid: true },
    color:
      groups.length > 1
        ? { domain: groups, range: groups.map((g) => colorMap[g]), legend: true }
        : undefined,
    marks: [
      Plot.dot(data.points, {
        x: "x",
        y: "y",
        fill: groups.length > 1 ? (d: { group?: string }) => d.group ?? "" : PALETTE[0],
        fillOpacity: 0.7,
        r: 3.5,
        stroke: "white",
        strokeWidth: 0.4,
      }),
      /* Hover tip — when scatter points carry a `label`, surface it
       * alongside x/y/group; otherwise just x/y/group. */
      Plot.tip(
        data.points,
        Plot.pointer({
          x: "x",
          y: "y",
          channels: {
            group: (d: { group?: string }) => d.group ?? "",
            label: (d: { label?: string }) => d.label ?? "",
          },
          format: { x: true, y: true, group: groups.length > 1, label: true },
        }),
      ),
    ],
  });
}

function renderHistogram(data: HistogramChartData): (HTMLElement | SVGElement) {
  return Plot.plot({
    ...PLOT_DEFAULTS,
    style: baseStyle(),
    x: { label: data.xLabel ?? null },
    y: { label: data.yLabel ?? "Count", grid: true },
    marks: [
      Plot.rectY(data.values, {
        ...Plot.binX(
          { y: "count" },
          { x: (d: number) => d, thresholds: data.bins },
        ),
        fill: PALETTE[0],
        fillOpacity: 0.85,
      }),
      Plot.ruleY([0], { stroke: "var(--color-border)" }),
      /* Hover tip on the binned rectangles — Plot.tip with binX gives
       * us "Range: <x1, x2>  Count: <y>". */
      Plot.tip(
        data.values,
        Plot.pointerX(
          Plot.binX(
            { y: "count" },
            { x: (d: number) => d, thresholds: data.bins },
          ),
        ),
      ),
    ],
  });
}

/** Optional renderer options. `brandResolver` is plumbed through the
 *  per-kind helpers via closure; `suppressEngineLegend` switches off
 *  Plot's auto-legend so a host-rendered HTML legend can take over. */
export type RenderPlotOptions = {
  brandResolver?: import("./palette").BrandResolver;
  suppressEngineLegend?: boolean;
};

/** Mount a Plot-rendered chart into `target`. Returns a cleanup function
 *  that removes the rendered node. */
export function renderPlot(
  target: HTMLElement,
  block: ChartBlock,
  opts: RenderPlotOptions = {},
): () => void {
  const { data } = block;
  /* Stash on a module-scoped slot so the per-kind helpers can read it
   * without a signature change to every function. Cleared on cleanup. */
  CURRENT_OPTS = opts;
  let node: HTMLElement | SVGElement;
  switch (data.kind) {
    case "line":
      node = renderLine(data);
      break;
    case "bar":
      node = renderBar(data);
      break;
    case "scatter":
      node = renderScatter(data);
      break;
    case "area":
      node = renderArea(data);
      break;
    case "histogram":
      node = renderHistogram(data);
      break;
    default: {
      const _: never = data as never;
      throw new Error(`renderPlot: unsupported viz "${(data as { kind: string }).kind}"`);
    }
  }
  target.replaceChildren(node);
  return () => {
    CURRENT_OPTS = {};
    target.replaceChildren();
  };
}
