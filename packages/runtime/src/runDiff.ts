/**
 * Structured diff between scheduled runs (P5.3).
 *
 * Workbooks that run on a schedule produce a sequence of run records.
 * Comparing a run to its predecessor gives the user the *change*, not
 * just the latest value — the moment a metric inflects, the row that
 * appeared, the chart that swung.
 *
 * Diff is structured per cell-output kind:
 *
 *   text(csv)      → row-level diff (added / removed / changed cells)
 *   text(text)     → unified text diff
 *   image          → byte-equality only (consider a perceptual diff
 *                    later; SSIM is overkill for v1)
 *   table          → table_id + row_count delta (full rows live in the
 *                    data layer, not the run record)
 *   error          → error message comparison
 *
 * Scope (P5.3 baseline): CSV row-diff + text unified-diff + scalar
 * compare. Per-cell rollup, not whole-workbook. Whole-workbook diffs
 * compose by reducing per-cell diffs.
 */

import type { CellOutput } from "./wasmBridge";

export type CellDiff =
  | { kind: "unchanged" }
  | { kind: "csv-rows"; addedRows: string[][]; removedRows: string[][]; changedRows: ChangedRow[] }
  | { kind: "text"; added: string[]; removed: string[] }
  | { kind: "image-bytes"; sameSize: boolean; sameSha?: boolean }
  | { kind: "table"; previousRowCount?: number; nextRowCount?: number }
  | { kind: "error"; previous?: string; next?: string }
  | { kind: "kind-changed"; previousKind: string; nextKind: string };

export interface ChangedRow {
  index: number;
  previous: string[];
  next: string[];
  /** Column indices where values differ. */
  columns: number[];
}

/** Diff a single cell output against its previous run's output. */
export function diffCellOutput(prev: CellOutput | null, next: CellOutput | null): CellDiff {
  if (!prev && !next) return { kind: "unchanged" };
  if (!prev || !next) {
    return {
      kind: "kind-changed",
      previousKind: prev?.kind ?? "(none)",
      nextKind: next?.kind ?? "(none)",
    };
  }
  if (prev.kind !== next.kind) {
    return {
      kind: "kind-changed",
      previousKind: prev.kind,
      nextKind: next.kind,
    };
  }

  if (prev.kind === "text" && next.kind === "text") {
    if (prev.mime_type === "text/csv" && next.mime_type === "text/csv") {
      return diffCsv(prev.content, next.content);
    }
    return diffText(prev.content, next.content);
  }

  if (prev.kind === "image" && next.kind === "image") {
    return {
      kind: "image-bytes",
      sameSize: prev.content.length === next.content.length,
      sameSha: prev.content === next.content,
    };
  }

  if (prev.kind === "table" && next.kind === "table") {
    return {
      kind: "table",
      previousRowCount: prev.row_count,
      nextRowCount: next.row_count,
    };
  }

  if (prev.kind === "error" && next.kind === "error") {
    if (prev.message === next.message) return { kind: "unchanged" };
    return { kind: "error", previous: prev.message, next: next.message };
  }

  return { kind: "unchanged" };
}

/** Row-level CSV diff. Treats first row as headers; matches by row index. */
export function diffCsv(prevCsv: string, nextCsv: string): CellDiff {
  const prevRows = parseCsvRows(prevCsv);
  const nextRows = parseCsvRows(nextCsv);
  const addedRows: string[][] = [];
  const removedRows: string[][] = [];
  const changedRows: ChangedRow[] = [];

  const maxLen = Math.max(prevRows.length, nextRows.length);
  for (let i = 0; i < maxLen; i++) {
    const p = prevRows[i];
    const n = nextRows[i];
    if (!p && n) {
      addedRows.push(n);
      continue;
    }
    if (p && !n) {
      removedRows.push(p);
      continue;
    }
    if (!p || !n) continue;
    const cols: number[] = [];
    const len = Math.max(p.length, n.length);
    for (let c = 0; c < len; c++) {
      if ((p[c] ?? "") !== (n[c] ?? "")) cols.push(c);
    }
    if (cols.length > 0) {
      changedRows.push({ index: i, previous: p, next: n, columns: cols });
    }
  }

  return { kind: "csv-rows", addedRows, removedRows, changedRows };
}

/**
 * Text diff: line-level set diff. Not a Myers diff (P5.3 v1) — sufficient
 * for the per-cell rollup. Replace with a real diff library if a workbook
 * surfaces literary-text content.
 */
export function diffText(prev: string, next: string): CellDiff {
  const prevLines = prev.split(/\r?\n/);
  const nextLines = next.split(/\r?\n/);
  const prevSet = new Set(prevLines);
  const nextSet = new Set(nextLines);
  const added = nextLines.filter((l) => !prevSet.has(l));
  const removed = prevLines.filter((l) => !nextSet.has(l));
  if (added.length === 0 && removed.length === 0) return { kind: "unchanged" };
  return { kind: "text", added, removed };
}

function parseCsvRows(csv: string): string[][] {
  return csv.trim().split("\n").map(parseCsvRow);
}

function parseCsvRow(row: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      inQ = !inQ;
      continue;
    }
    if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}
