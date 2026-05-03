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
use polars::io::ipc::IpcStreamReader;
use polars::io::SerReader;
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
/// Pipeline (native, post-toolchain-fix):
///   bytes → polars::io::ipc::IpcStreamReader → DataFrame.lazy()
///         → registered in SQLContext under the table name
///
/// Polars `ipc` feature is enabled in Cargo.toml; the C-deps it pulls
/// in (zstd-sys, lz4) compile via Homebrew LLVM's wasm32 backend
/// (configured in .cargo/config.toml). No CSV bridge intermediate.
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

/// JS-bridge entry — `appendArrowIpc(existing, new_batch)` parses both
/// inputs as Arrow IPC streams, verifies the schemas match, and emits
/// a unified IPC stream containing all batches from both inputs under
/// a single schema header + EOS.
///
/// Replaces the broken naive byte concatenation in the JS-side
/// `appendMemory` shim. Naive concat produces `<stream1><stream2>`
/// which IPC readers truncate at the first EOS — losing rows from
/// any append past the first. This binding instead reads both
/// streams, validates schemas, and writes a fresh well-formed
/// stream.
///
/// Schema compatibility: same field count, same field names + data
/// types + nullability, ignoring schema metadata. Anything else
/// throws — incompatible appends would produce a stream that
/// readers can't decode correctly.
#[wasm_bindgen(js_name = appendArrowIpc)]
pub fn append_arrow_ipc(existing: Vec<u8>, new_batch: Vec<u8>) -> Result<Vec<u8>, JsValue> {
    append_arrow_ipc_inner(&existing, &new_batch).map_err(|e| JsValue::from_str(&e))
}

fn append_arrow_ipc_inner(existing: &[u8], new_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let existing_reader = arrow::ipc::reader::StreamReader::try_new(Cursor::new(existing), None)
        .map_err(|e| format!("appendArrowIpc: parse existing: {e}"))?;
    let existing_schema = existing_reader.schema();
    let existing_batches: Vec<arrow::record_batch::RecordBatch> = existing_reader
        .collect::<Result<_, _>>()
        .map_err(|e| format!("appendArrowIpc: read existing batches: {e}"))?;

    let new_reader = arrow::ipc::reader::StreamReader::try_new(Cursor::new(new_bytes), None)
        .map_err(|e| format!("appendArrowIpc: parse new: {e}"))?;
    let new_schema = new_reader.schema();
    let new_batches: Vec<arrow::record_batch::RecordBatch> = new_reader
        .collect::<Result<_, _>>()
        .map_err(|e| format!("appendArrowIpc: read new batches: {e}"))?;

    if !schemas_compatible(&existing_schema, &new_schema) {
        return Err(format!(
            "appendArrowIpc: schema mismatch — existing has {} fields, new has {} fields",
            existing_schema.fields().len(),
            new_schema.fields().len(),
        ));
    }

    let mut out: Vec<u8> = Vec::new();
    {
        let mut writer = arrow::ipc::writer::StreamWriter::try_new(&mut out, &existing_schema)
            .map_err(|e| format!("appendArrowIpc: writer init: {e}"))?;
        for b in existing_batches.iter() {
            writer
                .write(b)
                .map_err(|e| format!("appendArrowIpc: write existing batch: {e}"))?;
        }
        for b in new_batches.iter() {
            writer
                .write(b)
                .map_err(|e| format!("appendArrowIpc: write new batch: {e}"))?;
        }
        writer
            .finish()
            .map_err(|e| format!("appendArrowIpc: writer finish: {e}"))?;
    }
    Ok(out)
}

fn schemas_compatible(a: &arrow::datatypes::Schema, b: &arrow::datatypes::Schema) -> bool {
    if a.fields().len() != b.fields().len() {
        return false;
    }
    a.fields().iter().zip(b.fields().iter()).all(|(fa, fb)| {
        fa.name() == fb.name()
            && fa.data_type() == fb.data_type()
            && fa.is_nullable() == fb.is_nullable()
    })
}

fn run_polars_sql_ipc_inner(
    sql: String,
    tables: HashMap<String, Vec<u8>>,
) -> Result<Vec<CellOutput>, String> {
    let mut ctx = SQLContext::new();

    for (name, bytes) in tables {
        // Native Polars IPC stream reader — direct path. Replaces the
        // earlier arrow-rs → CSV bridge once homebrew-clang routing
        // unblocked zstd-sys / lz4-sys C compilation for wasm32.
        let df = IpcStreamReader::new(Cursor::new(bytes))
            .finish()
            .map_err(|e| format!("polars ipc parse for table '{name}': {e}"))?;
        ctx.register(&name, df.lazy());
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
