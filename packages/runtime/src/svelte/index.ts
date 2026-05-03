/**
 * `@work.books/runtime/svelte` — Svelte 5 SDK for persisted runes.
 *
 * Drop-in replacements for `$state` that round-trip through the
 * workbook's Y.Doc and substrate. Every mutation persists to the
 * `.html` file on the next commit; every reload restores
 * the same state.
 *
 *   import { state, list, text } from "@work.books/runtime/svelte";
 *
 *   // Single value (any JSON-serializable). Whole-value LWW.
 *   const counter = state("counter", 0);
 *
 *   // Record list, dedup-by-id. Concurrent upserts merge cleanly.
 *   const plugins = list<Plugin>("plugins");
 *
 *   // Long string with per-character merge (good for big text bodies).
 *   const composition = text("composition", "<html>...");
 *
 * All three return small class instances. Reads via `.value` / `.list`
 * are Svelte-reactive (work in $effect, $derived, template bindings).
 *
 * # Picking between them
 *
 * | use case                              | use         |
 * | ------------------------------------- | ----------- |
 * | scalar (number, bool, settings dict)  | state()     |
 * | array of records with stable .id      | list()      |
 * | long string, multi-tab edits          | text()      |
 *
 * If you're not sure, start with `state()`. It works for arrays and
 * objects too — the only downside vs the specialized primitives is
 * concurrent merge semantics, which most apps never hit.
 */

export { state, WbState } from "./state.svelte";
export type { StateOptions } from "./state.svelte";

export { list, WbList } from "./list.svelte";
export type { ListOptions } from "./list.svelte";

export { text, WbTextState } from "./text.svelte";
export type { TextOptions } from "./text.svelte";

export { app, docOf } from "./app.svelte";
export type { AppOptions } from "./app.svelte";

export { undo, WbUndo } from "./undo.svelte";
export type { UndoOptions } from "./undo.svelte";

export { default as WorkbookReady } from "./WorkbookReady.svelte";
