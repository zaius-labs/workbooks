/**
 * `@work.books/runtime/svelte` — Svelte 5 SDK for persisted runes.
 *
 * The promise here is simple: any `$state`-like declaration in a
 * Svelte 5 component can be made persistent by replacing it with one
 * of the wrappers in this module. Mutation flows automatically into
 * the workbook's Y.Doc, the substrate captures it as a WAL op, the
 * file rewrites itself on Cmd+S, and on the next load the same value
 * comes back.
 *
 *   // Before — lost on refresh:
 *   let count = $state(0);
 *
 *   // After — persisted in the .html file:
 *   const count = state("count", 0);
 *   count.value++;            // reactive, persisted
 *
 * The shape difference (`count` vs `count.value`) is unavoidable —
 * Svelte 5 runes are compiler-resolved and we can't return a bare
 * reactive variable from a function. Every wrapper exposes:
 *
 *   - `.value`           — Svelte-reactive read (works in $effect / $derived)
 *   - assigning `.value` — write (persists immediately)
 *   - `.ready()`         — promise that resolves once the Y.Doc binds
 *
 * Per-type primitives live in sibling files; this is the simplest one
 * (single value, JSON-serialized, last-write-wins).
 *
 * # Why class form
 *
 * `$state.raw` is only valid in (a) a `<script>` block, (b) a
 * `.svelte.{js,ts}` module, or (c) a class field. We use the class-field
 * form so we can return a constructed instance from a factory function.
 *
 * # Why this lives in the runtime package
 *
 * The wrapper directly imports `createValue` from `../storage/value`.
 * Co-locating with the underlying primitive keeps the two in sync
 * automatically; a separate package would have to re-publish on every
 * storage-layer change.
 */

import { createValue, type WbValueOptions } from "../storage/value";

export interface StateOptions<T> {
  /** Doc id this value belongs to (default: the first registered doc). */
  doc?: string;
  /** Default applied iff the underlying map key is missing on first read. */
  default?: T;
}

/**
 * Persisted Svelte 5 state primitive — the durable counterpart to
 * `let x = $state(initial)`.
 *
 *   const counter = new WbState<number>("counter", { default: 0 });
 *   $effect(() => console.log(counter.value));   // re-runs on remote change
 *   counter.value++;                              // persists
 *
 * Concurrent writes from multiple tabs / devices collapse to a single
 * value (last-write-wins via Y.Map.set). For per-element CRDT
 * semantics on collections, use `list()` / `map()` / `text()` instead.
 */
export class WbState<T> {
  // Svelte 5 reactive backing field. `$state.raw` skips deep tracking
  // (we replace the whole value on every change), which is what we
  // want for JSON-serialized scalars and arrays.
  #raw = $state.raw<T | undefined>(undefined);

  // Underlying CRDT-backed primitive. Owns the Y.Map binding,
  // doc bootstrap, and listener fan-out.
  #wb: ReturnType<typeof createValue<T>>;

  constructor(id: string, opts: StateOptions<T> = {}) {
    const wbOpts: WbValueOptions<T> = {};
    if (opts.doc !== undefined) wbOpts.doc = opts.doc;
    if (opts.default !== undefined) wbOpts.default = opts.default;
    this.#wb = createValue<T>(id, wbOpts);

    // Sync the initial cached value from wb (which holds the default
    // until the Y.Doc binds) into the rune. Subsequent updates flow
    // through .subscribe — this includes both the post-hydration
    // value swap AND remote writes from other tabs / collab peers.
    this.#raw = this.#wb.value;
    this.#wb.subscribe((next) => {
      this.#raw = next;
    });
  }

  /** Current value. Reactive — reads inside $effect / $derived re-run on change. */
  get value(): T | undefined {
    return this.#raw;
  }

  /** Replace the current value. Persists asynchronously to the Y.Doc;
   *  local read sees the update synchronously thanks to the subscribe
   *  callback firing with the new cached value. */
  set value(next: T) {
    this.#wb.set(next);
  }

  /** Resolves once the underlying Y.Doc is bound. Useful for tests
   *  and for code paths that must read post-hydration values
   *  synchronously. */
  ready(): Promise<void> {
    return this.#wb.ready();
  }
}

/**
 * Factory shorthand for `new WbState(...)`. Prefer this in component
 * code for symmetry with the other primitives (`list`, `map`, `text`).
 *
 *   const counter = state("counter", 0);
 *   const settings = state<Settings>("settings", { theme: "dark" });
 *
 * `id` is the persistence key — it's how this value finds itself again
 * on the next load. Keep it stable across versions of the workbook;
 * renaming is a migration.
 */
export function state<T>(id: string, defaultValue?: T): WbState<T> {
  return new WbState<T>(id, defaultValue !== undefined ? { default: defaultValue } : {});
}
