//! Generic JSON ↔ Arrow IPC encoder for the JS bridge.
//!
//! Lets host code (e.g. hyperframes' chat thread persistence) emit
//! and read Arrow IPC batches without an Arrow JS dep — the runtime
//! WASM already ships arrow-rs so we expose the conversion as
//! wasm-bindgen entries.
//!
//! Phase-1 supported types: "utf8", "i64". Add types as the host
//! needs them — bool, f64, list, etc. are simple extensions.
//!
//! Schema input shape:
//!   { "fields": [{ "name": "...", "type": "utf8", "nullable": false }] }
//!
//! Rows input shape:
//!   [{ "field_name": value, ... }, ...]
//!
//! Encode emits a complete Arrow IPC stream containing one record
//! batch per call. Decode walks every batch in the stream and
//! returns the rows as a JSON array.

use arrow::array::{Array, ArrayRef, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::ipc::writer::StreamWriter;
use arrow::record_batch::RecordBatch;
use serde::Deserialize;
use std::io::Cursor;
use std::sync::Arc;
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
struct SchemaInput {
    fields: Vec<FieldInput>,
}

#[derive(Deserialize)]
struct FieldInput {
    name: String,
    #[serde(rename = "type")]
    ty: String,
    #[serde(default)]
    nullable: bool,
}

fn datatype_for(ty: &str) -> Result<DataType, String> {
    match ty {
        "utf8" | "string" => Ok(DataType::Utf8),
        "i64" | "int64" => Ok(DataType::Int64),
        other => Err(format!(
            "arrow_json: unsupported field type '{other}' (supported: utf8, i64)"
        )),
    }
}

#[wasm_bindgen(js_name = arrowEncodeJsonRows)]
pub fn arrow_encode_json_rows(schema_json: String, rows_json: String) -> Result<Vec<u8>, JsValue> {
    encode_inner(&schema_json, &rows_json).map_err(|e| JsValue::from_str(&e))
}

fn encode_inner(schema_json: &str, rows_json: &str) -> Result<Vec<u8>, String> {
    let schema_input: SchemaInput = serde_json::from_str(schema_json)
        .map_err(|e| format!("arrow_json: schema parse: {e}"))?;
    let rows: Vec<serde_json::Map<String, serde_json::Value>> = serde_json::from_str(rows_json)
        .map_err(|e| format!("arrow_json: rows parse: {e}"))?;

    let mut fields = Vec::with_capacity(schema_input.fields.len());
    for f in &schema_input.fields {
        fields.push(Field::new(&f.name, datatype_for(&f.ty)?, f.nullable));
    }
    let schema = Arc::new(Schema::new(fields));

    let mut columns: Vec<ArrayRef> = Vec::with_capacity(schema_input.fields.len());
    for f in &schema_input.fields {
        match f.ty.as_str() {
            "utf8" | "string" => {
                let vals: Vec<Option<&str>> = rows
                    .iter()
                    .map(|r| r.get(&f.name).and_then(|v| v.as_str()))
                    .collect();
                columns.push(Arc::new(StringArray::from(vals)));
            }
            "i64" | "int64" => {
                let vals: Vec<Option<i64>> = rows
                    .iter()
                    .map(|r| r.get(&f.name).and_then(|v| v.as_i64()))
                    .collect();
                columns.push(Arc::new(Int64Array::from(vals)));
            }
            _ => unreachable!("datatype_for would have rejected this earlier"),
        }
    }

    let batch = RecordBatch::try_new(schema.clone(), columns)
        .map_err(|e| format!("arrow_json: build batch: {e}"))?;

    let mut buf = Vec::<u8>::new();
    {
        let mut writer = StreamWriter::try_new(&mut buf, &schema)
            .map_err(|e| format!("arrow_json: writer init: {e}"))?;
        writer
            .write(&batch)
            .map_err(|e| format!("arrow_json: write batch: {e}"))?;
        writer
            .finish()
            .map_err(|e| format!("arrow_json: writer finish: {e}"))?;
    }
    Ok(buf)
}

#[wasm_bindgen(js_name = arrowDecodeToJsonRows)]
pub fn arrow_decode_to_json_rows(bytes: Vec<u8>) -> Result<String, JsValue> {
    decode_inner(&bytes).map_err(|e| JsValue::from_str(&e))
}

fn decode_inner(bytes: &[u8]) -> Result<String, String> {
    let reader = arrow::ipc::reader::StreamReader::try_new(Cursor::new(bytes), None)
        .map_err(|e| format!("arrow_json: reader init: {e}"))?;
    let mut out: Vec<serde_json::Map<String, serde_json::Value>> = Vec::new();

    for batch_result in reader {
        let batch = batch_result.map_err(|e| format!("arrow_json: read batch: {e}"))?;
        let schema = batch.schema();
        for row in 0..batch.num_rows() {
            let mut obj = serde_json::Map::new();
            for (col_idx, field) in schema.fields().iter().enumerate() {
                let col = batch.column(col_idx);
                let val: serde_json::Value = match field.data_type() {
                    DataType::Utf8 => {
                        let arr = col
                            .as_any()
                            .downcast_ref::<StringArray>()
                            .ok_or("arrow_json: utf8 column downcast")?;
                        if arr.is_null(row) {
                            serde_json::Value::Null
                        } else {
                            serde_json::Value::String(arr.value(row).to_string())
                        }
                    }
                    DataType::Int64 => {
                        let arr = col
                            .as_any()
                            .downcast_ref::<Int64Array>()
                            .ok_or("arrow_json: i64 column downcast")?;
                        if arr.is_null(row) {
                            serde_json::Value::Null
                        } else {
                            serde_json::Value::Number(arr.value(row).into())
                        }
                    }
                    other => {
                        return Err(format!(
                            "arrow_json: unsupported decode type {other:?} on field '{}'",
                            field.name()
                        ));
                    }
                };
                obj.insert(field.name().to_string(), val);
            }
            out.push(obj);
        }
    }

    serde_json::to_string(&out).map_err(|e| format!("arrow_json: json encode: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_utf8_and_i64() {
        let schema = r#"{"fields":[
            {"name":"id","type":"utf8"},
            {"name":"ts","type":"i64"}
        ]}"#;
        let rows = r#"[
            {"id":"a","ts":1},
            {"id":"b","ts":2},
            {"id":"c","ts":3}
        ]"#;
        let bytes = encode_inner(schema, rows).expect("encode");
        let decoded = decode_inner(&bytes).expect("decode");
        let parsed: Vec<serde_json::Value> =
            serde_json::from_str(&decoded).expect("parse decoded");
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0]["id"], "a");
        assert_eq!(parsed[2]["ts"], 3);
    }

    #[test]
    fn unsupported_type_errors() {
        let schema = r#"{"fields":[{"name":"x","type":"f64"}]}"#;
        let result = encode_inner(schema, "[]");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unsupported"));
    }
}
