/**
 * Workbook render context.
 *
 * Provides workbook-scoped state to deeply-nested block components:
 *
 * - `sbookId` — host workbook id, needed by blocks that write back
 *   (e.g. Input persists user values keyed by blockId)
 * - `dataResolver` — pluggable interface for runtime data fetching
 *   (file URLs, input persistence). The consumer wires their environment;
 *   blocks call resolver.<method>() without knowing whether they're
 *   running against Convex, an exported file, or a Tier 3 host.
 *
 * Pages mounting a workbook call `setWorkbookContext` once at the canvas
 * level; blocks consume via `getWorkbookContext`. Reading the context
 * returns null outside a workbook (legacy viewer paths) — blocks
 * degrade gracefully.
 */

import { getContext, setContext } from "svelte";

const KEY = Symbol("workbook-context");

/**
 * Pluggable data fetcher. Implementations live in the consumer (apps/web
 * wraps Convex, an exported workbook supplies a no-op or fetch-based
 * resolver). Blocks invoke the methods without knowing the implementation.
 */
export interface WorkbookDataResolver {
  /**
   * Resolve a file ID to a fetchable URL. The URL is short-lived; callers
   * should not cache it longer than the file's content is needed.
   *
   * Throws when the resolver is not configured (e.g. exported workbook
   * with no fetcher) — calling block surfaces "file unavailable in this
   * runtime" UI.
   */
  resolveFileUrl(fileId: string): Promise<string>;

  /**
   * Persist a user-provided input value back into the workbook. Used by
   * Input blocks. May silently no-op when the workbook is read-only
   * (exported file viewed standalone).
   */
  setInputValue(blockId: string, value: unknown): Promise<void>;
}

/**
 * No-op resolver — used by exported workbooks with no live runtime.
 * File-fetching blocks render with their embedded fallback (last-known
 * preview) but cannot fetch fresh data; Input blocks keep working as
 * unbacked form fields.
 */
export const noopResolver: WorkbookDataResolver = {
  async resolveFileUrl() {
    throw new Error("Workbook data resolver is not configured");
  },
  async setInputValue() {
    // Silent no-op — exported workbooks are read-only by default
  },
};

export type WorkbookContext = {
  sbookId: string;
  resolver?: WorkbookDataResolver;
};

export function setWorkbookContext(ctx: WorkbookContext): void {
  setContext(KEY, ctx);
}

export function getWorkbookContext(): WorkbookContext | null {
  return (getContext(KEY) as WorkbookContext | undefined) ?? null;
}

/** Convenience: get the resolver, falling back to no-op if no context set. */
export function getWorkbookResolver(): WorkbookDataResolver {
  return getWorkbookContext()?.resolver ?? noopResolver;
}
