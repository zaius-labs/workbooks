/**
 * sdoc — the typed document format agents produce and the session canvas renders.
 *
 * Agents produce JSON matching `WorkbookDocument`. The SvelteKit session canvas
 * renders each block with a dedicated component. No runtime Markdown/MDX
 * compilation — the structure is the contract, and every block is trivially
 * round-trippable through Convex.
 *
 * Keep this file tiny. Adding a new block kind = one entry here + one Svelte
 * component in apps/web/src/lib/sdoc/blocks/. Keep block shapes narrow so the
 * LLM can hit them reliably; if you find yourself adding free-form props,
 * you probably want a Markdown block.
 */

/* ------------------------------- primitives ------------------------------ */

export type CalloutTone = "info" | "warn" | "success" | "error";

export type ChartSeries = {
  label: string;
  values: number[];
  /** Explicit hex color override. Wins over brand.color and the
   *  default palette. */
  color?: string;
  /** When set, the renderer looks up doc.brands[brand] and:
   *    - uses brand.color for the series color (if `color` above is unset)
   *    - shows the brand favicon next to the series name in the legend
   *  String matches a Brand.id in doc.brands[]. */
  brand?: string;
  /** Emoji to render in place of the colored swatch in the legend.
   *  Wins over brand.faviconUrl. Useful when the category has a
   *  natural emoji (countries, sentiment, sports, regions). */
  emoji?: string;
};

export type LineChartData = {
  kind: "line";
  /** Values along the x axis, one per index in every series. */
  x: (string | number)[];
  xLabel?: string;
  yLabel?: string;
  series: ChartSeries[];
};

export type BarChartData = {
  kind: "bar";
  categories: string[];
  xLabel?: string;
  yLabel?: string;
  series: ChartSeries[];
  /** Stack bars when true; grouped side-by-side when false. Defaults to grouped. */
  stacked?: boolean;
};

export type ScatterPoint = {
  x: number;
  y: number;
  label?: string;
  group?: string;
};

export type ScatterChartData = {
  kind: "scatter";
  xLabel?: string;
  yLabel?: string;
  points: ScatterPoint[];
};

/** Filled line chart — same shape as line, rendered with an area fill below
 *  each series. Use for a single cumulative series; multi-series areas
 *  should set `stacked: true` to read cleanly. */
export type AreaChartData = {
  kind: "area";
  x: (string | number)[];
  xLabel?: string;
  yLabel?: string;
  series: ChartSeries[];
  stacked?: boolean;
};

/** Histogram — distribution of a single numeric field. The renderer bins
 *  automatically (Freedman–Diaconis) unless `bins` is set. */
export type HistogramChartData = {
  kind: "histogram";
  values: number[];
  /** Override bin count. Omit to let the renderer pick. */
  bins?: number;
  xLabel?: string;
  yLabel?: string;
};

/** Heatmap — a 2D grid where each cell encodes a value via color. Use for
 *  correlation matrices, confusion matrices, or any "X by Y → magnitude". */
export type HeatmapChartData = {
  kind: "heatmap";
  /** Column labels, left-to-right. */
  x: string[];
  /** Row labels, top-to-bottom. */
  y: string[];
  /** values[row][col] — must be y.length × x.length. */
  values: number[][];
  xLabel?: string;
  yLabel?: string;
  /** Sequential for "magnitude" data (correlation, counts).
   *  Diverging for signed data centered on 0 (residuals, deltas). */
  colorScale?: "sequential" | "diverging";
};

export type TreeNode = {
  name: string;
  /** Leaves carry a value; parents sum their children. */
  value?: number;
  children?: TreeNode[];
};

/** Treemap — nested rectangles sized by `value`. Good for proportions
 *  with hierarchy (revenue by region by product). */
export type TreemapChartData = {
  kind: "treemap";
  root: TreeNode;
};

/** Sunburst — same hierarchy as treemap, rendered as nested rings. Better
 *  when hierarchy depth > 2 or when angular comparison reads more naturally. */
export type SunburstChartData = {
  kind: "sunburst";
  root: TreeNode;
};

export type SankeyNode = { name: string };
export type SankeyLink = {
  /** Index into `nodes` or the node name. */
  source: number | string;
  target: number | string;
  value: number;
};

/** Sankey — flow diagram where width encodes value. Use for funnels,
 *  energy/budget allocations, and "where did X go" decompositions. */
export type SankeyChartData = {
  kind: "sankey";
  nodes: SankeyNode[];
  links: SankeyLink[];
};

/** Radar — many series compared across a small set of named axes (5–10
 *  axes works best). Don't use for ordered/continuous axes — that's a line
 *  chart. */
export type RadarChartData = {
  kind: "radar";
  /** One label per axis. The same length as each series.values. */
  axes: string[];
  series: ChartSeries[];
  /** Per-axis max for normalization. Omit to let the renderer compute. */
  max?: number[];
};

export type ParallelCoordsRow = {
  values: number[];
  group?: string;
  label?: string;
};

/** Parallel coordinates — high-dimensional rows as polylines across N
 *  parallel numeric axes. Use to spot clusters / outliers in tabular data. */
export type ParallelCoordsChartData = {
  kind: "parallel-coords";
  /** Axis label per dimension; same length as each row.values. */
  dimensions: string[];
  rows: ParallelCoordsRow[];
};

/* ---- ML-specific viz (rendered by Plotly) ----
 *  These chart kinds are the ones Plot/ECharts don't cover well: ROC,
 *  PR, calibration, partial dependence, ML-grade parallel coordinates
 *  with brushing, 3D scatter for embeddings, and SHAP visualizations.
 *  The renderer dispatcher routes these to renderPlotly.ts; everything
 *  else stays on Plot / ECharts. */

export type ROCCurve = {
  /** Series label — usually a model name. */
  label: string;
  /** False positive rate, sorted ascending. Same length as tpr. */
  fpr: number[];
  /** True positive rate. */
  tpr: number[];
  /** Area under curve. Rendered next to the label. */
  auc?: number;
};

/** ROC — TPR vs FPR for one or more binary classifiers.
 *  Diagonal y=x is rendered as the "random baseline" reference. */
export type ROCChartData = {
  kind: "roc";
  curves: ROCCurve[];
};

export type PRCurve = {
  label: string;
  recall: number[];
  precision: number[];
  /** Average precision. */
  ap?: number;
};

/** Precision-recall — preferred over ROC when classes are imbalanced. */
export type PRChartData = {
  kind: "pr-curve";
  curves: PRCurve[];
  /** Optional class prior baseline (the constant-precision line). */
  baseline?: number;
};

/** Calibration — predicted probability vs observed event rate. Reference
 *  diagonal y=x is rendered. Multi-curve = multi-class one-vs-rest. */
export type CalibrationChartData = {
  kind: "calibration";
  curves: {
    label: string;
    /** Bin midpoints, [0,1]. */
    predicted: number[];
    /** Observed positive fraction in each bin, [0,1]. */
    observed: number[];
    /** Bin counts, optional (used to size markers). */
    counts?: number[];
  }[];
};

/** Partial dependence — feature → predicted-target curve. Pass `secondary`
 *  to switch to a 2-way heatmap (feature × secondary → predicted). */
export type PartialDependenceChartData = {
  kind: "partial-dependence";
  feature: string;
  x: number[];
  y: number[];
  secondary?: {
    feature: string;
    /** Y-axis category values (the second feature's grid). */
    y: number[];
    /** values[yi][xi] — the predicted target on the (x[xi], y[yi]) grid. */
    values: number[][];
  };
};

/** ML-grade parallel coordinates — like ParallelCoordsChartData but with
 *  a color-by metric (typically val-loss / accuracy / score) and brushing
 *  enabled. Use for hyperparameter search visualization. */
export type ParcoordsMLChartData = {
  kind: "parcoords-ml";
  dimensions: {
    name: string;
    values: number[];
    /** Hard axis range; overrides the data extent. */
    range?: [number, number];
  }[];
  color: {
    name: string;
    values: number[];
    /** Plotly-named colorscale: "Viridis", "RdBu", "Plasma", "Cividis". */
    colorScale?: string;
  };
};

/** 3D scatter — embeddings (UMAP-3D / PCA-3D) or any (x,y,z,group) data. */
export type Scatter3DPoint = {
  x: number;
  y: number;
  z: number;
  label?: string;
  group?: string;
};

export type Scatter3DChartData = {
  kind: "3d-scatter";
  points: Scatter3DPoint[];
  xLabel?: string;
  yLabel?: string;
  zLabel?: string;
};

/** SHAP beeswarm — global feature importance + direction. Each row in
 *  shapValues[rowIdx][featureIdx] is the SHAP contribution of that
 *  feature for that example; featureValues mirrors the original feature
 *  values used to color points (so the agent can show "high feature
 *  value pushes the prediction up", etc.). */
export type ShapBeeswarmChartData = {
  kind: "shap-beeswarm";
  features: string[];
  /** rows × features. */
  shapValues: number[][];
  /** Same shape; optional, used as the marker color channel. */
  featureValues?: number[][];
};

/** SHAP waterfall — the per-feature decomposition of a single
 *  prediction starting from the model's expected value. */
export type ShapWaterfallChartData = {
  kind: "shap-waterfall";
  baseValue: number;
  contributions: {
    feature: string;
    /** SHAP contribution (positive pushes prediction up). */
    value: number;
    /** Original feature value (e.g. 42 or "category_b"). Rendered as a
     *  trailing annotation on the row. */
    featureValue?: number | string;
  }[];
  /** baseValue + sum(contributions) — agent computes and passes through
   *  for label rendering. */
  finalValue?: number;
};

export type ChartData =
  | LineChartData
  | BarChartData
  | ScatterChartData
  | AreaChartData
  | HistogramChartData
  | HeatmapChartData
  | TreemapChartData
  | SunburstChartData
  | SankeyChartData
  | RadarChartData
  | ParallelCoordsChartData
  | ROCChartData
  | PRChartData
  | CalibrationChartData
  | PartialDependenceChartData
  | ParcoordsMLChartData
  | Scatter3DChartData
  | ShapBeeswarmChartData
  | ShapWaterfallChartData;

/** Stable list of every chart `kind` — used by the renderer dispatch and
 *  by the agent system prompt to enumerate available viz. */
export const CHART_KINDS = [
  "line",
  "bar",
  "scatter",
  "area",
  "histogram",
  "heatmap",
  "treemap",
  "sunburst",
  "sankey",
  "radar",
  "parallel-coords",
  "roc",
  "pr-curve",
  "calibration",
  "partial-dependence",
  "parcoords-ml",
  "3d-scatter",
  "shap-beeswarm",
  "shap-waterfall",
] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

/* --------------------------------- blocks -------------------------------- */

export type HeadingBlock = {
  kind: "heading";
  level: 1 | 2 | 3 | 4;
  text: string;
};

export type ParagraphBlock = {
  kind: "paragraph";
  text: string;
};

export type MarkdownBlock = {
  kind: "markdown";
  /** Full markdown body. The renderer parses with a safe subset — no HTML. */
  text: string;
};

export type ChartBlock = {
  kind: "chart";
  title?: string;
  caption?: string;
  data: ChartData;
};

export type TableBlock = {
  kind: "table";
  title?: string;
  caption?: string;
  headers: string[];
  rows: (string | number | null)[][];
  /** Column indices to render monospaced / right-aligned (numeric). */
  numericColumns?: number[];
};

export type CalloutBlock = {
  kind: "callout";
  tone: CalloutTone;
  title?: string;
  text: string;
};

export type CodeBlock = {
  kind: "code";
  language: string;
  text: string;
};

export type FileBlock = {
  kind: "file";
  /** Convex `files` document id. The client fetches a presigned GET from R2. */
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  /** Optional preview image id (for PDFs / videos). */
  previewFileId?: string;
};

export type ImageBlock = {
  kind: "image";
  /** Convex `files` document id — resolved to a signed R2 URL client-side. */
  fileId: string;
  /** Required for accessibility. Concise description of what's in the image. */
  alt: string;
  /** Optional caption rendered under the image. */
  caption?: string;
  /** Max rendered height in px. Defaults to responsive. */
  maxHeight?: number;
};

export type VideoBlock = {
  kind: "video";
  /** Convex `files` document id for the video bytes. */
  fileId: string;
  /** Optional caption below the video. */
  caption?: string;
  /** Optional poster frame (a separate `files` id pointing at a PNG/JPG). */
  posterFileId?: string;
  /** Browser autoplay hint — still requires muted to actually autoplay. */
  autoplay?: boolean;
};

export type MetricBlock = {
  kind: "metric";
  label: string;
  value: string;
  /**
   * Relative change. Positive / negative rendered green / red. Omit the sign —
   * the renderer adds it.
   */
  delta?: number;
  deltaLabel?: string;
  /** "percent" suffixes the delta with %. "absolute" uses the raw number. */
  deltaUnit?: "percent" | "absolute";
};

export type MetricGroupBlock = {
  kind: "metrics";
  metrics: Omit<MetricBlock, "kind">[];
};

export type DividerBlock = {
  kind: "divider";
};

/** Mermaid covers flowchart / sequence / class / state / gantt / ER /
 *  gitGraph / pie via its own DSL. The `syntax` discriminator exists so
 *  we can later add other diagram engines (e.g. an isometric architecture
 *  renderer, a network/graph renderer) without changing the block kind.
 *  The renderer for non-mermaid syntaxes will dispatch in Diagram.svelte. */
export type DiagramSyntax = "mermaid";

export type DiagramBlock = {
  kind: "diagram";
  syntax: DiagramSyntax;
  /** Source text in the chosen syntax. For mermaid, this is the full
   *  diagram definition (no triple-backtick fences — just the body). */
  source: string;
  title?: string;
  caption?: string;
};

/** Network graph — node-link diagram with explicit edges. Lives outside
 *  ChartData because the data shape (nodes/edges + layout) and the
 *  rendering library (Cytoscape) are very different from any chart.
 *
 *  Default engine: Cytoscape (SVG, <1K nodes). For larger graphs the
 *  agent can request `engine: "sigma"` (WebGL) — not yet wired in the
 *  host but the schema reserves the slot. */
export type NetworkLayout =
  | "cose"
  | "breadthfirst"
  | "concentric"
  | "grid"
  | "circle"
  | "dagre";

export type NetworkNode = {
  /** Stable id used by edges to reference this node. */
  id: string;
  label?: string;
  /** Cluster / category for color-coding. */
  group?: string;
  /** Marker size proxy. Renderer normalizes to pixel range. */
  weight?: number;
};

export type NetworkEdge = {
  /** node id. */
  source: string;
  /** node id. */
  target: string;
  /** Edge thickness proxy. Renderer normalizes. */
  weight?: number;
  directed?: boolean;
  label?: string;
};

export type NetworkBlock = {
  kind: "network";
  engine?: "cytoscape" | "sigma";
  layout: NetworkLayout;
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  title?: string;
  caption?: string;
};

/** Geospatial block — points / hex / choropleth / arc / path on a map.
 *  Renders via deck.gl + maplibre base tiles. WebGL-only; static
 *  exports show a "requires interactive viewer" placeholder. */
export type GeoSubtype = "points" | "hex" | "choropleth" | "arc" | "path";

export type GeoPointsData = {
  subtype: "points";
  /** Each point: [longitude, latitude, optional weight]. */
  points: { lon: number; lat: number; label?: string; weight?: number; group?: string }[];
};

export type GeoHexData = {
  subtype: "hex";
  /** Each point contributes one count to its hex bin. */
  points: { lon: number; lat: number; weight?: number }[];
  /** Hex radius in meters. */
  radius?: number;
};

export type GeoChoroplethData = {
  subtype: "choropleth";
  /** TopoJSON or GeoJSON FeatureCollection (passthrough). */
  geojson: unknown;
  /** Map keyed by feature id (or property.NAME) → numeric value. */
  values: Record<string, number>;
  /** Property name on each feature whose value is the lookup key in `values`. */
  joinKey?: string;
};

export type GeoArcData = {
  subtype: "arc";
  /** Origin → destination arcs. */
  arcs: {
    from: { lon: number; lat: number; label?: string };
    to: { lon: number; lat: number; label?: string };
    weight?: number;
  }[];
};

export type GeoPathData = {
  subtype: "path";
  /** Each path is a list of [lon, lat] points; e.g. a GPS trace. */
  paths: { points: { lon: number; lat: number }[]; label?: string; group?: string }[];
};

export type GeoData =
  | GeoPointsData
  | GeoHexData
  | GeoChoroplethData
  | GeoArcData
  | GeoPathData;

export type GeoBlock = {
  kind: "geo";
  data: GeoData;
  /** Initial map view. Defaults to fit-bounds of the data. */
  view?: { center?: [number, number]; zoom?: number };
  title?: string;
  caption?: string;
};

/** Embedding 3D — 3D scatter or surface, rendered via Threlte for cases
 *  where Plotly's 3d-scatter chart kind isn't enough (>5K points, custom
 *  shaders, loss-landscape surfaces). WebGL-only. */
export type Embedding3DScatterData = {
  subtype: "scatter";
  points: { x: number; y: number; z: number; label?: string; group?: string }[];
  xLabel?: string;
  yLabel?: string;
  zLabel?: string;
};

export type Embedding3DSurfaceData = {
  subtype: "surface";
  /** Z-values on a uniform XY grid. values[yi][xi] = z. */
  values: number[][];
  /** Optional axis tick values. */
  xTicks?: number[];
  yTicks?: number[];
  xLabel?: string;
  yLabel?: string;
  zLabel?: string;
};

export type Embedding3DData = Embedding3DScatterData | Embedding3DSurfaceData;

export type Embedding3DBlock = {
  kind: "embedding3d";
  data: Embedding3DData;
  title?: string;
  caption?: string;
};

/** ML concept block — the agent emits this when it has used a model skill
 *  (or a data-science concept) in producing the report and wants to expose
 *  the work to the reader. Renders inline as a small clickable badge; the
 *  click opens a modal showing why the agent used it, the actual hyperparams
 *  / features, the training results, and an interactive viz seeded with
 *  the report's data (rendered by the per-skill Modal component).
 *
 *  The `skill` string MUST match a key in MODEL_SKILL_NAMES (see
 *  apps/web/convex/agents/modelSkills.ts) — the concepts registry resolves
 *  that key to a Modal component. CI gates that every skill key has a
 *  corresponding folder under apps/web/src/lib/sdoc/concepts/<skill>/. */
export type ConceptBlock = {
  kind: "concept";
  /** The skill key from MODEL_SKILL_NAMES — e.g. "clustering",
   *  "tabular-classification", "time-series-forecasting". */
  skill: string;
  /** One-line plain-language summary of how the agent used this skill in
   *  the report. Shown on the badge — keep under ~80 chars. */
  summary: string;
  /** Free-form payload — the per-skill payload schema defines the shape,
   *  validated client-side by the registered Modal. Common keys:
   *    - reasoning: string         why this skill was chosen
   *    - hyperparams: object       what the agent configured
   *    - features: string[]        feature columns used (tabular)
   *    - metrics: object           eval metrics (per-skill keys)
   *    - viz: object               viz-seed data (per-skill shape)
   *    - dataSummary: object       rows/cols/sample size, etc.
   */
  payload: Record<string, unknown>;
  /** Optional override for the badge label. Defaults to a humanized form
   *  of the skill key. */
  title?: string;
};

/* ------------------------- sbook block stubs ----------------------------- */
/* Phase A3 of the sbook deliverable (epic core-6vr). These four block kinds */
/* are reserved here as schema stubs so writers + the agent prompt can       */
/* commit to them; Phase B (core-6vr.2.*) ships the renderers, Phase C       */
/* (core-6vr.3.*) wires execution. Until B/C land, the existing dispatch in  */
/* WorkbookBlock.svelte treats unknown kinds as no-op renders, so adding them    */
/* here is non-breaking.                                                      */

/**
 * Resolves an upstream block's value or output at render / execution time.
 * `from` is a `blockId` (string ulid in the addressable `sbookBlocks` row
 * set); `path` is a JSONPath-lite string pointing into the upstream
 * block's `body.value.*` (input blocks) or `run.output.*` (step blocks).
 *
 * Examples:
 *   { from: "in_src",   path: "value.connectionId" }
 *   { from: "stp_train", path: "output.machineId" }
 */
export type Binding = {
  from: string;
  path: string;
};

/** Mounts a composition by id inside the sbook canvas with paramBindings
 *  resolved from upstream block outputs/values. Read-only — the host
 *  composition's existing /i/[slug] runtime handles execution + metering. */
export type WidgetBlock = {
  kind: "widget";
  compositionId: string;
  paramBindings: Record<string, Binding>;
  /** Optional title rendered above the widget. */
  title?: string;
};

/** Mounts an inference UI for a trained machine at a pinned version.
 *  `machineId` and `machineVersion` may be inline strings/numbers or
 *  `Binding`s pointing at an upstream training step's output. */
export type MachineBlock = {
  kind: "machine";
  machineId: string | Binding;
  machineVersion: number | Binding;
  mode: "predict" | "classify" | "search" | "embed";
  title?: string;
};

/** A user-set value the sbook reads from. Connection picker, enum select,
 *  file upload, or scalar entry. Downstream blocks read `body.value` via
 *  `Binding.path: "value.*"`. `valueChangedAt` drives Phase C's staleness
 *  propagation. */
export type InputBlock = {
  kind: "input";
  schema:
    | { kind: "connection"; providers: string[] }
    | { kind: "enum"; options: string[] }
    | { kind: "file"; accept?: string[] }
    | { kind: "scalar"; type: "string" | "number" | "boolean" };
  value?: unknown;
  valueChangedAt?: number;
  label?: string;
};

/** Step actions — what a `kind:"step"` block actually does when played.
 *  Phase C narrows the per-action payloads; Phase A keeps them open via
 *  `Record<string, unknown>` so writers can populate without needing the
 *  full validator schema yet. */
export type StepAction =
  | {
      kind: "agent_turn";
      prompt: string;
      skills?: string[];
    }
  | {
      kind: "machine_call";
      machineId: string | Binding;
      method: "predict" | "classify" | "search" | "embed";
      paramBindings: Record<string, Binding>;
    }
  | {
      kind: "widget_call";
      compositionId: string;
      paramBindings: Record<string, Binding>;
    }
  | {
      kind: "connection_fetch";
      connectionId: string | Binding;
      request: Record<string, unknown>;
    }
  | {
      kind: "replay";
      blockId: string;
    }
  | {
      kind: "loop";
      over: Record<string, unknown>;
      each: Record<string, unknown>;
      collect?: Record<string, unknown>;
    };

/** When does a step run. */
export type StepTrigger =
  | { kind: "manual" }
  | { kind: "auto_on_input"; inputBlockIds: string[] }
  | { kind: "cron"; expr: string }
  | { kind: "after"; upstreamBlockId: string };

/** Live execution state for a step block. Lives on the `sbookBlocks`
 *  row (not in the block body — run state isn't part of the document
 *  JSON), passed to renderers as a parallel array alongside `doc.blocks`.
 *  Mirrors the schema's typed `run` validator. */
export type RunState = {
  status: "idle" | "queued" | "running" | "done" | "error" | "stale";
  lastSessionId?: string;
  lastTurnIndex?: number;
  lastRunAt?: number;
  durationMs?: number;
  error?: string;
  output?: unknown;
  autoRunOnUpstreamChange?: boolean;
};

/** A runnable step in a sbook. Phase B renders the shell (label, gate
 *  badge, idle play button); Phase C wires execution + run state. */
export type StepBlock = {
  kind: "step";
  label: string;
  action: StepAction;
  trigger: StepTrigger;
  /** Names of gates (defined in the host sbook's `bitSource`) that must
   *  evaluate true before the play button enables. */
  gates?: string[];
  /** Where the step's output is rendered. Defaults to the step block
   *  itself; use this to surface output in a downstream prose block. */
  outputBinding?: { kind: "block"; blockId: string };
};

/** A runnable cell in the linear block stream. Notebook-shaped workbooks
 *  use cells alongside prose blocks; the host's ReactiveExecutor extracts
 *  every `kind: "cell"` block, runs the static dependency analyzer over
 *  the source, builds a DAG, and re-executes downstream cells when an
 *  input changes. The block-side discriminator (`kind: "cell"`) lets the
 *  block renderer dispatch a cell-shaped widget while the executor reads
 *  the same row's `language` + `source` as a wasmBridge `Cell`.
 *
 *  Shape mirrors the executor's `Cell` interface (wasmBridge.ts) so the
 *  bridge is `{ id: blockId, language, source, ...rest }`. The block id
 *  comes from the host's addressable row layer (sbookBlocks.blockId), not
 *  duplicated here. `provides` / `reads` are populated by the static
 *  analyzer at save time; `dependsOn` is derived. */
export type CellBlock = {
  kind: "cell";
  /** One of the executor's structured language tags. Free-form code is
   *  not supported — the executor dispatches each language to a typed
   *  WASM entry point. See `CellLanguage` in wasmBridge.ts. */
  language:
    | "rhai"
    | "polars"
    | "sqlite"
    | "duckdb"
    | "candle-inference"
    | "linfa-train"
    | "wasm-fn"
    | "chat";
  /** Source for source-driven languages (rhai, sqlite, duckdb, polars). */
  source?: string;
  /** Structured spec for declarative languages (candle-inference,
   *  linfa-train, wasm-fn, chat). Shape varies by language; the executor
   *  validates it at run time. */
  spec?: unknown;
  /** Variables / tables this cell consumes. Populated by the analyzer. */
  reads?: string[];
  /** Variables / tables this cell defines. Populated by the analyzer. */
  provides?: string[];
  /** Cell ids this cell depends on. Derived from reads/provides. */
  dependsOn?: string[];
  /** Optional human label rendered in the cell shell. Falls back to a
   *  language-derived placeholder. */
  label?: string;
};

export type WorkbookBlock =
  | HeadingBlock
  | ParagraphBlock
  | MarkdownBlock
  | ChartBlock
  | TableBlock
  | CalloutBlock
  | CodeBlock
  | FileBlock
  | ImageBlock
  | VideoBlock
  | MetricBlock
  | MetricGroupBlock
  | DividerBlock
  | DiagramBlock
  | ConceptBlock
  | NetworkBlock
  | GeoBlock
  | Embedding3DBlock
  | WidgetBlock
  | MachineBlock
  | InputBlock
  | StepBlock
  | CellBlock;

/* -------------------------------- citations ------------------------------- */
/* Citations are first-class on the document. References are addressed by
 * id; markdown / paragraph blocks reference them via [[c:<claimId>]]
 * anchors that resolve to numbered superscripts at render time and feed
 * the bottom-of-report citation widget.
 *
 * The shape is split across four fields:
 *   references     — the actual sources (URLs, papers, repos, datasets)
 *   glossary       — term → definition with optional supporting refs
 *   claims         — text spans tied to one or more references
 *   citationScore  — two-axis quality summary (Sources / Own-work)
 *
 * The agent fills references / claims as it writes the report; the
 * scorer (separate pass) populates citationScore from those plus the
 * @Machine training-run artifacts. Schema is additive — older reports
 * without these fields render unchanged. */

/** Coarse, neutral source classification — used by the scorer's tier
 *  signal. We deliberately avoid editorial labels ("good"/"bad") and
 *  instead surface what evidence type the source is. */
export type ReferenceTier =
  | "peer-reviewed"
  | "official-data"
  | "established-outlet"
  | "industry-blog"
  | "forum-social"
  | "unknown";

export type ReferenceSignals = {
  /** GitHub stars when the source is a repo. */
  githubStars?: number;
  githubForks?: number;
  /** HuggingFace downloads when the source is a model/dataset. */
  hfDownloads?: number;
  hfLikes?: number;
  /** Semantic Scholar paper-citation count. */
  paperCitations?: number;
  /** Tranco rank — popularity floor signal for generic web. Lower = more popular. */
  trancoRank?: number;
  /** True when the domain is on the .gov / .edu / DOI primary-source allowlist. */
  primarySource?: boolean;
  /** ISO date string. Used by the scorer to compute recency. */
  lastUpdated?: string;
};

export type Reference = {
  /** Stable id; matches the `[[c:<refId>]]` anchor and the `references`
   *  field on Claim entries. */
  id: string;
  /** Canonical URL. */
  url?: string;
  /** Short title rendered in the bibliography list. */
  title: string;
  authors?: string[];
  /** Journal / publisher / outlet / repo owner — whatever fits. */
  publisher?: string;
  /** ISO date the source was published. */
  publishedAt?: string;
  /** ISO date the agent accessed/cited the source. */
  accessedAt?: string;
  /** Coarse classification — usually filled by the scorer, not the agent. */
  tier?: ReferenceTier;
  /** Quantitative signals the scorer aggregates. */
  signals?: ReferenceSignals;
};

export type GlossaryEntry = {
  /** Word/phrase as it appears in the report. */
  term: string;
  definition: string;
  /** References backing the definition. */
  references?: string[];
};

/** Claim type — distinguishes reportable evidence from open-ended
 *  theories and the agent's own analytical synthesis. The scorer treats
 *  these differently:
 *    fact       — should be cited; uncited facts tank the coverage score
 *    theory     — surface as theory in the UI; uncited is fine but flagged
 *    synthesis  — the agent's own analysis from cited primary sources;
 *                 the supporting refs cover the inputs, not the conclusion
 *  This taxonomy is the gating design question for C4 (the scorer); it
 *  may evolve before that lands. */
export type ClaimKind = "fact" | "theory" | "synthesis";

export type Claim = {
  /** Stable id; matches `[[c:<claimId>]]` anchors. */
  id: string;
  /** What the claim asserts. Usually quotes the report text it
   *  anchors. Used by the scorer for cross-corroboration similarity. */
  text: string;
  /** Reference ids supporting the claim. Empty = uncited. */
  references: string[];
  /** Optional kind. When unset, scorer treats as "fact". */
  kind?: ClaimKind;
};

/** Per-machine quality breakdown contributing to the own-work axis. */
export type MachineQuality = {
  /** @Machine id. */
  id: string;
  /** Eval metric name (matches the @Machine.metric field). */
  metric: string;
  /** Achieved metric value on the holdout. */
  value: number;
  /** Threshold the @Machine was committed to. */
  threshold: number;
  direction: "maximize" | "minimize";
  /** -1 (failed badly) to +1 (cleared comfortably); 0 = right at threshold. */
  margin: number;
  /** Train/test gap as a fraction of train metric — overfit signal.
   *  0 = no gap; higher = bigger overfit risk. */
  trainTestGap?: number;
  sampleSize?: number;
  /** 0–1; how well sample size meets the skill's documented floor. */
  sampleSizeAdequacy?: number;
};

export type CitationScore = {
  /** External-source axis — quality of what the agent CITED. */
  sources: {
    /** Fraction of substantive claims that have at least one anchor. */
    coverage: number;
    /** Weighted average of source tiers, mapped 0–1. */
    averageTier: number;
    averageRecencyDays?: number;
    /** Avg independent-domain references per claim. */
    averageCorroboration?: number;
    /** Fraction of cited sources flagged as primary. */
    primaryPercent?: number;
  };
  /** Own-work axis — quality of what the agent COMPUTED. Pulled from
   *  @Machine training runs. Absent when the report has no machines. */
  ownWork?: {
    /** Weighted average of margin across machines, mapped 0–1. */
    overall: number;
    machines?: MachineQuality[];
  };
};

/* -------------------------------- entities -------------------------------- */
/* Entities are concrete data items the report references — a row from
 * a spreadsheet, a node from a graph, a model prediction, an item the
 * agent flagged. Different from references (which are sources / URLs)
 * and claims (which are factual assertions). The renderer surfaces them
 * as badges with hover tooltips that reveal the underlying data.
 *
 * Inline anchor: [[e:<entityId>]] in markdown / paragraph blocks. The
 * renderer replaces the token with a small badge. On hover/focus, a
 * tooltip shows the key/value pairs in `data` plus the optional source
 * (file + sheet + row coords for spreadsheet rows). */

export type EntityKind =
  | "row"          // a row from a tabular dataset (the most common case)
  | "node"         // a node from a network graph
  | "feature"      // a feature column or feature value
  | "prediction"   // a model prediction for a single input
  | "image"        // an image artifact + metadata
  | "other";

export type EntitySource = {
  /** File this entity came from (optional). */
  fileId?: string;
  /** Sheet / tab name when fileId is a spreadsheet. */
  sheet?: string;
  /** 1-based row index (spreadsheet convention). */
  row?: number;
  /** 1-based column index. */
  column?: number;
  /** Free-form locator string the renderer can show in the tooltip
   *  ("A23", "users[42]", "node_id:abc123"). */
  ref?: string;
};

export type Entity = {
  /** Stable id; matches `[[e:<entityId>]]` anchors. */
  id: string;
  kind: EntityKind;
  /** Short label rendered on the badge — usually the source ref ("A23")
   *  or a primary identifier ("client_3"). Keep under ~12 chars. */
  label: string;
  /** Field map shown in the tooltip. Order is preserved for rendering. */
  data: Record<string, string | number | boolean | null>;
  source?: EntitySource;
};

/* -------------------------------- brands -------------------------------- */
/* Brands are companies / products / profiles the report references. They
 * render as inline badges with the brand's favicon on the left and the
 * name as the link text. The agent emits [[b:<brandId>]] anchors in
 * markdown / paragraph blocks; the renderer resolves the brand and
 * shows the badge. Cleaner than a bare hyperlink — readers recognize a
 * logo faster than reading a URL.
 *
 * Typical sources: scraped social media profiles, vendor / dataset
 * provenance, competitor lists in market analyses.
 *
 * Favicon fallback: when `faviconUrl` is unset the renderer derives it
 * from `url`'s hostname via a free favicon service. The agent can
 * always override (a custom CDN logo, a brandfetch URL, etc.). */

export type BrandHandle = {
  /** Platform identifier (e.g. "twitter", "instagram", "tiktok",
   *  "github", "linkedin"). */
  platform: string;
  /** Handle on that platform (without the @). */
  handle: string;
};

export type Brand = {
  /** Stable id; matches `[[b:<brandId>]]` anchors. */
  id: string;
  /** Display name on the badge. */
  name: string;
  /** Primary URL — the badge links here on click. Used to derive the
   *  default favicon when faviconUrl isn't set. */
  url: string;
  /** Optional override — a higher-quality logo (brandfetch, custom CDN). */
  faviconUrl?: string;
  /** Brand accent color (hex). Used when the brand drives a chart
   *  series color or appears as a colored marker. Optional; chart
   *  renderers fall back to the default palette. */
  color?: string;
  /** Optional emoji shorthand. When set, chart legends and other
   *  glyph contexts can show this in place of a color swatch — useful
   *  for cases where the brand has a recognizable emoji (a country
   *  flag, a sport, a category icon). */
  emoji?: string;
  /** Per-platform handles for dedupe across social scrapes. */
  handles?: BrandHandle[];
};

/* -------------------------------- document ------------------------------- */

export type WorkbookDocument = {
  /** Usually a short declarative title — renders as an h1 at the top. */
  title?: string;
  /** One-sentence hook directly under the title. */
  tldr?: string;
  blocks: WorkbookBlock[];
  /** ── citation infrastructure (additive; older reports work unchanged) ── */
  references?: Reference[];
  glossary?: GlossaryEntry[];
  claims?: Claim[];
  citationScore?: CitationScore;
  /** ── entity references — inline `[[e:id]]` anchors render as
   *      hover-tooltip badges showing the underlying data row. ── */
  entities?: Entity[];
  /** ── brand references — inline `[[b:id]]` anchors render as
   *      logo+name pills linking to the brand's URL. Favicon is
   *      derived from `url` unless `faviconUrl` is provided. ── */
  brands?: Brand[];
};

/* -------------------------------- guards --------------------------------- */

export const WORKBOOK_BLOCK_KINDS = [
  "heading",
  "paragraph",
  "markdown",
  "chart",
  "table",
  "callout",
  "code",
  "file",
  "image",
  "video",
  "metric",
  "metrics",
  "divider",
  "diagram",
  "concept",
  "network",
  "geo",
  "embedding3d",
  // Phase A3 — sbook block stubs. Renderers land in Phase B
  // (core-6vr.2.*); execution wiring in Phase C (core-6vr.3.*).
  "widget",
  "machine",
  "input",
  "step",
  // Notebook execution cell — runs in the WASM runtime via
  // ReactiveExecutor. See CellBlock above and wasmBridge.Cell.
  "cell",
] as const;

export type WorkbookBlockKind = (typeof WORKBOOK_BLOCK_KINDS)[number];

export function isWorkbookBlock(v: unknown): v is WorkbookBlock {
  return (
    typeof v === "object" &&
    v !== null &&
    "kind" in v &&
    typeof (v as { kind: unknown }).kind === "string" &&
    (WORKBOOK_BLOCK_KINDS as readonly string[]).includes(
      (v as { kind: string }).kind,
    )
  );
}

export function isWorkbookDocument(v: unknown): v is WorkbookDocument {
  if (typeof v !== "object" || v === null) return false;
  const doc = v as { blocks?: unknown };
  return Array.isArray(doc.blocks) && doc.blocks.every(isWorkbookBlock);
}
