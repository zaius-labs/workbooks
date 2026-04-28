//! Rhai cell dispatcher — orchestrates calls into the WASM runtime.
//!
//! Cell language: `CELL_LANGUAGE_RHAI`. Source is a Rhai script that calls
//! into runtime functions (load, run_polars, run_inference, etc.) and binds
//! results into the cell's `provides` set.
//!
//! TODO P3+: wire Rhai engine with workbook runtime API exposed.

use crate::outputs::CellOutput;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RhaiCellRequest {
    pub source: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

pub fn run_rhai_cell(_req: RhaiCellRequest) -> Result<Vec<CellOutput>, String> {
    Err("rhai cell dispatcher not yet implemented (P3+)".into())
}
