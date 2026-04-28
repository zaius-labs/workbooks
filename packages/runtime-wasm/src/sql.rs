//! SQL cell dispatcher — runs DuckDB-WASM queries against the embedded data layer.
//!
//! Cell language: `CELL_LANGUAGE_SQL`. Source is a DuckDB SQL string.
//! Parameters bind as named: `WHERE created_at >= :start`.
//!
//! TODO P3.1: wire DuckDB-WASM, accept Cell + params, return Arrow IPC.

use crate::outputs::CellOutput;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlCellRequest {
    pub source: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

pub fn run_sql_cell(_req: SqlCellRequest) -> Result<Vec<CellOutput>, String> {
    Err("sql cell dispatcher not yet implemented (P3.1)".into())
}
