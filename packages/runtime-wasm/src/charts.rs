//! Chart cell dispatcher — renders Plotters charts to SVG/PNG.
//!
//! Cell language: `CELL_LANGUAGE_CHART`. Spec is a declarative chart binding
//! (type + sql_table + x/y fields + style config).
//!
//! TODO P3.3: parse spec, query underlying table, render via Plotters, emit
//! base64 image output.

use crate::outputs::CellOutput;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChartCellRequest {
    pub spec: serde_json::Value,
}

pub fn run_chart_cell(_req: ChartCellRequest) -> Result<Vec<CellOutput>, String> {
    Err("chart cell dispatcher not yet implemented (P3.3)".into())
}
