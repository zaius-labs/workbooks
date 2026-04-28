/**
 * @signal/workbook-runtime — Svelte 5 components that render the workbook
 * block tree.
 *
 * Root component + dispatcher live here. Consumers extend
 * `defaultBlockRegistry` with locally-coupled blocks (file/image/video/
 * input/concept) and pass the combined registry as a `Workbook` prop.
 */

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
