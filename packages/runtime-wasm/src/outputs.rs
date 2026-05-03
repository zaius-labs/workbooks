//! Cell output types — mirror `workbook.v1.CellOutput` from the proto schema.
//!
//! Cells emit a stream of these as they execute. The bridge serializes them
//! across the JS boundary as JSON; tier 2/3 hosts serialize as Protobuf.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CellOutput {
    /// Plain text output (e.g. stdout, scalar result, structured log).
    Text {
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
    },
    /// Image output as base64-encoded bytes (PNG/SVG/JPEG).
    Image {
        content: String,           // base64
        mime_type: String,         // image/png, image/svg+xml, etc.
    },
    /// Tabular output — references a table written into the data layer.
    Table {
        sql_table: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        row_count: Option<i64>,
    },
    /// Execution error with traceback.
    Error {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        traceback: Option<String>,
    },
    /// Streaming chunk (replaced by typed output on completion).
    Stream {
        content: String,
    },
}

impl CellOutput {
    pub fn text(s: impl Into<String>) -> Self {
        Self::Text { content: s.into(), mime_type: None }
    }

    pub fn error(msg: impl Into<String>) -> Self {
        Self::Error { message: msg.into(), traceback: None }
    }
}
