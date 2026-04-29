//! Polars cell dispatcher — runs LazyFrame chains against the data layer.
//!
//! Cell language: `CELL_LANGUAGE_POLARS`. Spec can be either:
//! - a JSON-encoded structured plan (preferred for agent-authored cells)
//! - a SQL string evaluated via Polars's SQL frontend (for the smoke-test
//!   path and SQL-style cells)
//!
//! Today (P2.2): SQL-frontend smoke-test path — `runPolarsSql(sql, csv)`
//! parses an inline CSV into a LazyFrame, registers it as `data`, runs the
//! SQL, and returns the result rendered as CSV. Full structured-plan
//! execution lands in P3.2.

use crate::outputs::CellOutput;
use polars::prelude::*;
use polars::sql::SQLContext;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Cursor;
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolarsCellRequest {
    pub spec: serde_json::Value,
    #[serde(default)]
    pub params: serde_json::Value,
}

pub fn run_polars_cell(_req: PolarsCellRequest) -> Result<Vec<CellOutput>, String> {
    Err("polars structured-plan dispatcher not yet implemented (P3.2)".into())
}

/// JS-bridge entry — `runPolarsSql(sql, csv)` parses `csv` into a LazyFrame,
/// registers it as table `data`, evaluates the SQL, and returns the resulting
/// frame rendered back to CSV.
///
/// Used by the demo workbook to prove an end-to-end Polars round trip in
/// the browser (P2.5 gate).
#[wasm_bindgen(js_name = runPolarsSql)]
pub fn run_polars_sql(sql: String, csv: String) -> Result<JsValue, JsValue> {
    let outputs = run_polars_sql_inner(sql, csv).map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&outputs).map_err(Into::into)
}

fn run_polars_sql_inner(sql: String, csv: String) -> Result<Vec<CellOutput>, String> {
    let lf = CsvReadOptions::default()
        .with_has_header(true)
        .into_reader_with_file_handle(Cursor::new(csv.into_bytes()))
        .finish()
        .map_err(|e| format!("polars csv parse: {e}"))?
        .lazy();

    let mut ctx = SQLContext::new();
    ctx.register("data", lf);

    let result = ctx
        .execute(&sql)
        .map_err(|e| format!("polars sql plan: {e}"))?
        .collect()
        .map_err(|e| format!("polars sql execute: {e}"))?;

    let mut buf = Vec::<u8>::new();
    CsvWriter::new(&mut buf)
        .finish(&mut result.clone())
        .map_err(|e| format!("polars csv encode: {e}"))?;
    let rendered = String::from_utf8(buf).map_err(|e| format!("polars csv utf8: {e}"))?;

    Ok(vec![CellOutput::Text {
        content: rendered,
        mime_type: Some("text/csv".into()),
    }])
}

/// JS-bridge entry — `runPolarsSqlIpc(sql, tables)` registers each entry
/// in `tables` as a Polars table by name (table name = map key) and
/// runs the SQL against the resulting context. Each value is parsed
/// as a complete Arrow IPC stream.
///
/// Used by `<wb-memory>` cell dispatch on the JS side. Cells reference
/// memory tables in `reads=`; the runtime client looks up the registered
/// IPC bytes and threads them into RunCellRequest.memoryTables, which
/// the JS dispatcher passes here.
///
/// Pipeline:
///   bytes → arrow-rs IpcStreamReader → RecordBatch
///         → arrow-rs CsvWriter → CSV string
///         → polars CsvReader → LazyFrame
///         → registered in SQLContext under the table name
///
/// Going through CSV is the wasm32-friendly path. Polars's own `ipc`
/// feature pulls zstd-sys which doesn't compile to wasm32 without a
/// wasi sysroot we don't have yet. arrow-rs's IPC reader doesn't
/// require any compression codecs (we only enable the `ipc` and `csv`
/// arrow features), so it builds cleanly. Performance is suboptimal —
/// double encode/decode through CSV — but correctness holds and the
/// path is unblocked. When the wasi-sdk story lands, replace this
/// with `IpcStreamReader::new(...).finish().lazy()` and ditch the
/// CSV intermediate.
///
/// Returns the result frame as CSV plus a table output stub.
///
/// Caveat: today's JS-side `appendMemory` does naive byte concatenation
/// of IPC streams. A correctly-formed Arrow IPC stream has one schema
/// message + batches + EOS; concatenating two streams produces
/// `<stream1><stream2>` and arrow-rs's StreamReader reads up to the
/// first EOS only, losing rows from later appends. Right fix is
/// host-driven complete-stream replacement on save (host owns the
/// source of truth and re-serializes), or a Rust-side proper IPC
/// append that strips intermediate schemas + EOS markers. Tracked
/// separately as task #17.
#[wasm_bindgen(js_name = runPolarsSqlIpc)]
pub fn run_polars_sql_ipc(sql: String, tables: JsValue) -> Result<JsValue, JsValue> {
    let tables: HashMap<String, Vec<u8>> = serde_wasm_bindgen::from_value(tables)
        .map_err(|e| JsValue::from_str(&format!("polars ipc tables decode: {e}")))?;
    let outputs = run_polars_sql_ipc_inner(sql, tables).map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&outputs).map_err(Into::into)
}

fn run_polars_sql_ipc_inner(
    sql: String,
    tables: HashMap<String, Vec<u8>>,
) -> Result<Vec<CellOutput>, String> {
    let mut ctx = SQLContext::new();

    for (name, bytes) in tables {
        // arrow-rs IPC stream → RecordBatches.
        let reader = arrow::ipc::reader::StreamReader::try_new(Cursor::new(bytes), None)
            .map_err(|e| format!("ipc reader init for table '{name}': {e}"))?;
        let batches: Vec<arrow::record_batch::RecordBatch> = reader
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("ipc read batches for table '{name}': {e}"))?;
        if batches.is_empty() {
            // Schema-only stream produces an empty table — register a
            // zero-row LazyFrame so SQL queries against it parse cleanly.
            ctx.register(&name, DataFrame::default().lazy());
            continue;
        }

        // RecordBatches → CSV (with header) → Polars LazyFrame.
        // CSV is the wasm32-friendly bridge until polars-ipc lands;
        // arrow-rs CSV writer handles type rendering correctly.
        let mut csv_buf: Vec<u8> = Vec::new();
        {
            let mut writer = arrow::csv::WriterBuilder::new()
                .with_header(true)
                .build(&mut csv_buf);
            for batch in &batches {
                writer
                    .write(batch)
                    .map_err(|e| format!("arrow csv write for table '{name}': {e}"))?;
            }
        }
        let lf = CsvReadOptions::default()
            .with_has_header(true)
            .into_reader_with_file_handle(Cursor::new(csv_buf))
            .finish()
            .map_err(|e| format!("polars csv parse for table '{name}': {e}"))?
            .lazy();
        ctx.register(&name, lf);
    }

    let result = ctx
        .execute(&sql)
        .map_err(|e| format!("polars sql plan: {e}"))?
        .collect()
        .map_err(|e| format!("polars sql execute: {e}"))?;

    let row_count = result.height();

    let mut buf = Vec::<u8>::new();
    CsvWriter::new(&mut buf)
        .finish(&mut result.clone())
        .map_err(|e| format!("polars csv encode: {e}"))?;
    let rendered = String::from_utf8(buf).map_err(|e| format!("polars csv utf8: {e}"))?;

    Ok(vec![
        CellOutput::Text {
            content: rendered,
            mime_type: Some("text/csv".into()),
        },
        CellOutput::Table {
            sql_table: "result".into(),
            row_count: Some(row_count as i64),
        },
    ])
}
