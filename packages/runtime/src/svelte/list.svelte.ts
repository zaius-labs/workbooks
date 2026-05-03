/**
 * Persisted Svelte 5 list primitive — the durable counterpart to
 * `let items = $state<T[]>([])`.
 *
 *   const plugins = list<Plugin>("plugins");
 *
 *   plugins.list;                  // reactive read (Plugin[])
 *   plugins.upsert(p);             // dedup by p.id
 *   plugins.remove(id);            // by id, no-op if missing
 *   plugins.find(id);              // lookup
 *   plugins.replaceAll(next);      // bulk swap (reorder, etc)
 *
 * Records must carry a string `.id`. The collection uses it for
 * dedup-on-upsert and for `remove`. If your data doesn't have an id,
 * use `state<T[]>(...)` for whole-array LWW semantics instead.
 */

import {
  createCollection,
  type WbCollection,
  type WbCollectionOptions,
  type WbRecord,
} from "../storage/collection";

export interface ListOptions {
  doc?: string;
}

export class WbList<T extends WbRecord> {
  #raw = $state.raw<T[]>([]);
  #wb: WbCollection<T>;

  constructor(id: string, opts: ListOptions = {}) {
    const wbOpts: WbCollectionOptions = {};
    if (opts.doc !== undefined) wbOpts.doc = opts.doc;
    this.#wb = createCollection<T>(id, wbOpts);
    this.#raw = this.#wb.list;
    this.#wb.subscribe((next) => {
      this.#raw = next;
    });
  }

  /** Current items. Reactive — reads in $effect / $derived re-run on change. */
  get list(): T[] {
    return this.#raw;
  }

  /** Insert or replace by `record.id`. Concurrent upserts of the same
   *  id collapse to one record (last-write-wins on the body). */
  upsert(record: T): void {
    this.#wb.upsert(record);
  }

  /** Remove by id. No-op if not found. */
  remove(id: string): void {
    this.#wb.remove(id);
  }

  /** Lookup by id. Returns null if not found. */
  find(id: string): T | null {
    return this.#wb.find(id);
  }

  /** Replace the entire list in one commit. Use for reordering and
   *  bulk edit; the collection diffs internally. */
  replaceAll(records: T[]): void {
    this.#wb.replaceAll(records);
  }

  ready(): Promise<void> {
    return this.#wb.ready();
  }
}

export function list<T extends WbRecord>(id: string): WbList<T> {
  return new WbList<T>(id);
}
