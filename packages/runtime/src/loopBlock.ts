/**
 * Loop block (P5.5).
 *
 * A loop block runs a set of cells multiple times — once per iteration of
 * an `over` source (input array, data-layer table, or literal list).
 * Iterations may run in parallel up to a workbook-declared concurrency
 * cap; results merge back into the data layer as a named `outputTable`.
 *
 * Block schema (mirrors `workbook.v1.LoopBlock`):
 *
 *   {
 *     kind: "loop",
 *     over: { kind: "input" | "table" | "literal", value: string | unknown[] },
 *     cells: string[],            // cell ids to run per iteration
 *     parallelism: number,        // default 4; clamped 1..16
 *     errorPolicy: "continue" | "halt",
 *     outputTable: string,
 *   }
 *
 * Status: P5.5 baseline. Schema + iteration planner shipped; runtime
 * execution depends on the host having multiple runtime instances
 * (Web Workers in Tier 1, separate processes in Tier 3). The single-
 * runtime fallback is sequential — useful for browser dev / portable
 * exports without worker-pool plumbing.
 */

export type LoopOverKind = "input" | "table" | "literal";

export interface LoopOverSpec {
  kind: LoopOverKind;
  /** input name (kind="input"), table id (kind="table"), or array (kind="literal"). */
  value: string | unknown[];
}

export type LoopErrorPolicy = "continue" | "halt";

export interface LoopBlockSpec {
  kind: "loop";
  over: LoopOverSpec;
  /** Cell IDs that run per iteration. */
  cells: string[];
  /** Iterations to run in flight at once. Clamped 1..16. */
  parallelism?: number;
  errorPolicy?: LoopErrorPolicy;
  /** Name of the merged result table written into the data layer. */
  outputTable: string;
}

export interface LoopIteration {
  index: number;
  /** Bound value for this iteration — passed as a parameter to the cells. */
  value: unknown;
}

/**
 * Resolve a loop's `over` spec against the current input/table state and
 * return an iteration plan. The plan is what the executor schedules.
 *
 * For kind="input" / kind="table" the loader function is passed in;
 * literal values bypass it.
 */
export function planLoopIterations(
  spec: LoopBlockSpec,
  resolve: (kind: "input" | "table", name: string) => unknown[],
): LoopIteration[] {
  const items = collectItems(spec.over, resolve);
  return items.map((value, index) => ({ index, value }));
}

function collectItems(
  over: LoopOverSpec,
  resolve: (kind: "input" | "table", name: string) => unknown[],
): unknown[] {
  if (over.kind === "literal") {
    return Array.isArray(over.value) ? over.value : [];
  }
  if (typeof over.value !== "string") {
    throw new Error(`loop over kind=${over.kind} requires a string value`);
  }
  return resolve(over.kind, over.value);
}

/**
 * Clamp parallelism to a runtime-friendly range. Browser default = 4
 * (most laptops have 4-8 cores; Web Workers compete with main-thread
 * work). Tier 3 hosts can override via the runtime config.
 */
export function clampParallelism(p: number | undefined): number {
  const v = p ?? 4;
  if (!Number.isFinite(v)) return 4;
  return Math.max(1, Math.min(16, Math.floor(v)));
}
