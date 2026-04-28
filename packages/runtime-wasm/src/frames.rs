//! Polars cell dispatcher — runs LazyFrame chains against the data layer.
//!
//! Cell language: `CELL_LANGUAGE_POLARS`. Spec is a structured JSON describing
//! a sequence of Polars operations (filter, group_by, agg, join, ...).
//!
//! TODO P3.2: parse spec → LazyFrame plan, execute, return Arrow IPC.

use crate::outputs::CellOutput;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolarsCellRequest {
    pub spec: serde_json::Value,
    #[serde(default)]
    pub params: serde_json::Value,
}

pub fn run_polars_cell(_req: PolarsCellRequest) -> Result<Vec<CellOutput>, String> {
    Err("polars cell dispatcher not yet implemented (P3.2)".into())
}
