// Demo bundle entry — re-exports just the non-Svelte parts of @workbook/runtime
// that the demo needs, so we can bundle to plain JS without dragging in
// Svelte components.
export { createRuntimeClient } from "../../../runtime/src/wasmBridge";
export { analyzeCell } from "../../../runtime/src/cellAnalyzer";
export { ReactiveExecutor } from "../../../runtime/src/reactiveExecutor";
export { createBrowserLlmClient } from "../../../runtime/src/llmClient";
export { runAgentLoop } from "../../../runtime/src/agentLoop";
export {
  mountHtmlWorkbook,
  parseWorkbookHtml,
  registerWorkbookCell,
} from "../../../runtime/src/htmlBindings";
export { renderMarkdown, escapeHtml } from "../../../runtime/src/markdown";
