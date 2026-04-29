/** Plotly renderer for ML-specific viz: ROC, PR, calibration, partial
 *  dependence, ML parallel coords (with brushing + color), 3D scatter,
 *  SHAP beeswarm, SHAP waterfall.
 *
 *  Lazy-imported by Chart.svelte so the bundle only pays for Plotly
 *  when a Plotly viz actually renders. plotly.js-dist-min is ~2 MB
 *  gzipped — we don't want it in the default route.
 *
 *  Why Plotly for these specifically:
 *    - ROC/PR/calibration: clean built-in support for reference lines,
 *      auto-fill diagonals, AUC annotations.
 *    - parcoords-ml: native brushing + color-by-metric.
 *    - 3D scatter: only Plotly does this well in pure JS without WebGL
 *      gymnastics.
 *    - SHAP waterfall: built-in `waterfall` trace type.
 *    - SHAP beeswarm: best approximated via box+jitter+colored points,
 *      which Plotly handles natively. */
/* plotly.js-dist-min ships no .d.ts and our app.d.ts shim isn't visible
 * to svelte-check's module resolution; we use a dynamic import in
 * renderPlotly() and cast to a small typed surface (PlotlyApi) below. */
import type {
  CalibrationChartData,
  ChartBlock,
  PRChartData,
  ParcoordsMLChartData,
  PartialDependenceChartData,
  ROCChartData,
  Scatter3DChartData,
  ShapBeeswarmChartData,
  ShapWaterfallChartData,
} from "../../types";
import { PALETTE } from "./palette";

type PlotlyApi = {
  newPlot(
    el: HTMLElement,
    data: unknown[],
    layout?: unknown,
    config?: unknown,
  ): Promise<unknown>;
  purge(el: HTMLElement): void;
  Plots: { resize(el: HTMLElement): void };
};

const PLOTLY_CONFIG = {
  responsive: true,
  displaylogo: false,
  modeBarButtonsToRemove: ["sendDataToCloud", "lasso2d", "select2d"],
} as const;

/** Plotly takes literal colors, not CSS vars. We resolve theme tokens
 *  from the live document at render time so light/dark mode swaps
 *  cleanly. Falls back to the static value when the var isn't defined
 *  (e.g. SSR snapshot). */
function readVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

/** Helper colors derived from theme tokens, computed once per render
 *  and consumed by trace builders below. */
function themeColors() {
  return {
    fg: readVar("--color-fg", "#0f0f0f"),
    fgMuted: readVar("--color-fg-muted", "rgba(15,15,15,0.56)"),
    /* Reference / guide line — same role as `--color-border` but
     *  needs to render visibly inside chart panels. */
    guide: readVar("--color-fg-subtle", "rgba(15,15,15,0.36)"),
  };
}

const BASE_LAYOUT = {
  font: { family: "ui-sans-serif, system-ui, sans-serif", size: 11 },
  paper_bgcolor: "transparent",
  plot_bgcolor: "transparent",
  margin: { l: 56, r: 16, t: 32, b: 48 },
  height: 320,
  hovermode: "closest" as const,
};

function color(i: number): string {
  return PALETTE[i % PALETTE.length];
}

function rocTraces(d: ROCChartData) {
  const traces: Record<string, unknown>[] = [
    /* Reference diagonal — random baseline. */
    {
      x: [0, 1],
      y: [0, 1],
      type: "scatter",
      mode: "lines",
      line: { color: themeColors().guide, dash: "dot", width: 1 },
      hoverinfo: "skip",
      showlegend: false,
      name: "random",
    },
    ...d.curves.map((c, i) => ({
      x: c.fpr,
      y: c.tpr,
      type: "scatter",
      mode: "lines",
      name: c.auc != null ? `${c.label} (AUC=${c.auc.toFixed(3)})` : c.label,
      line: { color: color(i), width: 2 },
    })),
  ];
  return {
    data: traces,
    layout: {
      ...BASE_LAYOUT,
      xaxis: { title: { text: "False positive rate" }, range: [0, 1], constrain: "domain" },
      yaxis: { title: { text: "True positive rate" }, range: [0, 1], scaleanchor: "x" },
      legend: { orientation: "h" as const, y: -0.18 },
    },
  };
}

function prTraces(d: PRChartData) {
  const traces: Record<string, unknown>[] = d.curves.map((c, i) => ({
    x: c.recall,
    y: c.precision,
    type: "scatter",
    mode: "lines",
    name: c.ap != null ? `${c.label} (AP=${c.ap.toFixed(3)})` : c.label,
    line: { color: color(i), width: 2 },
  }));
  if (d.baseline != null) {
    traces.unshift({
      x: [0, 1],
      y: [d.baseline, d.baseline],
      type: "scatter",
      mode: "lines",
      line: { color: themeColors().guide, dash: "dot", width: 1 },
      hoverinfo: "skip",
      showlegend: false,
      name: "baseline",
    });
  }
  return {
    data: traces,
    layout: {
      ...BASE_LAYOUT,
      xaxis: { title: { text: "Recall" }, range: [0, 1] },
      yaxis: { title: { text: "Precision" }, range: [0, 1] },
      legend: { orientation: "h" as const, y: -0.18 },
    },
  };
}

function calibrationTraces(d: CalibrationChartData) {
  const traces: Record<string, unknown>[] = [
    {
      x: [0, 1],
      y: [0, 1],
      type: "scatter",
      mode: "lines",
      line: { color: themeColors().guide, dash: "dot", width: 1 },
      hoverinfo: "skip",
      showlegend: false,
      name: "perfect",
    },
    ...d.curves.map((c, i) => ({
      x: c.predicted,
      y: c.observed,
      type: "scatter",
      mode: "lines+markers",
      name: c.label,
      line: { color: color(i), width: 2 },
      marker: c.counts ? { size: c.counts.map((n) => Math.min(20, Math.max(4, Math.sqrt(n)))) } : undefined,
    })),
  ];
  return {
    data: traces,
    layout: {
      ...BASE_LAYOUT,
      xaxis: { title: { text: "Mean predicted probability" }, range: [0, 1] },
      yaxis: { title: { text: "Fraction positive" }, range: [0, 1] },
      legend: { orientation: "h" as const, y: -0.18 },
    },
  };
}

function partialDependenceTraces(d: PartialDependenceChartData) {
  if (d.secondary) {
    /* 2-way: heatmap on (d.feature × d.secondary.feature). */
    return {
      data: [
        {
          z: d.secondary.values,
          x: d.x,
          y: d.secondary.y,
          type: "heatmap",
          colorscale: "Viridis",
          hovertemplate: `${d.feature}: %{x}<br>${d.secondary.feature}: %{y}<br>predicted: %{z}<extra></extra>`,
        },
      ],
      layout: {
        ...BASE_LAYOUT,
        xaxis: { title: { text: d.feature } },
        yaxis: { title: { text: d.secondary.feature } },
      },
    };
  }
  return {
    data: [
      {
        x: d.x,
        y: d.y,
        type: "scatter",
        mode: "lines",
        line: { color: PALETTE[0], width: 2 },
        fill: "tozeroy",
        fillcolor: `${PALETTE[0]}22`,
        name: d.feature,
      },
    ],
    layout: {
      ...BASE_LAYOUT,
      xaxis: { title: { text: d.feature } },
      yaxis: { title: { text: "Predicted" } },
    },
  };
}

function parcoordsMLTraces(d: ParcoordsMLChartData) {
  return {
    data: [
      {
        type: "parcoords",
        line: {
          color: d.color.values,
          colorscale: d.color.colorScale ?? "Viridis",
          showscale: true,
          colorbar: { title: { text: d.color.name } },
        },
        dimensions: d.dimensions.map((dim) => ({
          label: dim.name,
          values: dim.values,
          range: dim.range,
        })),
      },
    ],
    layout: { ...BASE_LAYOUT, height: 360 },
  };
}

function scatter3DTraces(d: Scatter3DChartData) {
  const groups = Array.from(new Set(d.points.map((p) => p.group ?? "")));
  if (groups.length <= 1) {
    return {
      data: [
        {
          x: d.points.map((p) => p.x),
          y: d.points.map((p) => p.y),
          z: d.points.map((p) => p.z),
          text: d.points.map((p) => p.label ?? ""),
          type: "scatter3d",
          mode: "markers",
          marker: { size: 3, color: PALETTE[0], opacity: 0.8 },
          hovertemplate: "%{text}<br>(%{x:.3f}, %{y:.3f}, %{z:.3f})<extra></extra>",
        },
      ],
      layout: {
        ...BASE_LAYOUT,
        height: 400,
        scene: {
          xaxis: { title: { text: d.xLabel ?? "x" } },
          yaxis: { title: { text: d.yLabel ?? "y" } },
          zaxis: { title: { text: d.zLabel ?? "z" } },
        },
      },
    };
  }
  return {
    data: groups.map((g, i) => {
      const pts = d.points.filter((p) => (p.group ?? "") === g);
      return {
        x: pts.map((p) => p.x),
        y: pts.map((p) => p.y),
        z: pts.map((p) => p.z),
        text: pts.map((p) => p.label ?? ""),
        type: "scatter3d",
        mode: "markers",
        name: g || "ungrouped",
        marker: { size: 3, color: color(i), opacity: 0.8 },
      };
    }),
    layout: {
      ...BASE_LAYOUT,
      height: 400,
      scene: {
        xaxis: { title: { text: d.xLabel ?? "x" } },
        yaxis: { title: { text: d.yLabel ?? "y" } },
        zaxis: { title: { text: d.zLabel ?? "z" } },
      },
    },
  };
}

function shapBeeswarmTraces(d: ShapBeeswarmChartData) {
  /* Per-feature: a horizontal box with all points jittered + colored by
   * the underlying feature value (low=blue, high=red) — the standard
   * SHAP beeswarm. */
  const traces = d.features.map((feat, fi) => {
    const shap = d.shapValues.map((row) => row[fi]);
    const featValsRaw = d.featureValues?.map((row) => row[fi]);
    /* Normalize feature values to [0,1] for the colorscale. */
    let featVals: number[] | undefined;
    if (featValsRaw && featValsRaw.length === shap.length) {
      const min = Math.min(...featValsRaw);
      const max = Math.max(...featValsRaw);
      const range = max - min || 1;
      featVals = featValsRaw.map((v) => (v - min) / range);
    }
    return {
      x: shap,
      y: shap.map(() => feat),
      type: "scatter",
      mode: "markers",
      orientation: "h",
      name: feat,
      showlegend: false,
      marker: {
        size: 5,
        opacity: 0.7,
        color: featVals,
        colorscale: featVals ? "RdBu" : undefined,
        showscale: featVals && fi === 0,
        cmin: 0,
        cmax: 1,
        colorbar: featVals && fi === 0 ? { title: { text: "feature value" } } : undefined,
      },
      hovertemplate: `${feat}<br>SHAP: %{x:.3f}<extra></extra>`,
    };
  });
  return {
    data: traces,
    layout: {
      ...BASE_LAYOUT,
      height: Math.max(240, 28 * d.features.length + 80),
      xaxis: { title: { text: "SHAP value (impact on prediction)" }, zeroline: true, zerolinecolor: themeColors().guide },
      yaxis: { categoryorder: "array", categoryarray: [...d.features].reverse() },
      margin: { ...BASE_LAYOUT.margin, l: 120 },
    },
  };
}

function shapWaterfallTraces(d: ShapWaterfallChartData) {
  /* Plotly's built-in waterfall trace handles the cumulative bar
   * decomposition. We prepend a marker for the base value and append
   * the final value as a "total" measure. */
  const measures = ["absolute", ...d.contributions.map(() => "relative")];
  const xLabels = ["E[f(x)]", ...d.contributions.map((c) => c.feature)];
  const yValues = [d.baseValue, ...d.contributions.map((c) => c.value)];
  const text = [
    d.baseValue.toFixed(3),
    ...d.contributions.map(
      (c) =>
        `${c.value >= 0 ? "+" : ""}${c.value.toFixed(3)}${
          c.featureValue !== undefined ? ` (${c.featureValue})` : ""
        }`,
    ),
  ];
  return {
    data: [
      {
        type: "waterfall",
        orientation: "h",
        measure: measures,
        y: xLabels,
        x: yValues,
        text,
        textposition: "outside",
        connector: { line: { color: themeColors().guide } },
        increasing: { marker: { color: PALETTE[0] } },
        decreasing: { marker: { color: PALETTE[5] } },
        totals: { marker: { color: themeColors().fg } },
      },
    ],
    layout: {
      ...BASE_LAYOUT,
      height: Math.max(240, 36 * d.contributions.length + 80),
      xaxis: { title: { text: "Predicted contribution" } },
      yaxis: { autorange: "reversed" },
      margin: { ...BASE_LAYOUT.margin, l: 140 },
    },
  };
}

function buildPlotlyArgs(block: ChartBlock): {
  data: Record<string, unknown>[];
  layout: Record<string, unknown>;
} {
  const d = block.data;
  let result: { data: Record<string, unknown>[]; layout: Record<string, unknown> };
  switch (d.kind) {
    case "roc":
      result = rocTraces(d);
      break;
    case "pr-curve":
      result = prTraces(d);
      break;
    case "calibration":
      result = calibrationTraces(d);
      break;
    case "partial-dependence":
      result = partialDependenceTraces(d);
      break;
    case "parcoords-ml":
      result = parcoordsMLTraces(d);
      break;
    case "3d-scatter":
      result = scatter3DTraces(d);
      break;
    case "shap-beeswarm":
      result = shapBeeswarmTraces(d);
      break;
    case "shap-waterfall":
      result = shapWaterfallTraces(d);
      break;
    default:
      throw new Error(
        `renderPlotly: unsupported viz "${(d as { kind: string }).kind}"`,
      );
  }
  /* Patch layout.font.color from the live theme so text renders
   * legibly in both light and dark modes. The trace builders set
   * `font.family` + `font.size` only; this fills in `color`. */
  const fg = themeColors().fg;
  const layout = { ...result.layout };
  const font = (layout.font as Record<string, unknown> | undefined) ?? {};
  layout.font = { ...font, color: fg };
  return { data: result.data, layout };
}

/** Mount a Plotly chart on `target`. Returns a cleanup that purges the
 *  Plotly instance and removes any resize listener. */
export async function renderPlotly(
  target: HTMLElement,
  block: ChartBlock,
): Promise<() => void> {
  // @ts-expect-error — plotly.js-dist-min ships no .d.ts; the
  // typed surface we use is captured by PlotlyApi below.
  const mod = await import("plotly.js-dist-min");
  const Plotly = (mod.default ?? mod) as unknown as PlotlyApi;
  const { data, layout } = buildPlotlyArgs(block);
  await Plotly.newPlot(target, data, layout, PLOTLY_CONFIG);
  const onResize = () => {
    if (target.isConnected) Plotly.Plots.resize(target);
  };
  window.addEventListener("resize", onResize);
  return () => {
    window.removeEventListener("resize", onResize);
    Plotly.purge(target);
  };
}
