/**
 * Authoring SDK barrel — all the components + hooks an author needs
 * to write a Svelte workbook declaratively.
 *
 *   import {
 *     WorkbookApp, Cell, Input, Output, Chart,
 *     useCell, useDAG, useRuntime, useExecutor,
 *   } from "@work.books/runtime";
 *
 * The package's main index.ts re-exports from here so authors don't
 * have to know about the subpath.
 *
 * NB: <Chart>, <Agent>, <Chat> ship in subsequent phases (B/D); their
 * imports below are commented until landed.
 */

export { default as WorkbookApp } from "./WorkbookApp.svelte";
export { default as Cell } from "./Cell.svelte";
export { default as Input } from "./Input.svelte";
export { default as Output } from "./Output.svelte";

// Persistent state primitives. These render hyphenated <wb-doc> /
// <wb-memory> custom elements internally (HTML spec requires custom
// elements to contain a hyphen) but authors only ever write the
// plain SDK names. State lives in the .html file —
// no IndexedDB, no localStorage, no browser cache.
export { default as Doc } from "./Doc.svelte";
export { default as Memory } from "./Memory.svelte";

// Phase A.5 — landing in the next commit.
// export { default as Chart } from "./Chart.svelte";

// Phase D — landing after Phase B.
// export { default as Agent } from "./Agent.svelte";
// export { default as Chat } from "./Chat.svelte";

export {
  useCell,
  useDAG,
  useRuntime,
  useExecutor,
  useDoc,
  useMemory,
  type MemoryHandle,
} from "./runes.svelte";

// Lower-level escape hatches. Authors typically don't need these —
// the hooks above are the supported entry points.
export {
  setAuthoringContext,
  getAuthoringContext,
  requireAuthoringContext,
  type AuthoringContext,
  type CellStatesMap,
} from "./context";
