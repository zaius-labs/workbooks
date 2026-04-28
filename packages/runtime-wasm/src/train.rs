//! Linfa training cell dispatcher — classical ML in WASM.
//!
//! Cell language: `CELL_LANGUAGE_LINFA_TRAIN`. Spec declares an algorithm
//! (random_forest, k_means, regression, svm), dataset reference, and
//! hyperparameters.
//!
//! TODO P4.4: wire Linfa with the workbook data layer; emit a machine block
//! version entry on training completion.

use crate::outputs::CellOutput;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrainCellRequest {
    pub spec: serde_json::Value,
    #[serde(default)]
    pub params: serde_json::Value,
}

pub fn run_train_cell(_req: TrainCellRequest) -> Result<Vec<CellOutput>, String> {
    Err("linfa-train cell dispatcher not yet implemented (P4.4)".into())
}
