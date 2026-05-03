// Runtime bundle entry — the JS that gets inlined into every built
// .html artifact via the workbook-cli's workbookInline plugin.
// Exports the non-Svelte runtime surface so the bundle stays small;
// Svelte components are imported separately by SDK consumers.
//
// Paths reflect the post-hoist layout (examples/ at repo root). To
// rebuild this bundle after touching any of the imported sources, run
// `bun run build:runtime-bundle` from the repo root.
export { createRuntimeClient } from "../../packages/runtime/src/wasmBridge";
export { analyzeCell } from "../../packages/runtime/src/cellAnalyzer";
export { ReactiveExecutor } from "../../packages/runtime/src/reactiveExecutor";
export { createBrowserLlmClient } from "../../packages/runtime/src/llmClient";
export { runAgentLoop } from "../../packages/runtime/src/agentLoop";
export {
  mountHtmlWorkbook,
  parseWorkbookHtml,
  registerWorkbookCell,
} from "../../packages/runtime/src/htmlBindings";
export { renderMarkdown, escapeHtml } from "../../packages/runtime/src/markdown";
export { createWorkbookAgentTools } from "../../packages/runtime/src/agentTools";
export { createWorkbookBashTool } from "../../packages/runtime/src/agentBashTool";
