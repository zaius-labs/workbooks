/**
 * @workbook/runtime — Svelte 5 components that render the workbook
 * block tree.
 *
 * Root component + dispatcher live here. Consumers extend
 * `defaultBlockRegistry` with locally-coupled blocks (file/image/video/
 * input/concept) and pass the combined registry as a `Workbook` prop.
 */

// Canonical types (re-exported from ./types) — host apps import workbook
// data shapes (WorkbookDocument, WorkbookBlock, HeadingBlock, …) from here
// rather than maintaining their own copy.
export * from "./types";

// Root + dispatcher
export { default as Workbook } from "./Workbook.svelte";
export { default as WorkbookBlock } from "./WorkbookBlock.svelte";
export { default as CitationReport } from "./CitationReport.svelte";

// Block registry
export { defaultBlockRegistry } from "./blockRegistry";
export type { BlockRegistry } from "./blockRegistry";

// Block components (individual exports — kept for callers that mount a
// single block in isolation; most callers use Workbook.svelte + registry)
export { default as HeadingBlock } from "./blocks/Heading.svelte";
export { default as ParagraphBlock } from "./blocks/Paragraph.svelte";
export { default as MarkdownBlock } from "./blocks/Markdown.svelte";
export { default as CalloutBlock } from "./blocks/Callout.svelte";
export { default as DividerBlock } from "./blocks/Divider.svelte";
export { default as CodeBlock } from "./blocks/Code.svelte";
export { default as DiagramBlock } from "./blocks/Diagram.svelte";
export { default as ChartBlock } from "./blocks/Chart.svelte";
export { default as MetricBlock } from "./blocks/Metric.svelte";
export { default as MetricsBlock } from "./blocks/Metrics.svelte";
export { default as TableBlock } from "./blocks/Table.svelte";
export { default as StepBlock } from "./blocks/Step.svelte";
export { default as MachineBlock } from "./blocks/Machine.svelte";
export { default as WidgetBlock } from "./blocks/Widget.svelte";
export { default as NetworkBlock } from "./blocks/Network.svelte";
export { default as GeoBlock } from "./blocks/Geo.svelte";
export { default as Embedding3DBlock } from "./blocks/Embedding3D.svelte";

// Context stores
export {
  setWorkbookContext,
  getWorkbookContext,
} from "./workbookContext";
export type { WorkbookContext } from "./workbookContext";

export {
  setCitationContext,
  getCitationContext,
  buildCitationContext,
} from "./citationContext";

// Runtime client (Tier 1 — in-page WASM execution).
// Wraps the @workbook/runtime-wasm crate behind a Connect-shaped client
// matching `proto/workbook/runtime/v1/runtime.proto > WorkbookRuntimeService`.
export { createRuntimeClient } from "./wasmBridge";
export type {
  Cell,
  CellLanguage,
  CellOutput,
  Environment,
  RuntimeClient,
  RuntimeClientOptions,
  WasmLoader,
  WorkbookRuntimeWasm,
  InitRuntimeRequest,
  InitRuntimeResponse,
  RunCellRequest,
  RunCellResponse,
  BuildInfo,
} from "./wasmBridge";

// Static cell analyzer (P3.4) — extracts reads/provides from cell sources
// to drive DAG construction without requiring authors to declare every
// dependency by hand.
export { analyzeCell, extractSqlReads, extractRhaiReads } from "./cellAnalyzer";
export type { CellAnalysis } from "./cellAnalyzer";

// Reactive executor (P3.7) — builds the cell DAG, runs cells in topo
// order, re-runs only downstream subgraphs when inputs change. Debounced
// 200ms by default. Pair with createRuntimeClient() to get an end-to-end
// reactive workbook.
export { ReactiveExecutor } from "./reactiveExecutor";
export type {
  CellState,
  CellStatus,
  ExecutorOptions,
} from "./reactiveExecutor";

// DuckDB sidecar (P3.1) — opt-in. Workbooks that need DuckDB-specific
// SQL features dynamic-import this module; the ~7 MB chunk doesn't
// download for workbooks that only use Polars/Rhai/charts.
export { runDuckdbSql } from "./duckdbSidecar";

// URL parameter binding (P3.6) — input names ↔ ?name=value query params.
// Sharing a URL = sharing a parameterized workbook snapshot.
export {
  bindExecutorToUrl,
  readUrlParams,
  writeUrlParam,
  coerce as coerceUrlParam,
} from "./urlParamBinding";
export type {
  UrlParamSpec,
  UrlParamValue,
  UrlBinding,
} from "./urlParamBinding";
