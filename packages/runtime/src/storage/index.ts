/**
 * `wb.*` — author-facing storage SDK for workbooks.
 *
 * Three primitives, each backed by a Yjs shared type under the hood.
 * Authors don't see Yjs; they see "applied storage concepts":
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
 *   • `wb.tree(id)` — nested document trees. Out of scope; the
 *     Y.Map → Y.Map → … walker is straightforward but the reactive
 *     surface is deferred to a follow-up.
 *   • Pluggable backends. Phase 2 introduces a JSON-snapshot tier
 *     (smaller bundles for read-mostly workbooks); Phase 3 compiles
 *     out unused backends. Phase 1 is structural-only — no behavior
 *     change, no bundle savings yet.
 */

import { createText, type WbText, type WbTextOptions } from "./text";
import { createCollection, type WbCollection, type WbCollectionOptions, type WbRecord } from "./collection";
import { createValue, type WbValue, type WbValueOptions } from "./value";
import { secret, wbFetch } from "./secret";

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
  /** Workbook-scoped secrets — see ./secret.ts. Browser holds handles
   *  (ids), daemon holds values. */
  secret,
  /** Authenticated HTTPS via the daemon's proxy — `auth.secretId`
   *  resolves daemon-side; the page never sees the value. */
  fetch: wbFetch,
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

// Hydration gate — re-exported here so hosts that only consume the
// storage subpath (no Svelte components, no yjs sidecar) can still
// signal "WAL apply is done; seed-on-empty primitives may proceed."
export { markDocHydrated, awaitHydration } from "./bootstrap";

// Secrets API — daemon-mediated, OS-keychain-backed.
export { WbSecretError } from "./secret";
export type {
  WbSecretApi,
  WbFetchApi,
  WbFetchAuth,
  WbFetchRequest,
  WbFetchResponse,
} from "./secret";
