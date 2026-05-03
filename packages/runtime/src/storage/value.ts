/**
 * `wb.value(id, opts)` — single object/scalar with last-write-wins.
 *
 * Backed by a Y.Map with one well-known key ("v"). Why Y.Map over
 * a single-element Y.Array: Y.Map's set/delete semantics are cleaner
 * for "replace this whole value" without the array-CRDT's concurrent-
 * insert duplication risk. A Y.Array of length 1 would sometimes end
 * up as length 2 after a concurrent fork — Y.Map.set collapses
 * concurrent writes to a single key deterministically.
 *
 * Storage shape: JSON-encoded payload under `map.set("v", json)`. The
 * SDK handles encode/decode; authors deal in plain JS values. Default
 * applies iff the map key is missing on first read (analogous to the
 * `initial` option on wb.text but for whole-object scalars).
 *
 * Reactivity: same shape as wb.text — `.value` is a getter,
 * `.subscribe(fn)` fires on commit, fires once with current on register.
 */

import { resolveDoc, Y } from "./bootstrap";

const VALUE_KEY = "v";

export interface WbValueOptions<T> {
  /** Doc id this value belongs to. Defaults to the first doc. */
  doc?: string;
  /** Default value applied iff the map key is missing on first read. */
  default?: T;
}

export interface WbValue<T = unknown> {
  /** Current value (synchronous; returns the default until hydrated). */
  readonly value: T | undefined;
  /** Replace the entire value. JSON-encoded under one map key. */
  set(next: T): void;
  /** Subscribe to changes. Returns unsubscribe. Fires once with current. */
  subscribe(fn: (value: T | undefined) => void): () => void;
  /** Resolves once the underlying Y.Doc is bound. */
  ready(): Promise<void>;
}

export function createValue<T = unknown>(
  id: string,
  opts: WbValueOptions<T> = {},
): WbValue<T> {
  let doc: Y.Doc | null = null;
  let map: Y.Map<unknown> | null = null;
  let cached: T | undefined = opts.default;
  const listeners = new Set<(value: T | undefined) => void>();
  // Pre-mount writes that fire before the doc resolves. We replay
  // them as a single set() once `map` is bound. Typed loosely so
  // the closure-narrowing optimizer keeps the union after assignments
  // from outside the readyPromise body.
  let pendingWrite: { value: T } | null = null as { value: T } | null;

  function readFromMap(m: Y.Map<unknown>): T | undefined {
    const raw = m.get(VALUE_KEY);
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "string") {
      // Earlier versions might have set non-string values; tolerate.
      return raw as T;
    }
    try { return JSON.parse(raw) as T; } catch { return undefined; }
  }

  const notify = () => {
    for (const fn of listeners) {
      try { fn(cached); } catch (e) { console.warn("wb.value listener threw:", e); }
    }
  };

  const refresh = () => {
    if (!map) return;
    const next = readFromMap(map);
    if (next === undefined) return;
    cached = next;
    notify();
  };

  function applySet(next: T) {
    if (!doc || !map) return;
    doc.transact(() => { map!.set(VALUE_KEY, JSON.stringify(next)); });
    cached = next;
    notify();
  }

  const readyPromise = (async () => {
    doc = await resolveDoc(opts.doc ?? null);
    map = doc.getMap<unknown>(id);
    const stored = readFromMap(map);
    if (stored !== undefined) {
      cached = stored;
      notify();
    } else if (opts.default !== undefined && pendingWrite == null) {
      // Materialize the default into the map so subsequent reads see
      // it consistently. This mirrors wb.text's `initial` behavior.
      doc.transact(() => { map!.set(VALUE_KEY, JSON.stringify(opts.default)); });
      cached = opts.default;
      notify();
    }

    const queued: { value: T } | null = pendingWrite;
    if (queued) {
      pendingWrite = null;
      applySet(queued.value);
    }

    map.observe(() => refresh());
  })();
  readyPromise.catch((e) => {
    console.warn(`wb.value("${id}"): bootstrap failed:`, e);
  });

  return {
    get value() { return cached; },
    set(next: T) {
      if (!doc || !map) {
        pendingWrite = { value: next };
        cached = next;
        notify();
        return;
      }
      applySet(next);
    },
    subscribe(fn) {
      listeners.add(fn);
      try { fn(cached); } catch (e) { console.warn("wb.value listener threw:", e); }
      return () => { listeners.delete(fn); };
    },
    ready() { return readyPromise; },
  };
}
