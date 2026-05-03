/**
 * SQLite cell dispatcher (sidecar to the Rust runtime).
 *
 * SQLite isn't bundled into the workbook-runtime WASM crate — the
 * mature wasm port is `@sqlite.org/sqlite-wasm` (the upstream-maintained
 * Emscripten build). This file lazy-loads that package on first hit
 * and routes `language: "sqlite"` cells to it.
 *
 * Cells deliver their database via `reads=` referencing a
 * `<wb-data mime="application/x-sqlite3">` block:
 *
 *   <wb-data id="customers" mime="application/x-sqlite3"
 *            encoding="base64" sha256="...">U1FMaXRl...</wb-data>
 *
 *   <wb-cell id="top10" language="sqlite" reads="customers">
 *   SELECT name, total FROM orders ORDER BY total DESC LIMIT 10;
 *   </wb-cell>
 *
 * The resolver materializes `customers` to a Uint8Array; the dispatcher
 * loads it with sqlite3.capi.sqlite3_deserialize and runs the query.
 *
 * Result shape: same `kind: "text"` + `mime_type: "text/csv"` as Polars
 * — UI code that already renders Polars table outputs will render
 * SQLite outputs unchanged. Author can pipe SQLite → Polars for
 * richer downstream work without a format mismatch.
 *
 * Connections are cached per (workbook, dataId) tuple so repeated
 * queries against the same db reuse the open handle. `dispose()`
 * tears every cached handle down — call from page unmount.
 *
 * Peer dep: `@sqlite.org/sqlite-wasm` is declared as an optional
 * peer dep on the runtime package. Workbooks that don't use SQLite
 * never load it; the dispatcher surfaces a clear error if a workbook
 * needs it but the consumer hasn't installed it.
 */

import type { CellOutput } from "./wasmBridge";

/** Result-row mode we ask sqlite3 for: object-shaped rows with column-name keys. */
type RowObject = Record<string, unknown>;

/** Subset of the @sqlite.org/sqlite-wasm shape we actually use. */
interface Sqlite3Module {
  oo1: {
    DB: new (filename?: string, flags?: string) => Sqlite3DB;
  };
  capi: {
    sqlite3_deserialize: (
      db: unknown,
      schema: string,
      bytes: Uint8Array,
      byteCount: number,
      bufSize: number,
      flags: number,
    ) => number;
    SQLITE_DESERIALIZE_FREEONCLOSE?: number;
    SQLITE_DESERIALIZE_READONLY?: number;
  };
}
interface Sqlite3DB {
  pointer: unknown;
  exec(opts: {
    sql: string;
    returnValue?: "resultRows";
    rowMode?: "object" | "array";
    bind?: unknown[];
  }): RowObject[] | unknown[];
  close(): void;
}

let sqlite3Promise: Promise<Sqlite3Module> | null = null;

async function loadSqlite3(): Promise<Sqlite3Module> {
  if (!sqlite3Promise) {
    sqlite3Promise = (async () => {
      // Dynamic import via a variable specifier so TS doesn't try to
      // resolve the optional peer dep at compile time.
      const specifier = "@sqlite.org/sqlite-wasm";
      let mod: { default: (opts?: { print?: (...a: unknown[]) => void; printErr?: (...a: unknown[]) => void }) => Promise<Sqlite3Module> };
      try {
        mod = (await import(/* @vite-ignore */ specifier)) as unknown as typeof mod;
      } catch {
        throw new Error(
          "sqlite cells require @sqlite.org/sqlite-wasm — install it as a " +
            "peer dep or pre-bundle it with your workbook host",
        );
      }
      // The package's default export is an Emscripten initializer.
      const sqlite3 = await mod.default({
        print: () => {},
        printErr: () => {},
      });
      return sqlite3;
    })();
  }
  return sqlite3Promise;
}

/** CSV-quote a single value per RFC 4180. */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`;
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(rows: RowObject[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]!);
  const head = cols.map(csvCell).join(",");
  const body = rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")).join("\n");
  return `${head}\n${body}`;
}

/** Per-handle entry kept on the dispatcher cache. */
interface DbHandle {
  db: Sqlite3DB;
  /** Identity check for cache invalidation. The resolver returns the
   *  same Uint8Array instance for cached resolves, so a different
   *  reference means the data block was re-resolved. */
  bytesRef: Uint8Array;
}

export interface SqliteDispatcher {
  /**
   * Run `sql` against the database materialized from `dbBytes`. Multiple
   * cells using the same (workbookSlug, dataId) reuse the same handle
   * unless `dbBytes` is a different Uint8Array reference.
   */
  exec(opts: {
    workbookSlug: string;
    dataId: string;
    dbBytes: Uint8Array;
    sql: string;
  }): Promise<CellOutput[]>;
  /** Close every cached handle. Call on unmount. */
  dispose(): void;
}

export function createSqliteDispatcher(): SqliteDispatcher {
  const handles = new Map<string, DbHandle>();

  function key(workbookSlug: string, dataId: string): string {
    return `${workbookSlug}::${dataId}`;
  }

  async function openDb(bytes: Uint8Array): Promise<Sqlite3DB> {
    const sqlite3 = await loadSqlite3();
    // Open an in-memory DB, then deserialize the bytes into it.
    // SQLITE_DESERIALIZE_FREEONCLOSE = 1, READONLY = 4. Combine with bitor
    // when we want the bytes freed on close — but the bytes were allocated
    // by the runtime, not sqlite, so don't pass FREEONCLOSE. Instead we
    // hold the Uint8Array alive in `handles` until dispose().
    const db = new sqlite3.oo1.DB(":memory:", "ct");
    const flags = sqlite3.capi.SQLITE_DESERIALIZE_READONLY ?? 0x4;
    const rc = sqlite3.capi.sqlite3_deserialize(
      db.pointer,
      "main",
      bytes,
      bytes.byteLength,
      bytes.byteLength,
      flags,
    );
    if (rc !== 0) {
      db.close();
      throw new Error(`sqlite3_deserialize failed (rc=${rc})`);
    }
    return db;
  }

  return {
    async exec({ workbookSlug, dataId, dbBytes, sql }) {
      const k = key(workbookSlug, dataId);
      let entry = handles.get(k);
      if (entry && entry.bytesRef !== dbBytes) {
        // Bytes changed underneath us — close stale handle, reopen.
        try { entry.db.close(); } catch { /* ignore */ }
        entry = undefined;
        handles.delete(k);
      }
      if (!entry) {
        const db = await openDb(dbBytes);
        entry = { db, bytesRef: dbBytes };
        handles.set(k, entry);
      }

      const trimmed = sql.trim();
      if (!trimmed) {
        return [{ kind: "text", content: "", mime_type: "text/csv" }];
      }

      let rows: RowObject[];
      try {
        rows = entry.db.exec({
          sql: trimmed,
          returnValue: "resultRows",
          rowMode: "object",
        }) as RowObject[];
      } catch (err) {
        return [
          {
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          },
        ];
      }

      const csv = rowsToCsv(rows);
      return [
        { kind: "text", content: csv, mime_type: "text/csv" },
        { kind: "table", sql_table: dataId, row_count: rows.length },
      ];
    },

    dispose() {
      for (const entry of handles.values()) {
        try { entry.db.close(); } catch { /* ignore */ }
      }
      handles.clear();
    },
  };
}
