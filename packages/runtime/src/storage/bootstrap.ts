/**
 * Internal Loro doc bootstrap for the wb.* storage SDK.
 *
 * Resolves a raw `LoroDoc` registered by the workbook runtime via the
 * `<wb-doc id="...">` element. Authors don't see this — they interact
 * with `wb.text`, `wb.collection`, `wb.value`. The bootstrap is what
 * keeps those primitives framework-agnostic: each primitive awaits a
 * doc handle here, then operates on it through Loro's container APIs.
 *
 * Design rule: every mutation MUST call `doc.commit()` so the host's
 * autosave layer (which subscribes to local commits and writes a
 * snapshot back to IDB / disk) sees the change. The SDK never reaches
 * past the doc to schedule its own persistence.
 *
 * Default doc id: when an author calls `wb.text("composition")` without
 * specifying a doc, the caller must register at least one `<wb-doc>`
 * AND pass an explicit doc id, OR the runtime must expose
 * `__wbRuntime.listDocIds`. Single-doc workbooks (today's common case)
 * register one doc; the SDK probes a small set of conventional ids
 * before failing. Multi-doc workbooks pass `{ doc: "explicit-id" }`.
 */

// Subset of the loro-crdt JS API we depend on. Mirrors loroSidecar.ts
// but adds container subscription primitives we need for the reactive
// layer.
export interface LoroSubscription {
  (): void;
}
export interface LoroEvent {
  by?: "local" | "import" | "checkout";
  origin?: string;
  events?: unknown;
}
export interface LoroText {
  insert(index: number, text: string): void;
  delete(index: number, count: number): void;
  toString(): string;
  subscribe?(cb: (ev: LoroEvent) => void): LoroSubscription;
}
export interface LoroList {
  push(value: unknown): void;
  insert(index: number, value: unknown): void;
  delete(index: number, count: number): void;
  get(index: number): unknown;
  toArray(): unknown[];
  readonly length: number;
  subscribe?(cb: (ev: LoroEvent) => void): LoroSubscription;
}
export interface LoroMap {
  set(key: string, value: unknown): void;
  delete(key: string): void;
  get(key: string): unknown;
  subscribe?(cb: (ev: LoroEvent) => void): LoroSubscription;
}
export interface LoroDoc {
  getText(name: string): LoroText;
  getList(name: string): LoroList;
  getMap(name: string): LoroMap;
  commit(): void;
  subscribe(cb: (ev: LoroEvent) => void): LoroSubscription;
}

interface LoroDocHandle {
  inner(): LoroDoc;
}
interface RuntimeApi {
  getDocHandle?: (id: string) => LoroDocHandle | undefined;
  /** Optional — runtime may expose registered ids; not relied on. */
  listDocIds?: () => string[];
}

const POLL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 25;

// Cache resolved docs by id so repeated wb.text("composition") calls
// from across the codebase share one LoroDoc reference.
const docCache = new Map<string, Promise<LoroDoc>>();

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

/**
 * Resolve a `LoroDoc` for the given doc id. Pass `null` to resolve
 * "the default doc" — the first one registered by the runtime
 * (introspected via listDocIds when available).
 *
 * Idempotent — once resolved, subsequent calls reuse the cached doc.
 * Polls `window.__wbRuntime.getDocHandle` so callers that fire BEFORE
 * `mountHtmlWorkbook` finishes don't drop their requests on the floor.
 */
export function resolveDoc(docId: string | null = null): Promise<LoroDoc> {
  const cacheKey = docId ?? "__default__";
  const cached = docCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const start = Date.now();
    while (Date.now() - start < POLL_TIMEOUT_MS) {
      const rt = getRuntime();
      if (rt && typeof rt.getDocHandle === "function") {
        // Resolve the actual id we'll fetch a handle for.
        const id = docId ?? findFirstDocId(rt);

        if (id != null) {
          const handle = rt.getDocHandle(id);
          if (handle && typeof handle.inner === "function") {
            return handle.inner();
          }
        }
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    docCache.delete(cacheKey);
    throw new Error(
      `wb.* storage: timed out (${POLL_TIMEOUT_MS}ms) waiting for ` +
      `<wb-doc${docId ? ` id="${docId}"` : ""}> to register. Make sure ` +
      `your HTML contains a <wb-workbook><wb-doc format="loro" /></wb-workbook> ` +
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
export function __setTestDoc(id: string | null, doc: LoroDoc): void {
  const cacheKey = id ?? "__default__";
  docCache.set(cacheKey, Promise.resolve(doc));
}

/** Test-only: clear the doc cache. */
export function __clearTestDocs(): void {
  docCache.clear();
}
