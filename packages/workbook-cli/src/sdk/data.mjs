// `workbook:data` — virtual module, resolved by workbook-cli's
// virtualModules plugin. Wraps apache-arrow with the defaults that
// keep round-trips through polars-wasm working.
//
// API surface (kept tiny on purpose — adding more is a deliberate
// decision, not "we needed it once"):
//
//   fromArrays(obj)             build an Arrow Table from { col: [...] }
//   tableFromIPC(bytes)         decode an Arrow IPC stream/file
//   tableToIPC(table)           encode an Arrow IPC stream
//
// Why not just re-export apache-arrow? Two reasons:
//
//   1. Defaults matter. apache-arrow's tableFromArrays dictionary-
//      encodes string columns; polars-wasm doesn't include
//      dtype-categorical, so the resulting table fails at SQL time.
//      fromArrays here always materializes Utf8 vectors for strings.
//
//   2. We want one ergonomic surface that we can swap implementations
//      under (e.g., move to arrow-wasm someday) without breaking
//      userland. `import { fromArrays } from "workbook:data"` is the
//      contract; the underlying lib is an implementation detail.
//
// The CLI's `workbook check` rule `workbook/correctness/no-raw-arrow-
// import` enforces that user code goes through this module instead of
// reaching past it to apache-arrow directly.
//
// workbook-disable-next-line workbook/correctness/no-raw-arrow-import
import * as _arrow from "apache-arrow";

/**
 * Build an Arrow Table from a plain object of columns.
 *
 *   const t = fromArrays({
 *     ticker: ["AAPL", "GOOG"],   // → Utf8 (NOT dictionary)
 *     close:  [180.4, 140.2],     // → Float64
 *     date:   [new Date(), new Date()],  // → TimestampMillisecond
 *   });
 *
 * Every column must be the same length. Mixed-type columns are
 * rejected — coerce upstream.
 *
 * @param {Record<string, ArrayLike<unknown>>} columns
 * @returns {_arrow.Table}
 */
export function fromArrays(columns) {
  const keys = Object.keys(columns);
  if (keys.length === 0) {
    throw new Error("fromArrays: at least one column is required");
  }
  const length = columns[keys[0]].length;
  for (const k of keys) {
    if (columns[k].length !== length) {
      throw new Error(
        `fromArrays: column '${k}' has length ${columns[k].length}; ` +
        `expected ${length} (matching '${keys[0]}')`,
      );
    }
  }

  const vectors = {};
  for (const k of keys) {
    vectors[k] = vectorFromValues(columns[k]);
  }
  return new _arrow.Table(vectors);
}

/**
 * Decide a column's Arrow type from its first non-null/undefined
 * value, then build a vector with that explicit type. Strings always
 * become plain Utf8 (never DictionaryEncoded).
 */
function vectorFromValues(values) {
  const probe = firstDefined(values);
  if (probe === undefined) {
    // All null/undefined — emit a Null vector. Polars handles this fine.
    return _arrow.vectorFromArray(values, new _arrow.Null());
  }
  if (typeof probe === "string") {
    return _arrow.vectorFromArray(values, new _arrow.Utf8());
  }
  if (typeof probe === "boolean") {
    return _arrow.vectorFromArray(values, new _arrow.Bool());
  }
  if (typeof probe === "bigint") {
    return _arrow.vectorFromArray(values, new _arrow.Int64());
  }
  if (typeof probe === "number") {
    // Use Float64 — Polars happily downcasts on read; we avoid the
    // gotcha where Int32 inferred from [1,2,3] then breaks on a NaN.
    return _arrow.vectorFromArray(values, new _arrow.Float64());
  }
  if (probe instanceof Date) {
    return _arrow.vectorFromArray(values, new _arrow.TimestampMillisecond());
  }
  // Fallback — let arrow infer; explicit type avoids dictionary only
  // for the common types above.
  return _arrow.vectorFromArray(values);
}

function firstDefined(values) {
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== null && v !== undefined) return v;
  }
  return undefined;
}

/** Decode an Arrow IPC stream/file. Thin re-export. */
export function tableFromIPC(bytes) {
  return _arrow.tableFromIPC(bytes);
}

/** Encode a table as IPC stream bytes. Thin re-export. */
export function tableToIPC(table) {
  return _arrow.tableToIPC(table, "stream");
}

/**
 * Escape hatch — exposes the underlying apache-arrow namespace for
 * advanced cases (RecordBatch streaming, custom schemas). Using this
 * trips no lint rule because it goes through the facade. Don't reach
 * for it casually; `fromArrays` covers ~95% of cases.
 */
export const arrow = _arrow;
