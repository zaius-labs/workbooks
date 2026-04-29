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

// Markdown renderer — small CommonMark-ish; suitable for chat / agent
// workbooks rendering assistant output. Returns trusted HTML.
export { renderMarkdown, escapeHtml } from "./markdown";

// Agent tools — wires runAgentLoop to a ReactiveExecutor so the agent
// can read + mutate cells in the surrounding workbook. Used by
// <wb-chat> and any custom chat-block authoring path.
export { createWorkbookAgentTools } from "./agentTools";
export type { CreateWorkbookAgentToolsOptions } from "./agentTools";

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

// (DuckDB sidecar export removed — core-0id.7. Polars-SQL covers
// analytical SQL; SQLite stub in wasmBridge.ts is the non-Polars
// roadmap.)

// LLM service client (T-LLM.1) — typed contract matching
// proto/workbook/llm/v1/llm.proto. Tier 1 browser transport ships now;
// Tier 2 (CF Gateway) and Tier 3 (Connect-RPC) plug in later without
// changing caller code.
export { createBrowserLlmClient } from "./llmClient";
export type {
  LlmClient,
  BrowserLlmClientOptions,
  ChatMessage,
  ContentPart,
  ToolDefinition,
  ToolCall,
  GenerateChatRequest,
  GenerateChatEvent,
  EmbedRequest,
  EmbedResponse,
  DescribeResponse,
  ModelInfo,
  Role,
  StopReason,
  TokenUsage,
} from "./llmClient";

// Agent loop (T-LLM.2) — minimal tool-using agent on top of LlmClient.
// Wraps generateChat with a tool-dispatch loop; pi-agent-core wraps this
// later for full multi-turn / planning semantics.
export { runAgentLoop } from "./agentLoop";
export type {
  AgentTool,
  AgentLoopOptions,
  AgentLoopResult,
} from "./agentLoop";

// HTML-first workbook bindings (T-HTML.1) — custom elements + parser
// + mounter. The DOM IS the workbook; no JSON marshaling needed.
//   <wb-workbook> <wb-input> <wb-cell> <wb-output> <wb-agent> <wb-chat>
// Plus registerWorkbookCell for plugin authors who ship new cell types.
export {
  parseWorkbookHtml,
  mountHtmlWorkbook,
  registerWorkbookCell,
  getRegisteredCell,
  createWorkbookCellRegistry,
} from "./htmlBindings";
export type {
  WorkbookContext,
  CustomCellExecutor,
  MountOptions,
  WorkbookCellRegistry,
  WorkbookData,
} from "./htmlBindings";

// Model artifact resolver (P4.2) — content-addressed IndexedDB cache for
// ML model weights. Cache-first fetch, SHA-256 integrity verification.
export {
  createModelArtifactResolver,
  sha256Hex,
} from "./modelArtifactResolver";
export type {
  ArtifactRef,
  ResolvedArtifact,
  ModelArtifactResolver,
} from "./modelArtifactResolver";

// Workbook data resolver — materializes <wb-data> blocks (CSV, JSON,
// SQLite, parquet, …) into the bytes/strings cells consume via reads=.
// Inline + external (host-allowlist + sha256 verified) storage forms.
export { createWorkbookDataResolver } from "./workbookDataResolver";
export type {
  ResolvedData,
  WorkbookDataResolver,
  WorkbookDataResolverOptions,
} from "./workbookDataResolver";

// Worker-isolated runtime client (core-0id.6) — wraps the in-page WASM
// client in a Worker with a wall-clock budget. On overrun the Worker is
// terminated and respawned, killing runaway Polars / Linfa / Candle cells
// the in-process Rhai operations cap can't reach.
export { createWorkerRuntimeClient } from "./runtimeWorker";
export type {
  WorkerRuntimeClientOptions,
  WorkerReq,
  WorkerRes,
} from "./runtimeWorker";

// Cross-workbook load + lockfile (P6.4) — pins (slug, version, sha256)
// so re-runs are reproducible even when upstream workbooks ship updates.
export { createCrossWorkbookLoader } from "./crossWorkbookLoader";
export type {
  CrossWorkbookRef,
  CrossWorkbookLoader,
  Lockfile,
  LockfileEntry,
  LoaderOptions,
} from "./crossWorkbookLoader";

// Loop block (P5.5) — schema + iteration planner. Loop execution
// dispatch lives in the host's executor (sequential fallback for Tier 1,
// worker-pool for Tier 3); this file owns the contract.
export { planLoopIterations, clampParallelism } from "./loopBlock";
export type {
  LoopBlockSpec,
  LoopOverSpec,
  LoopOverKind,
  LoopErrorPolicy,
  LoopIteration,
} from "./loopBlock";

// Structured diff between scheduled runs (P5.3) — per-cell rollup.
// Whole-workbook diffs compose by reducing per-cell diffs.
export { diffCellOutput, diffCsv, diffText } from "./runDiff";
export type { CellDiff, ChangedRow } from "./runDiff";

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
