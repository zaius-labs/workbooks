/**
 * `wb.collection(id, opts)` — whole-record-replace list keyed by `.id`.
 *
 * Backed by a LoroList of JSON-encoded records. Authors think in terms
 * of "list of things" — upsert by id, remove by id, find by id. The
 * SDK handles JSON marshaling, dedup-by-id on upsert, and reactive
 * reads.
 *
 * Why JSON-strings inside a list (vs LoroMap-of-Maps):
 *   - matches the existing color.wave wire format byte-for-byte; no
 *     migration needed when this SDK lands.
 *   - record IDs are author-defined strings; LoroList of JSON strings
 *     gives stable iteration order and trivial replaceAll semantics.
 *   - concurrent forks merge as list-CRDT operations; dedup-on-read
 *     collapses any duplicate entries that survive a merge.
 *
 * Reactivity: same shape as wb.text — `.list` is a getter (current
 * snapshot, reactive via subscribe), `.subscribe(fn)` fires on every
 * commit. Svelte 5 consumers wrap with `$state` for fine-grained tracking.
 */

import { resolveDoc, type LoroDoc, type LoroList } from "./bootstrap";

export interface WbRecord {
  id: string;
  // Records can carry any other fields; SDK doesn't constrain shape.
}

export interface WbCollectionOptions {
  /** Doc id this collection belongs to. Defaults to the first doc. */
  doc?: string;
}

export interface WbCollection<T extends WbRecord = WbRecord> {
  /** Current array snapshot (reactive — re-read after subscribe). */
  readonly list: T[];
  /** Replace by id (record MUST have .id). Dedupes on insert. */
  upsert(record: T): void;
  /** Remove by id. No-op if not found. */
  remove(id: string): void;
  /** Lookup by id. Returns null if not found. */
  find(id: string): T | null;
  /** Replace the entire list in one commit. */
  replaceAll(records: T[]): void;
  /** Subscribe to list changes. Returns unsubscribe. Fires once with
   *  the current snapshot on registration. */
  subscribe(fn: (list: T[]) => void): () => void;
  /** Resolves once the underlying LoroDoc is bound. */
  ready(): Promise<void>;
}

interface PendingOp<T extends WbRecord> {
  kind: "upsert" | "remove" | "replaceAll";
  record?: T;
  id?: string;
  records?: T[];
}

export function createCollection<T extends WbRecord = WbRecord>(
  id: string,
  opts: WbCollectionOptions = {},
): WbCollection<T> {
  let doc: LoroDoc | null = null;
  let list: LoroList | null = null;
  let cached: T[] = [];
  const listeners = new Set<(value: T[]) => void>();
  const pending: PendingOp<T>[] = [];

  function readFromList(l: LoroList): T[] {
    const out: T[] = [];
    const seen = new Map<string, number>();
    for (const v of l.toArray()) {
      if (typeof v !== "string") continue;
      try {
        const parsed = JSON.parse(v) as T;
        if (!parsed || typeof parsed !== "object") continue;
        if (typeof parsed.id !== "string" || !parsed.id) continue;
        const prevIdx = seen.get(parsed.id);
        if (prevIdx === undefined) {
          seen.set(parsed.id, out.length);
          out.push(parsed);
        } else {
          // Last-write-wins on duplicates (matches the legacy
          // _hydrateFromDoc collapse pattern).
          out[prevIdx] = parsed;
        }
      } catch { /* skip */ }
    }
    return out;
  }

  const notify = () => {
    for (const fn of listeners) {
      try { fn(cached); } catch (e) { console.warn("wb.collection listener threw:", e); }
    }
  };

  const refresh = () => {
    if (!list) return;
    cached = readFromList(list);
    notify();
  };

  function rebuild(next: T[]) {
    if (!doc || !list) return;
    if (list.length > 0) list.delete(0, list.length);
    for (const r of next) list.push(JSON.stringify(r));
    doc.commit();
    cached = next;
    notify();
  }

  function applyUpsert(record: T) {
    if (!record || typeof record !== "object" || typeof record.id !== "string" || !record.id) {
      throw new Error("wb.collection.upsert: record must have a string `id`");
    }
    // Filter-then-rebuild — preserves the dedup semantics of color.wave's
    // legacy _persist path, and keeps record order stable (existing
    // entries stay in place; new entries append).
    const next = cached.filter((r) => r.id !== record.id);
    next.push(record);
    rebuild(next);
  }

  function applyRemove(targetId: string) {
    const next = cached.filter((r) => r.id !== targetId);
    if (next.length === cached.length) return;
    rebuild(next);
  }

  function applyReplaceAll(records: T[]) {
    rebuild(records.slice());
  }

  const readyPromise = (async () => {
    doc = await resolveDoc(opts.doc ?? null);
    list = doc.getList(id);
    const hydrated = readFromList(list);

    // First-fire post-hydration: emit the loaded snapshot to any
    // listeners registered before `ready()` resolved. Skip if nothing
    // changed (subscribe() already fired with []).
    if (hydrated.length > 0 || cached.length > 0) {
      cached = hydrated;
      notify();
    }

    // Drain any operations queued before the doc resolved.
    while (pending.length > 0) {
      const op = pending.shift()!;
      if (op.kind === "upsert" && op.record) applyUpsert(op.record);
      else if (op.kind === "remove" && op.id) applyRemove(op.id);
      else if (op.kind === "replaceAll" && op.records) applyReplaceAll(op.records);
    }

    doc.subscribe(() => refresh());
  })();
  readyPromise.catch((e) => {
    console.warn(`wb.collection("${id}"): bootstrap failed:`, e);
  });

  return {
    get list() { return cached; },
    upsert(record: T) {
      if (!doc || !list) {
        pending.push({ kind: "upsert", record });
        // Optimistic local update so .find() right after .upsert()
        // returns the new record without waiting for the doc.
        if (record && typeof record.id === "string" && record.id) {
          const next = cached.filter((r) => r.id !== record.id);
          next.push(record);
          cached = next;
          notify();
        }
        return;
      }
      applyUpsert(record);
    },
    remove(targetId: string) {
      if (!doc || !list) {
        pending.push({ kind: "remove", id: targetId });
        const next = cached.filter((r) => r.id !== targetId);
        if (next.length !== cached.length) {
          cached = next;
          notify();
        }
        return;
      }
      applyRemove(targetId);
    },
    find(targetId: string): T | null {
      return cached.find((r) => r.id === targetId) ?? null;
    },
    replaceAll(records: T[]) {
      if (!doc || !list) {
        pending.push({ kind: "replaceAll", records: records.slice() });
        cached = records.slice();
        notify();
        return;
      }
      applyReplaceAll(records);
    },
    subscribe(fn) {
      listeners.add(fn);
      try { fn(cached); } catch (e) { console.warn("wb.collection listener threw:", e); }
      return () => { listeners.delete(fn); };
    },
    ready() { return readyPromise; },
  };
}
