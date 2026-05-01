/**
 * `wb.text(id, opts)` — char-level merging string container.
 *
 * Backed by Loro's LoroText. Authors call `.set(html)`; we shrink the
 * common prefix + suffix between old + new and emit one delete + one
 * insert at the diverging region. Concurrent edits at non-overlapping
 * regions of a long string merge cleanly via Loro's RGA-flavored text
 * CRDT; concurrent edits at the SAME byte range still resolve
 * deterministically.
 *
 * The diff-shrink algorithm here was migrated from
 * apps/colorwave/src/lib/loroBackend.svelte.js's writeComposition;
 * keeping it inside the SDK means every workbook author gets the same
 * merge semantics for free.
 *
 * Reactivity: framework-agnostic. `.value` is a getter; `.subscribe(fn)`
 * fires every time the underlying LoroDoc commits (local + remote).
 * Svelte 5 consumers wrap the getter in `$state` if they want
 * fine-grained reactivity; vanilla consumers poll or subscribe.
 */

import { resolveDoc, type LoroDoc, type LoroText } from "./bootstrap";

export interface WbTextOptions {
  /** Doc id this text belongs to. Defaults to the first registered doc. */
  doc?: string;
  /** Initial value applied iff the LoroText is empty after hydration. */
  initial?: string;
}

export interface WbText {
  /** Current value (synchronous; "" until hydrated). */
  readonly value: string;
  /** Replace the entire string via diff-shrunk Loro ops + commit. */
  set(next: string): void;
  /** Subscribe to value changes. Fires once with the current value
   *  on registration so consumers don't need a separate "read initial"
   *  call. Returns an unsubscribe fn. */
  subscribe(fn: (value: string) => void): () => void;
  /** Resolves once the underlying LoroDoc is bound. */
  ready(): Promise<void>;
}

/** Compute the diverging region between two strings as
 *  {start, deleteLen, insertText} — strip common prefix + suffix.
 *  Replaces the most common edit shapes (full-string set, prepend,
 *  append, in-place patch) with one delete + one insert at the right
 *  position so concurrent edits to non-overlapping regions merge
 *  cleanly. */
function diffShrink(oldStr: string, newStr: string): {
  start: number;
  deleteLen: number;
  insertText: string;
} {
  const oldLen = oldStr.length;
  const newLen = newStr.length;
  let prefix = 0;
  const minLen = Math.min(oldLen, newLen);
  while (
    prefix < minLen &&
    oldStr.charCodeAt(prefix) === newStr.charCodeAt(prefix)
  ) {
    prefix++;
  }
  let suffix = 0;
  const maxSuffix = minLen - prefix;
  while (
    suffix < maxSuffix &&
    oldStr.charCodeAt(oldLen - 1 - suffix) ===
      newStr.charCodeAt(newLen - 1 - suffix)
  ) {
    suffix++;
  }
  return {
    start: prefix,
    deleteLen: oldLen - prefix - suffix,
    insertText: newStr.slice(prefix, newLen - suffix),
  };
}

export function createText(id: string, opts: WbTextOptions = {}): WbText {
  let cachedValue = "";
  let doc: LoroDoc | null = null;
  let text: LoroText | null = null;
  const listeners = new Set<(value: string) => void>();

  // Pending writes that fire before the doc resolves. We replay them
  // as a single set() once `text` is bound — preserves intent without
  // racing module-load against mount.
  let pendingWrite: string | null = null as string | null;

  const refresh = () => {
    if (!text) return;
    const next = text.toString();
    if (next === cachedValue) return;
    cachedValue = next;
    for (const fn of listeners) {
      try { fn(cachedValue); } catch (e) { console.warn("wb.text listener threw:", e); }
    }
  };

  function applySet(next: string) {
    if (!doc || !text) return;
    const cur = text.toString();
    if (cur === next) return;
    const { start, deleteLen, insertText } = diffShrink(cur, next);
    if (deleteLen > 0) text.delete(start, deleteLen);
    if (insertText.length > 0) text.insert(start, insertText);
    doc.commit();
    cachedValue = next;
    for (const fn of listeners) {
      try { fn(cachedValue); } catch (e) { console.warn("wb.text listener threw:", e); }
    }
  }

  const readyPromise = (async () => {
    doc = await resolveDoc(opts.doc ?? null);
    text = doc.getText(id);
    const hydratedValue = text.toString();

    // First-fire post-hydration: emit the loaded value to any
    // listeners registered before `ready()` resolved. Most callers
    // subscribe at construction time, so this is the call that
    // delivers their initial state. Skip if the value didn't change
    // (subscribe() already fired with `""` on register).
    if (hydratedValue !== cachedValue) {
      cachedValue = hydratedValue;
      for (const fn of listeners) {
        try { fn(cachedValue); } catch (e) { console.warn("wb.text listener threw:", e); }
      }
    }

    // Initial value applies only when the container is empty AND no
    // explicit set() arrived during boot. set() wins over initial.
    if (cachedValue.length === 0 && pendingWrite == null && opts.initial) {
      const init = String(opts.initial);
      if (init.length > 0) {
        text.insert(0, init);
        doc.commit();
        cachedValue = init;
        for (const fn of listeners) {
          try { fn(cachedValue); } catch (e) { console.warn("wb.text listener threw:", e); }
        }
      }
    }

    if (pendingWrite != null) {
      const target = pendingWrite;
      pendingWrite = null;
      applySet(target);
    }

    // Subscribe at the doc level — Loro's container-level subscribe is
    // optional in some bindings; the doc-level event always fires.
    doc.subscribe(() => refresh());
  })();
  readyPromise.catch((e) => {
    console.warn(`wb.text("${id}"): bootstrap failed:`, e);
  });

  return {
    get value() { return cachedValue; },
    set(next: string) {
      const target = String(next ?? "");
      if (!doc || !text) {
        pendingWrite = target;
        return;
      }
      applySet(target);
    },
    subscribe(fn) {
      listeners.add(fn);
      try { fn(cachedValue); } catch (e) { console.warn("wb.text listener threw:", e); }
      return () => { listeners.delete(fn); };
    },
    ready() { return readyPromise; },
  };
}
