/**
 * `wb.*` — author-facing storage SDK for workbooks.
 *
 * Three primitives, each backed by a Loro CRDT container under the
 * hood. Authors don't see Loro; they see "applied storage concepts":
 *
 *   wb.text(id, opts)        char-level merge (prose, source code)
 *   wb.collection(id, opts)  whole-record-replace list, keyed by .id
 *   wb.value(id, opts)       single object/scalar, last-write-wins
 *
 * All three primitives share a common contract:
 *
 *   • `.value` (or `.list`) is a synchronous getter for the current
 *     snapshot; safe to read before mount finishes (returns "" / [] /
 *     `default` until the doc resolves).
 *   • `.subscribe(fn)` registers a listener; fires once with the
 *     current value on registration so consumers don't need a
 *     separate "read initial" call. Returns an unsubscribe fn.
 *   • Mutations call `doc.commit()` so the host's autosave layer
 *     (which subscribes to local commits → IDB / disk) sees the
 *     change. The SDK never schedules its own persistence.
 *   • Pre-mount writes are queued and replayed once the doc resolves.
 *
 * What's NOT here yet:
 *   • `wb.tree(id)` — nested document trees. Out of scope for Phase 1;
 *     the Loro Map → Map → … walker exists in loroSidecar but the
 *     reactive surface is deferred to a follow-up.
 *   • Pluggable backends. Phase 2 introduces a JSON-snapshot tier
 *     (smaller bundles for read-mostly workbooks); Phase 3 compiles
 *     out unused backends. Phase 1 is structural-only — no behavior
 *     change, no bundle savings yet.
 */

import { createText, type WbText, type WbTextOptions } from "./text";
import { createCollection, type WbCollection, type WbCollectionOptions, type WbRecord } from "./collection";
import { createValue, type WbValue, type WbValueOptions } from "./value";

export const wb = {
  text(id: string, opts?: WbTextOptions): WbText {
    return createText(id, opts);
  },
  collection<T extends WbRecord = WbRecord>(
    id: string,
    opts?: WbCollectionOptions,
  ): WbCollection<T> {
    return createCollection<T>(id, opts);
  },
  value<T = unknown>(id: string, opts?: WbValueOptions<T>): WbValue<T> {
    return createValue<T>(id, opts);
  },
  // TODO(Phase 1+): wb.tree(id) for nested document trees.
};

export type {
  WbText,
  WbTextOptions,
  WbCollection,
  WbCollectionOptions,
  WbRecord,
  WbValue,
  WbValueOptions,
};
