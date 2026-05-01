/**
 * Internal Y.Doc bootstrap for the wb.* storage SDK.
 *
 * Resolves a `Y.Doc` registered by the workbook runtime via the
 * `<wb-doc id="..." format="yjs">` element. Authors don't see this — they
 * interact with `wb.text`, `wb.collection`, `wb.value`. The bootstrap is
 * what keeps those primitives framework-agnostic: each primitive awaits a
 * doc handle here, then operates on it through Yjs's shared-type APIs.
 *
 * Design rule: every mutation goes through `doc.transact(...)` so observers
 * fire and the host's autosave layer (subscribed via `updateV2`) sees the
 * change as a single op.
 *
 * Default doc id: when an author calls `wb.text("composition")` without
 * specifying a doc, the runtime must expose `__wbRuntime.listDocIds`
 * (workbookDocResolver registers all <wb-doc> ids). The SDK picks the
 * first registered id. Multi-doc workbooks pass `{ doc: "explicit-id" }`.
 *
 * Backend swap (Phase 2): this file used to wrap a `LoroDoc`. The SDK
 * surface above (wb.text/collection/value) is unchanged; only the
 * underlying CRDT engine changed from Loro to Yjs.
 */

import * as Y from "yjs";

interface YDocHandleLike {
  /** Yjs Doc instance — the runtime stores this directly. */
  doc?: Y.Doc;
  /** Compatibility accessor used by older callers. */
  inner?: () => Y.Doc;
}
interface RuntimeApi {
  getDocHandle?: (id: string) => YDocHandleLike | undefined;
  /** Optional — runtime may expose registered ids; not relied on. */
  listDocIds?: () => string[];
}

const POLL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 25;

// Cache resolved docs by id so repeated wb.text("composition") calls
// from across the codebase share one Y.Doc reference.
const docCache = new Map<string, Promise<Y.Doc>>();

function getRuntime(): RuntimeApi | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & { __wbRuntime?: RuntimeApi };
  return w.__wbRuntime ?? null;
}

/** Try to find any already-registered doc id via runtime introspection.
 *  Returns the first id, or null if listDocIds isn't exposed. */
function findFirstDocId(rt: RuntimeApi): string | null {
  if (typeof rt.listDocIds === "function") {
    try {
      const ids = rt.listDocIds();
      if (Array.isArray(ids) && ids.length > 0 && typeof ids[0] === "string") {
        return ids[0];
      }
    } catch { /* ignore */ }
  }
  return null;
}

function unwrap(handle: YDocHandleLike | undefined): Y.Doc | null {
  if (!handle) return null;
  if (handle.doc instanceof Y.Doc) return handle.doc;
  if (typeof handle.inner === "function") {
    const inner = handle.inner();
    if (inner instanceof Y.Doc) return inner;
  }
  return null;
}

/**
 * Synchronous variant of {@link resolveDoc}. Returns the cached or
 * already-registered Y.Doc, or `null` if the runtime hasn't bound it
 * yet. Use this only inside contexts that guarantee the doc is bound
 * — e.g. children of `<WorkbookReady>` boundary, or after a
 * `await wb.ready()` gate.
 *
 * Why this exists: SyncedStore (the backing for `wb.app`) needs the
 * Y.Doc at construction time. We can't .await inside a Svelte 5
 * `$state.raw` class field declaration. The boundary component
 * pattern lets the SDK stay synchronous inside the boundary.
 */
export function resolveDocSync(docId: string | null = null): Y.Doc | null {
  // Fast path: already-resolved promise's value
  // (Promises don't expose a sync "is fulfilled" check, so we look at
  // the runtime directly each time. Resolution is cheap once mounted.)
  const rt = getRuntime();
  if (!rt || typeof rt.getDocHandle !== "function") return null;
  const id = docId ?? findFirstDocId(rt);
  if (id == null) return null;
  return unwrap(rt.getDocHandle(id));
}

/**
 * Resolve a `Y.Doc` for the given doc id. Pass `null` to resolve
 * "the default doc" — the first one registered by the runtime
 * (introspected via listDocIds when available).
 *
 * Idempotent — once resolved, subsequent calls reuse the cached doc.
 * Polls `window.__wbRuntime.getDocHandle` so callers that fire BEFORE
 * `mountHtmlWorkbook` finishes don't drop their requests on the floor.
 */
export function resolveDoc(docId: string | null = null): Promise<Y.Doc> {
  const cacheKey = docId ?? "__default__";
  const cached = docCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const start = Date.now();
    while (Date.now() - start < POLL_TIMEOUT_MS) {
      const rt = getRuntime();
      if (rt && typeof rt.getDocHandle === "function") {
        const id = docId ?? findFirstDocId(rt);
        if (id != null) {
          const handle = rt.getDocHandle(id);
          const inner = unwrap(handle);
          if (inner) return inner;
        }
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    docCache.delete(cacheKey);
    throw new Error(
      `wb.* storage: timed out (${POLL_TIMEOUT_MS}ms) waiting for ` +
      `<wb-doc${docId ? ` id="${docId}"` : ""}> to register. Make sure ` +
      `your HTML contains a <wb-workbook><wb-doc format="yjs" /></wb-workbook> ` +
      `and that mountHtmlWorkbook(...) has been called.`,
    );
  })();

  promise.catch(() => { docCache.delete(cacheKey); });
  docCache.set(cacheKey, promise);
  return promise;
}

/**
 * Test-only: synchronously inject a doc handle. Used by unit tests
 * that don't run the full mount path.
 */
export function __setTestDoc(id: string | null, doc: Y.Doc): void {
  const cacheKey = id ?? "__default__";
  docCache.set(cacheKey, Promise.resolve(doc));
}

/** Test-only: clear the doc cache. */
export function __clearTestDocs(): void {
  docCache.clear();
}

// Re-export Y so primitive modules can construct shared types directly.
export { Y };
