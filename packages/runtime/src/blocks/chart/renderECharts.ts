/** ECharts-based renderer for the structural viz family that Plot doesn't
 *  cover well: heatmap, treemap, sunburst, sankey, radar, parallel-coords.
 *  Lazy-imported by Chart.svelte; ECharts itself is heavy (~700 KB
 *  gzipped) so reports without these viz never pay for it. */
import * as echarts from "echarts";
import type {
  ChartBlock,
  HeatmapChartData,
  ParallelCoordsChartData,
  RadarChartData,
  SankeyChartData,
  SunburstChartData,
  TreemapChartData,
} from "../../types";
import {
  PALETTE,
  resolveChartPalette,
  resolveDivergingRamp,
  resolveSequentialRamp,
} from "./palette";

/** Shared theme overrides — ECharts reads CSS-variable colors literally,
 *  so we resolve them from the document at render time. */
function readVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

function baseTextStyle() {
  return {
    color: readVar("--color-fg", "#0f0f0f"),
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
  };
}

function heatmapOption(d: HeatmapChartData): echarts.EChartsOption {
  const flat: [number, number, number][] = [];
  for (let r = 0; r < d.values.length; r++) {
    for (let c = 0; c < d.values[r].length; c++) {
      flat.push([c, r, d.values[r][c]]);
    }
  }
  const all = flat.map((p) => p[2]);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const diverging = d.colorScale === "diverging";
  const range = diverging
    ? Math.max(Math.abs(min), Math.abs(max))
    : 0;
  return {
    grid: { left: 80, right: 24, top: 24, bottom: 56, containLabel: true },
    xAxis: { type: "category", data: d.x, name: d.xLabel, splitArea: { show: true } },
    yAxis: { type: "category", data: d.y, name: d.yLabel, splitArea: { show: true } },
    tooltip: {
      trigger: "item",
      // ECharts' callback param types are too wide for our narrow viz —
      // we cast to `any` at the boundary and narrow inside.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      formatter: ((p: any) => {
        const v = p?.value as [number, number, number] | undefined;
        if (!v) return "";
        return `<div style="font-size:11px"><strong>${escapeHtml(d.x[v[0]] ?? "")}</strong> × <strong>${escapeHtml(d.y[v[1]] ?? "")}</strong><br/>value: <code>${v[2]}</code></div>`;
      }) as unknown as never,
    },
    visualMap: {
      min: diverging ? -range : min,
      max: diverging ? range : max,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 4,
      inRange: {
        color: diverging ? [...resolveDivergingRamp()] : [...resolveSequentialRamp()],
      },
      textStyle: baseTextStyle(),
    },
    series: [
      {
        type: "heatmap",
        data: flat,
        label: { show: false },
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: "rgba(0,0,0,0.2)" } },
      },
    ],
    textStyle: baseTextStyle(),
  };
}

/** ECharts default tooltip styles look like a 2010 popover; ours match
 *  the rest of the host. Applied via the `tooltip.backgroundColor` /
 *  `tooltip.borderColor` knobs at trigger time. */
function tooltipChrome(): Record<string, unknown> {
  return {
    backgroundColor: readVar("--color-surface", "#ffffff"),
    borderColor: readVar("--color-border", "rgba(0,0,0,0.08)"),
    borderWidth: 1,
    extraCssText: "border-radius:10px; box-shadow:0 12px 36px rgba(0,0,0,0.12);",
    textStyle: baseTextStyle(),
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function treemapOption(d: TreemapChartData): echarts.EChartsOption {
  return {
    tooltip: {
      trigger: "item",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      formatter: ((p: any) => {
        const path = (p?.treePathInfo as { name: string }[] | undefined)
          ?.map((t) => escapeHtml(t.name))
          .join(" › ") ?? escapeHtml(String(p?.name ?? ""));
        return `<div style="font-size:11px"><strong>${path}</strong><br/>value: <code>${p?.value ?? ""}</code></div>`;
      }) as unknown as never,
      ...tooltipChrome(),
    },
    series: [
      {
        type: "treemap",
        data: [d.root],
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        label: { show: true, formatter: "{b}", fontSize: 11 },
        levels: PALETTE.map((c) => ({
          itemStyle: {
            borderColor: "#ffffff",
            borderWidth: 1,
            gapWidth: 1,
            color: c,
          },
        })),
        upperLabel: { show: true, height: 18, fontSize: 11 },
      },
    ],
    textStyle: baseTextStyle(),
  };
}

function sunburstOption(d: SunburstChartData): echarts.EChartsOption {
  return {
    tooltip: {
      trigger: "item",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      formatter: ((p: any) => {
        const path = (p?.treePathInfo as { name: string }[] | undefined)
          ?.map((t) => escapeHtml(t.name))
          .join(" › ") ?? escapeHtml(String(p?.name ?? ""));
        return `<div style="font-size:11px"><strong>${path}</strong><br/>value: <code>${p?.value ?? ""}</code></div>`;
      }) as unknown as never,
      ...tooltipChrome(),
    },
    series: [
      {
        type: "sunburst",
        data: [d.root],
        radius: ["12%", "92%"],
        label: { rotate: "radial", fontSize: 10 },
        levels: [
          {},
          ...PALETTE.map((c) => ({ itemStyle: { color: c, borderWidth: 1, borderColor: "#fff" } })),
        ],
      },
    ],
    textStyle: baseTextStyle(),
  };
}

function sankeyOption(d: SankeyChartData): echarts.EChartsOption {
  return {
    tooltip: {
      trigger: "item",
      /* ECharts' default sankey tooltip is fine — node hover shows
       * "<name>: total flow". For links we customize. */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      formatter: ((p: any) => {
        const data = (p?.data ?? {}) as {
          source?: string;
          target?: string;
          value?: number;
          name?: string;
        };
        if (p?.dataType === "edge") {
          return `<div style="font-size:11px">${escapeHtml(String(data.source ?? ""))} → ${escapeHtml(String(data.target ?? ""))}<br/>value: <code>${data.value ?? ""}</code></div>`;
        }
        return `<div style="font-size:11px"><strong>${escapeHtml(String(data.name ?? ""))}</strong></div>`;
      }) as unknown as never,
      ...tooltipChrome(),
    },
    series: [
      {
        type: "sankey",
        data: d.nodes.map((n, i) => ({
          name: n.name,
          itemStyle: { color: PALETTE[i % PALETTE.length] },
        })),
        links: d.links.map((l) => ({
          source: typeof l.source === "number" ? d.nodes[l.source].name : l.source,
          target: typeof l.target === "number" ? d.nodes[l.target].name : l.target,
          value: l.value,
        })),
        nodeAlign: "justify",
        emphasis: { focus: "adjacency" },
        lineStyle: { color: "gradient", curveness: 0.5, opacity: 0.5 },
        label: { fontSize: 11 },
      },
    ],
    textStyle: baseTextStyle(),
  };
}

function radarOption(d: RadarChartData): echarts.EChartsOption {
  const max =
    d.max ??
    d.axes.map((_, i) =>
      Math.max(...d.series.map((s) => s.values[i] ?? 0)) || 1,
    );
  return {
    tooltip: {
      trigger: "item",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      formatter: ((p: any) => {
        const values = (Array.isArray(p?.value) ? p.value : []) as number[];
        const lines = values
          .map(
            (v, i) =>
              `<div style="display:flex;justify-content:space-between;gap:12px;font-size:11px"><span style="color:${readVar(
                "--color-fg-muted",
                "rgba(0,0,0,0.56)",
              )}">${escapeHtml(d.axes[i] ?? "")}</span><code>${v}</code></div>`,
          )
          .join("");
        return `<div style="min-width:140px"><strong style="font-size:12px">${escapeHtml(String(p?.name ?? ""))}</strong>${lines}</div>`;
      }) as unknown as never,
      ...tooltipChrome(),
    },
    legend: { data: d.series.map((s) => s.label), bottom: 0, textStyle: baseTextStyle() },
    radar: {
      indicator: d.axes.map((name, i) => ({ name, max: max[i] })),
      shape: "polygon",
      splitLine: { lineStyle: { color: readVar("--color-border", "rgba(0,0,0,0.08)") } },
      axisLine: { lineStyle: { color: readVar("--color-border", "rgba(0,0,0,0.08)") } },
      splitArea: { show: false },
      axisName: baseTextStyle(),
    },
    series: [
      {
        type: "radar",
        data: d.series.map((s, i) => ({
          name: s.label,
          value: s.values,
          areaStyle: { opacity: 0.18 },
          lineStyle: { width: 1.6, color: s.color ?? PALETTE[i % PALETTE.length] },
          itemStyle: { color: s.color ?? PALETTE[i % PALETTE.length] },
        })),
      },
    ],
    textStyle: baseTextStyle(),
  };
}

function parallelOption(d: ParallelCoordsChartData): echarts.EChartsOption {
  const groups = Array.from(new Set(d.rows.map((r) => r.group ?? "")));
  const groupColors = Object.fromEntries(
    groups.map((g, i) => [g, PALETTE[i % PALETTE.length]]),
  );
  return {
    tooltip: {
      trigger: "item",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      formatter: ((p: any) => {
        const values = (Array.isArray(p?.value) ? p.value : []) as number[];
        const lines = values
          .map(
            (v, i) =>
              `<div style="display:flex;justify-content:space-between;gap:12px;font-size:11px"><span style="color:${readVar(
                "--color-fg-muted",
                "rgba(0,0,0,0.56)",
              )}">${escapeHtml(d.dimensions[i] ?? "")}</span><code>${v}</code></div>`,
          )
          .join("");
        const name = p?.name ? escapeHtml(String(p.name)) : "";
        return `<div style="min-width:140px">${name ? `<strong style="font-size:12px">${name}</strong>` : ""}${lines}</div>`;
      }) as unknown as never,
      ...tooltipChrome(),
    },
    parallelAxis: d.dimensions.map((name, i) => ({ dim: i, name })),
    parallel: {
      left: 60,
      right: 40,
      bottom: 32,
      top: 32,
      parallelAxisDefault: {
        type: "value",
        nameTextStyle: baseTextStyle(),
        axisLine: { lineStyle: { color: readVar("--color-border-strong", "rgba(0,0,0,0.16)") } },
        axisLabel: { color: readVar("--color-fg-muted", "rgba(0,0,0,0.56)") },
      },
    },
    series: [
      {
        type: "parallel",
        lineStyle: { width: 1, opacity: 0.5 },
        data: d.rows.map((r) => ({
          value: r.values,
          name: r.label,
          lineStyle: { color: groupColors[r.group ?? ""] },
        })),
      },
    ],
    textStyle: baseTextStyle(),
  };
}

function buildOption(block: ChartBlock): echarts.EChartsOption {
  const { data } = block;
  switch (data.kind) {
    case "heatmap":
      return heatmapOption(data);
    case "treemap":
      return treemapOption(data);
    case "sunburst":
      return sunburstOption(data);
    case "sankey":
      return sankeyOption(data);
    case "radar":
      return radarOption(data);
    case "parallel-coords":
      return parallelOption(data);
    default:
      throw new Error(
        `renderECharts: unsupported viz "${(data as { kind: string }).kind}"`,
      );
  }
}

export type RenderEChartsOptions = {
  brandResolver?: import("./palette").BrandResolver;
  /** Suppress the engine's built-in legend so the host can render an
   *  HTML legend strip with brand favicons / emoji glyphs. */
  suppressEngineLegend?: boolean;
};

/** Mount an ECharts instance on `target`. Returns a cleanup that disposes
 *  the chart and clears the listener. */
export function renderECharts(
  target: HTMLElement,
  block: ChartBlock,
  opts: RenderEChartsOptions = {},
): () => void {
  const chart = echarts.init(target, undefined, { renderer: "svg" });
  const option = buildOption(block);
  /* Suppress engine legend by stripping it from the option object.
   * Among ECharts kinds we use, only `radar` currently configures a
   * `legend` field; others auto-omit it. */
  if (opts.suppressEngineLegend) {
    (option as Record<string, unknown>).legend = { show: false };
  }
  chart.setOption(option);
  const onResize = () => chart.resize();
  window.addEventListener("resize", onResize);
  return () => {
    window.removeEventListener("resize", onResize);
    chart.dispose();
  };
}
