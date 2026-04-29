/**
 * Static cell analyzer (P3.4).
 *
 * Extracts the `reads` (upstream dependencies) and `provides` (downstream
 * names) sets for a cell by inspecting its language and source. Used by
 * the reactive executor to build the cell DAG without requiring authors
 * to hand-declare every dependency.
 *
 * Authors CAN still declare them explicitly on the cell — `cell.dependsOn`
 * and `cell.provides` always win over the analyzer's output. The analyzer
 * fills the gap when those fields are missing.
 *
 * Conservative by design — false positives (extra reads) cause unnecessary
 * re-execution but never wrong results. False negatives (missed reads)
 * would, so when in doubt we over-include.
 */

import type { Cell } from "./wasmBridge";

export interface CellAnalysis {
  reads: string[];
  provides: string[];
}

/**
 * Analyze a cell to determine its `reads` and `provides` sets.
 *
 * Resolution order:
 *   1. Explicit `cell.dependsOn` / `cell.provides` win.
 *   2. Otherwise parse `cell.source` per language.
 *   3. Fallback: `provides = [cell.id]`, `reads = []`.
 */
export function analyzeCell(cell: Cell): CellAnalysis {
  const provides =
    cell.provides && cell.provides.length > 0
      ? cell.provides
      : defaultProvides(cell);

  const reads =
    cell.dependsOn && cell.dependsOn.length > 0
      ? cell.dependsOn
      : extractReads(cell);

  return {
    reads: dedupe(reads),
    provides: dedupe(provides),
  };
}

function defaultProvides(cell: Cell): string[] {
  return [cell.id];
}

function extractReads(cell: Cell): string[] {
  const src = cell.source ?? "";
  switch (cell.language) {
    case "polars":
    case "sqlite":
      return extractSqlReads(src);
    case "rhai":
      return extractRhaiReads(src);
    case "wasm-fn":
    case "candle-inference":
    case "linfa-train":
      // Structured-spec languages — caller should set dependsOn explicitly.
      return [];
    default:
      return [];
  }
}

// ----------------------------------------------------------------------
// SQL-family analyzer
//
// Pulls table names out of FROM and JOIN clauses, and CTE names from WITH
// clauses. CTE names are subtracted from reads (they're internal to the
// query, not external dependencies).
// ----------------------------------------------------------------------

const SQL_FROM_RE = /\bfrom\s+([a-zA-Z_][\w]*)/gi;
const SQL_JOIN_RE = /\bjoin\s+([a-zA-Z_][\w]*)/gi;
const SQL_WITH_RE = /\bwith\s+([a-zA-Z_][\w]*)\s+as\s*\(/gi;
const SQL_WITH_FOLLOW_RE = /,\s*([a-zA-Z_][\w]*)\s+as\s*\(/gi;

export function extractSqlReads(src: string): string[] {
  const reads = new Set<string>();
  for (const m of src.matchAll(SQL_FROM_RE)) reads.add(m[1]);
  for (const m of src.matchAll(SQL_JOIN_RE)) reads.add(m[1]);

  const ctes = new Set<string>();
  for (const m of src.matchAll(SQL_WITH_RE)) ctes.add(m[1]);
  for (const m of src.matchAll(SQL_WITH_FOLLOW_RE)) ctes.add(m[1]);

  return [...reads].filter((name) => !ctes.has(name));
}

// ----------------------------------------------------------------------
// Rhai analyzer
//
// `let X = ...` lines provide X. Bare identifiers that aren't a let-bound
// local, a Rhai keyword, or a literal-looking token count as reads.
//
// Conservative: any identifier that looks like an external reference
// becomes a read. The DAG executor de-dupes against names that no other
// cell `provides`, so bogus reads (referring to nothing) silently no-op.
// ----------------------------------------------------------------------

const RHAI_LET_RE = /\blet\s+([a-zA-Z_][\w]*)/g;
const RHAI_IDENT_RE = /\b([a-zA-Z_][\w]*)\b/g;
const RHAI_KEYWORDS = new Set([
  "let", "const", "if", "else", "for", "in", "while", "loop", "do", "until",
  "break", "continue", "return", "fn", "private", "switch", "default",
  "throw", "try", "catch", "import", "export", "as", "true", "false", "null",
  "this", "is", "not", "Fn", "call", "curry", "type_of", "print", "debug",
  "to_string", "to_int", "to_float", "len", "push", "pop", "shift",
]);

export function extractRhaiReads(src: string): string[] {
  // Strip line comments + block comments before scanning, otherwise tokens
  // inside comments leak into the reads set.
  const stripped = src
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  // Strip string literals.
  const noStrings = stripped.replace(/"(?:[^"\\]|\\.)*"/g, '""');

  const provides = new Set<string>();
  for (const m of noStrings.matchAll(RHAI_LET_RE)) provides.add(m[1]);

  const reads = new Set<string>();
  for (const m of noStrings.matchAll(RHAI_IDENT_RE)) {
    const name = m[1];
    if (provides.has(name)) continue;
    if (RHAI_KEYWORDS.has(name)) continue;
    if (/^\d/.test(name)) continue;
    reads.add(name);
  }

  return [...reads];
}

// ----------------------------------------------------------------------

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
