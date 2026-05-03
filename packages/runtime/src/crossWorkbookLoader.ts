/**
 * Cross-workbook composition + lockfile (P6.4).
 *
 * A workbook can `load()` cells from other workbooks. The loader resolves
 * the upstream workbook's `.workbook` file, pins the resolved
 * (slug, version, sha256) into a lockfile, and re-exports the upstream's
 * `provides` set for downstream cells.
 *
 * Lockfile contract (one per consuming workbook):
 *
 *   {
 *     version: 1,
 *     entries: [
 *       {
 *         slug: "@user/forecasting-utils",
 *         resolved_url: "https://workbooks.example/.../v3.workbook",
 *         resolved_at: "2026-04-29T01:23:45Z",
 *         sha256: "abc…",
 *         provides: ["forecast_arima", "forecast_prophet"],
 *       }
 *     ]
 *   }
 *
 * Pinned shas mean a workbook never silently picks up upstream changes
 * — re-running an old workbook produces the same outputs even if the
 * upstream has shipped breaking changes since.
 *
 * Status: P6.4 baseline. Schema + lockfile builder + resolver shape;
 * the runtime-side execution path that mounts upstream cells into the
 * dependency graph is a follow-up tied to the executor (composes with
 * ReactiveExecutor.setCell + cellAnalyzer's reads/provides).
 */

import { sha256Hex } from "./modelArtifactResolver";

export interface CrossWorkbookRef {
  /** Stable slug (with optional @user/ scope) — the source-of-truth name. */
  slug: string;
  /** Version constraint. Today only exact-version pins (`v3` etc.). */
  version: string;
  /**
   * Optional pre-resolved URL. If not set, the resolver consults the
   * registry (Tier 2/3 host) to locate the workbook file.
   */
  url?: string;
}

export interface LockfileEntry {
  slug: string;
  /** Resolved URL — what was actually fetched. */
  resolved_url: string;
  /** ISO-8601 timestamp of the original resolve. */
  resolved_at: string;
  /** SHA-256 of the workbook file bytes. Pin guarantee. */
  sha256: string;
  /** Names this upstream provides for downstream consumption. */
  provides: string[];
}

export interface Lockfile {
  version: 1;
  entries: LockfileEntry[];
}

export interface CrossWorkbookLoader {
  resolve(ref: CrossWorkbookRef): Promise<LockfileEntry>;
  resolveAll(refs: CrossWorkbookRef[]): Promise<Lockfile>;
  /** Fetch upstream bytes for an already-pinned entry (lockfile path). */
  loadPinned(entry: LockfileEntry): Promise<Uint8Array>;
}

export interface LoaderOptions {
  /**
   * Resolve a slug (+ version) to a fetchable URL. The Tier 2/3 host
   * provides this — typically a workbooks-registry HTTP service.
   */
  registryResolve: (slug: string, version: string) => Promise<string>;
  /**
   * Fetch a URL and return bytes. Defaults to global fetch; override for
   * authentication, retry, etc.
   */
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  /**
   * Extract the upstream's `provides` set from its workbook bytes. The
   * host parses the manifest and returns the names. v1 caller responsibility.
   */
  extractProvides: (bytes: Uint8Array) => string[];
  /**
   * Cap the number of entries any one resolveAll() call will produce.
   * Default 32. Workbooks with longer dependency lists must opt in.
   * Prevents a malicious manifest from listing thousands of refs.
   */
  maxEntries?: number;
  /**
   * Cap the per-entry byte size. Default 25 MB. Larger upstream
   * workbooks throw with a clear error.
   */
  maxBytesPerEntry?: number;
  /**
   * Cap the aggregate byte size across one resolveAll() call.
   * Default 50 MB. Bounds memory blow-up regardless of entry count.
   */
  maxAggregateBytes?: number;
  /**
   * Reserved for future recursive resolution (when extractProvides
   * exposes nested refs). Default 4. Ignored today since resolveAll
   * is non-recursive — kept to lock the API now so the eventual
   * recursive expansion doesn't change the option shape.
   */
  maxDepth?: number;
}

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_BYTES_PER_ENTRY = 25 * 1024 * 1024;
const DEFAULT_MAX_AGGREGATE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 4;

export function createCrossWorkbookLoader(opts: LoaderOptions): CrossWorkbookLoader {
  const fetchBytes = opts.fetchBytes ?? defaultFetchBytes;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytesPerEntry = opts.maxBytesPerEntry ?? DEFAULT_MAX_BYTES_PER_ENTRY;
  const maxAggregateBytes = opts.maxAggregateBytes ?? DEFAULT_MAX_AGGREGATE_BYTES;
  // Reserved for future recursive resolution; kept on the options
  // surface now so the eventual change is non-breaking.
  void (opts.maxDepth ?? DEFAULT_MAX_DEPTH);

  /** Per-resolveAll budget, threaded through resolve() calls. */
  interface Budget {
    aggregateBytes: number;
  }

  async function resolveOne(
    ref: CrossWorkbookRef,
    budget: Budget,
  ): Promise<LockfileEntry> {
    const url = ref.url ?? (await opts.registryResolve(ref.slug, ref.version));
    const bytes = await fetchBytes(url);
    if (bytes.byteLength > maxBytesPerEntry) {
      throw new Error(
        `cross-workbook entry exceeds size cap: ${ref.slug} ` +
          `(${bytes.byteLength} bytes > ${maxBytesPerEntry}). ` +
          `Pass maxBytesPerEntry to extend.`,
      );
    }
    budget.aggregateBytes += bytes.byteLength;
    if (budget.aggregateBytes > maxAggregateBytes) {
      throw new Error(
        `cross-workbook aggregate exceeds size cap: ` +
          `${budget.aggregateBytes} > ${maxAggregateBytes}. ` +
          `Pass maxAggregateBytes to extend.`,
      );
    }
    const sha256 = await sha256Hex(bytes);
    const provides = opts.extractProvides(bytes);
    return {
      slug: ref.slug,
      resolved_url: url,
      resolved_at: new Date().toISOString(),
      sha256,
      provides,
    };
  }

  return {
    async resolve(ref) {
      // Single-ref resolve still gets per-entry + aggregate caps so
      // direct callers (not just resolveAll) are protected.
      return resolveOne(ref, { aggregateBytes: 0 });
    },

    async resolveAll(refs) {
      if (refs.length > maxEntries) {
        throw new Error(
          `cross-workbook refs exceed entry cap: ` +
            `${refs.length} > ${maxEntries}. ` +
            `Pass maxEntries to extend.`,
        );
      }
      const budget: Budget = { aggregateBytes: 0 };
      const entries: LockfileEntry[] = [];
      for (const ref of refs) {
        // Sequential to keep the registry happy + log lines ordered;
        // if registries are CDN-cached this is still <100ms per ref.
        entries.push(await resolveOne(ref, budget));
      }
      return { version: 1, entries };
    },

    async loadPinned(entry) {
      const bytes = await fetchBytes(entry.resolved_url);
      if (bytes.byteLength > maxBytesPerEntry) {
        throw new Error(
          `pinned cross-workbook entry exceeds size cap: ${entry.slug} ` +
            `(${bytes.byteLength} bytes > ${maxBytesPerEntry})`,
        );
      }
      const sha = await sha256Hex(bytes);
      if (sha !== entry.sha256) {
        throw new Error(
          `lockfile integrity failed for ${entry.slug}: ` +
            `expected ${entry.sha256}, got ${sha}`,
        );
      }
      return bytes;
    },
  };
}

async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`workbook fetch failed: ${url} → ${resp.status}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}
