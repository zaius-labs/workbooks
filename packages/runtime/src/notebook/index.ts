/**
 * Notebook SDK — standardized chrome for notebook-shaped workbooks.
 *
 * Default DX: import <Notebook> + <NotebookToolbar>, fenced code blocks
 * in your .svx become <NotebookCell>s automatically (via the CLI's
 * remarkWorkbookCells plugin). You get play buttons, Run All, status
 * indicators, output rendering — without writing any chrome code.
 *
 * Override DX: any of these can be replaced. Build your own gutter
 * by calling `getNotebookContext()` and reading state directly. The
 * <Notebook> wrapper is the only required piece (it owns the
 * executor); everything else is opt-in.
 */

export { default as Notebook } from "./Notebook.svelte";
export { default as NotebookCell } from "./NotebookCell.svelte";
export { default as NotebookToolbar } from "./NotebookToolbar.svelte";
export { getNotebookContext, setNotebookContext } from "./context";
export type { NotebookApi } from "./context";
export { renderCellOutput } from "./renderOutput";
