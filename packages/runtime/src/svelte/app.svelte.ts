/**
 * `wb.app()` — the persistent app-state primitive for Svelte 5 workbooks.
 *
 * Backed by [SyncedStore] (which itself sits on Y.Doc), so reads and
 * writes look like plain JS but persist through the substrate to the
 * `.workbook.html` file.
 *
 *   <script>
 *     const app = wb.app({
 *       count:    0,
 *       user:     { name: "alice", theme: "dark" },
 *       todos:    [] as Todo[],
 *     });
 *   </script>
 *
 *   <button onclick={() => app.count++}>{app.count}</button>
 *   <input bind:value={app.user.name} />
 *   {#each app.todos as todo}<li>{todo.text}</li>{/each}
 *
 * Nested objects become Y.Maps. Arrays become Y.Arrays. Strings can
 * become Y.Texts (with the right shape — see SyncedStore docs for
 * box/text discrimination).
 *
 * Concurrent edits from multiple tabs / devices merge via Yjs CRDT
 * semantics. Y.UndoManager is exposed via `wb.undo` (see ./undo.svelte.ts).
 *
 * # Why `<WorkbookReady>` is required around this
 *
 * SyncedStore needs the Y.Doc up front — it can't lazy-bind. The
 * Y.Doc itself is registered async by the workbook runtime (after
 * the spec block parses + `<wb-doc>` mounts). Wrapping your tree in
 * `<WorkbookReady>` guarantees the doc is bound before any
 * `wb.app()` call runs, so the SDK can stay synchronous.
 *
 * Without the boundary you'd see a flash of default state on cold
 * load, plus a non-trivial chance of writes-before-bind being lost.
 *
 * [SyncedStore]: https://syncedstore.org/
 */

import { syncedStore, observeDeep, getYjsDoc, getYjsValue, Y } from "@syncedstore/core";
import { resolveDocSync } from "../storage/bootstrap";

export interface AppOptions {
  /** Doc id this app belongs to. Defaults to the first registered doc. */
  doc?: string;
}

/**
 * Create a persistent reactive store from a shape declaration. Reads
 * inside `$effect` / `$derived` / templates register dependencies and
 * re-run on any nested change. Mutations propagate to Y.Doc.
 *
 *   const app = wb.app({ count: 0, todos: [] });
 *   app.count++;             // persisted
 *   app.todos.push({ ... }); // persisted
 *
 * Defaults are applied iff the underlying Y.Map / Y.Array is empty
 * after hydration. Existing user state always wins. This mirrors the
 * `initial` semantics on `wb.text` and `wb.value`.
 *
 * Lazy by default — safe to call at module load (e.g. in a singleton
 * `export const layout = new LayoutStore()`). The Proxy returned here
 * defers the underlying SyncedStore + Y.Doc binding to the first
 * read or write, which always happens during a Svelte component
 * render. Bundlers like vite-plugin-singlefile flatten dynamic
 * imports into the main chunk, so module-level singletons can run
 * before the host's runtime mount; this keeps wb.app() compatible
 * with that order.
 *
 * If a Y.Doc still isn't bound at first access, the Proxy throws
 * with a clear message — at that point the bug is real (missing
 * <wb-doc>, or runtime mount never ran), not a timing race. Wrap in
 * <WorkbookReady> if you want the throw to never surface to users.
 */
export function app<T extends Record<string, any>>(
  shape: T,
  opts: AppOptions = {},
): T {
  // Lazy holders. Materialized on first prop access.
  let store: any = null;
  let reactor: Reactor | null = null;

  const ensure = () => {
    if (store) return;
    const doc = resolveDocSync(opts.doc ?? null);
    if (!doc) {
      throw new Error(
        "wb.app() accessed before the workbook Y.Doc was bound. " +
        "Either wrap your component tree in <WorkbookReady>, or make " +
        "sure mountHtmlWorkbook(...) has run before any read/write.",
      );
    }

    // Build the shape descriptor SyncedStore needs. The library reads
    // from the input shape's *types* (array vs object vs xml) to pick
    // Y.Array vs Y.Map vs Y.XmlFragment. Plain primitives at the leaves
    // of objects are stored as Y.Map values.
    store = syncedStore(shape as any, doc);

    // Apply defaults — only on properties that don't yet exist in the
    // underlying Y types. SyncedStore creates Y.Maps/Arrays/etc. on
    // first access; we walk the input shape and seed each top-level key.
    for (const [key, value] of Object.entries(shape)) {
      const yValue = getYjsValue((store as any)[key]);
      if (yValue instanceof Y.Map && yValue.size === 0 && value && typeof value === "object" && !Array.isArray(value)) {
        doc.transact(() => {
          for (const [k, v] of Object.entries(value)) {
            (store as any)[key][k] = v;
          }
        });
      } else if (yValue instanceof Y.Array && yValue.length === 0 && Array.isArray(value) && value.length > 0) {
        doc.transact(() => {
          (store as any)[key].push(...value);
        });
      }
      // Y.Text seeding handled at the wb.text() layer; primitives are
      // map values stored in the parent — already handled above.
    }

    // Svelte reactivity bridge: a $state.raw counter that bumps on
    // every observed mutation. Reads through this counter inside
    // Svelte reactive contexts register the dep; mutations cause
    // re-runs.
    reactor = new Reactor();
    observeDeep(store, () => reactor!.bump());
  };

  // Outer Proxy. Each operation lazily materializes the store, then
  // delegates. The reactor read fires inside Svelte's reactive scope
  // (component render / $effect / $derived), so deps register
  // correctly the first time the store is touched from there.
  return new Proxy({} as any, {
    get(_target, prop) {
      ensure();
      reactor!.read();
      return Reflect.get(store, prop);
    },
    set(_target, prop, value) {
      ensure();
      return Reflect.set(store, prop, value);
    },
    has(_target, prop) {
      ensure();
      return Reflect.has(store, prop);
    },
    deleteProperty(_target, prop) {
      ensure();
      return Reflect.deleteProperty(store, prop);
    },
    ownKeys(_target) {
      ensure();
      reactor!.read();
      return Reflect.ownKeys(store);
    },
    getOwnPropertyDescriptor(_target, prop) {
      ensure();
      return Reflect.getOwnPropertyDescriptor(store, prop);
    },
  }) as T;
}

/**
 * Tiny class wrapping a single $state.raw counter. Class form is
 * required because $state.raw can only appear in class fields,
 * <script> blocks, or .svelte.{js,ts} files (this file qualifies).
 */
class Reactor {
  #version = $state.raw(0);

  read(): void {
    // Force Svelte to register a dependency on #version inside any
    // reactive context that calls this. Just touching the value via
    // the getter is enough; the rune compiler picks it up.
    void this.#version;
  }

  bump(): void {
    this.#version++;
  }
}

/** Direct access to the underlying Y.Doc, e.g. for advanced use:
 *   - hooking Y.UndoManager
 *   - subscribing to doc.on('updateV2', ...)
 *   - reading doc.clientID for awareness
 *   - encoding state for export */
export function docOf<T>(store: T): Y.Doc {
  return getYjsDoc(store);
}

/** Direct access to the underlying Y type for a leaf value. Use
 *  sparingly — most authoring should treat the Proxy as plain JS. */
export function yjsValueOf(value: unknown): Y.Doc | Y.AbstractType<any> | undefined {
  return getYjsValue(value);
}
