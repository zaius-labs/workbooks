/**
 * Model artifact resolver (P4.2).
 *
 * ML model weights are large (10s to 100s of MB) and immutable once
 * published. We don't want to refetch them on every page load — and we
 * can't bundle them inline (>5 MB gzipped per file would dwarf the runtime
 * itself).
 *
 * This resolver is a **content-addressed, IndexedDB-backed cache** in front
 * of an HTTP fetch. Workbooks reference models by sha256:
 *
 *   { kind: "candle-inference", model: { sha256: "abc…", url: "https://…" } }
 *
 * On first load: fetch URL → verify sha256 → store in IndexedDB → return
 * bytes. On second load: read from IndexedDB → verify sha256 → return.
 * No network round trip, no model identity drift.
 *
 * Storage budget: browsers grant ~50% of available disk to origin storage.
 * Workbooks that exceed budget hit QuotaExceededError; the resolver falls
 * back to fetch-without-caching for that artifact.
 *
 * Status: P4.2 baseline. Eviction policy (LRU with a workbook-declared
 * budget) deferred to a follow-up — for now, manual `evict()` and
 * `clear()` operations are exposed.
 */

const DB_NAME = "@workbook/runtime/model-artifacts";
const DB_VERSION = 1;
const STORE_NAME = "artifacts";

export interface ArtifactRef {
  /** sha256 hex string. The cache key. */
  sha256: string;
  /** Origin to fetch from on cache miss. */
  url: string;
  /** Optional human-readable label (logging, errors). */
  name?: string;
  /** Optional expected byte length (used for upfront QuotaExceeded checks). */
  bytes?: number;
}

export interface ResolvedArtifact {
  sha256: string;
  bytes: Uint8Array;
  /** True if served from IndexedDB; false if fetched fresh. */
  fromCache: boolean;
  /** Wall-clock ms for the resolution. */
  loadMs: number;
}

export interface ModelArtifactResolver {
  resolve(ref: ArtifactRef): Promise<ResolvedArtifact>;
  evict(sha256: string): Promise<void>;
  clear(): Promise<void>;
  size(): Promise<number>;
}

/**
 * Constructor options. Closes core-0id.8.
 *
 * Without an allowlist, `resolve()` would happily fetch any URL a
 * workbook puts in `ref.url`. SHA-256 verifies byte integrity but
 * does NOT prove the URL was a legitimate destination. Risks:
 *   - Tracking pixel / IP-reveal: workbook references a URL on an
 *     attacker-controlled host; the consumer's IP + headers leak
 *     on every page load.
 *   - Intranet probing if this code is ever reused server-side:
 *     workbook reaches an internal hostname only the consumer
 *     can route to. (SSRF.)
 *   - Cache pollution: workbook fans out to N junk URLs, filling
 *     IndexedDB with content-addressed garbage that never gets
 *     hit again.
 *
 * Default `allowedHosts` covers the canonical Hugging Face origins.
 * Embedders self-host or pass their own allowlist to extend.
 * Pass `null` to opt out (back to the previous unrestricted
 * behavior — caller takes responsibility).
 */
export interface ModelArtifactResolverOptions {
  /**
   * Hostnames that may serve model artifacts. Default:
   *   ["huggingface.co", "cdn-lfs.huggingface.co", "cdn-lfs-us-1.hf.co"]
   * Pass `null` to disable host validation entirely (legacy behavior).
   */
  allowedHosts?: string[] | null;
}

const DEFAULT_ALLOWED_HOSTS: ReadonlyArray<string> = [
  "huggingface.co",
  "cdn-lfs.huggingface.co",
  "cdn-lfs-us-1.hf.co",
];

/** True if the URL's hostname is in the allowlist (case-insensitive). */
function hostAllowed(rawUrl: string, allow: ReadonlyArray<string>): boolean {
  let parsed: URL;
  try { parsed = new URL(rawUrl); }
  catch { return false; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase();
  return allow.some((h) => h.toLowerCase() === host);
}

/**
 * Default IndexedDB-backed resolver. Singleton-friendly — one instance
 * per page is correct.
 */
export function createModelArtifactResolver(
  opts: ModelArtifactResolverOptions = {},
): ModelArtifactResolver {
  const allow: ReadonlyArray<string> | null =
    opts.allowedHosts === null
      ? null
      : opts.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
  let dbPromise: Promise<IDBDatabase> | null = null;

  function ensureDb(): Promise<IDBDatabase> {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function read(sha256: string): Promise<Uint8Array | null> {
    const db = await ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(sha256);
      req.onsuccess = () => {
        const v = req.result as Uint8Array | undefined;
        resolve(v ?? null);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function write(sha256: string, bytes: Uint8Array): Promise<void> {
    const db = await ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(bytes, sha256);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  return {
    async resolve(ref) {
      const start = performance.now();

      // Cache check.
      try {
        const cached = await read(ref.sha256);
        if (cached) {
          return {
            sha256: ref.sha256,
            bytes: cached,
            fromCache: true,
            loadMs: performance.now() - start,
          };
        }
      } catch {
        // IndexedDB unavailable (private mode, no quota) — fall through
        // to network and skip caching.
      }

      // Host allowlist gate. SHA-256 verifies bytes but not destination —
      // an attacker-controlled URL still leaks IP/headers on every load
      // and can pollute IndexedDB. See ModelArtifactResolverOptions.
      if (allow !== null && !hostAllowed(ref.url, allow)) {
        throw new Error(
          `model artifact host not in allowlist: ${ref.url}. ` +
            `Pass allowedHosts to createModelArtifactResolver to extend, ` +
            `or null to opt out.`,
        );
      }

      // Network fetch.
      const resp = await fetch(ref.url);
      if (!resp.ok) {
        throw new Error(
          `model fetch failed: ${ref.url} → ${resp.status} ${resp.statusText}`,
        );
      }
      const buf = new Uint8Array(await resp.arrayBuffer());

      // Verify sha256.
      const digestHex = await sha256Hex(buf);
      if (digestHex !== ref.sha256) {
        throw new Error(
          `model integrity check failed for ${ref.name ?? ref.sha256}: ` +
            `expected ${ref.sha256}, got ${digestHex}`,
        );
      }

      // Best-effort cache write (don't fail on QuotaExceeded etc.).
      try {
        await write(ref.sha256, buf);
      } catch (err) {
        console.warn("model cache write failed (continuing):", err);
      }

      return {
        sha256: ref.sha256,
        bytes: buf,
        fromCache: false,
        loadMs: performance.now() - start,
      };
    },

    async evict(sha256) {
      const db = await ensureDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const req = tx.objectStore(STORE_NAME).delete(sha256);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    },

    async clear() {
      const db = await ensureDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const req = tx.objectStore(STORE_NAME).clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    },

    async size() {
      const db = await ensureDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },
  };
}

/** Hex-encoded SHA-256 of a buffer using SubtleCrypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
