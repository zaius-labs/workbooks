//! Candle inference cell dispatcher — runs ML model inference in WASM.
//!
//! Cell language: `CELL_LANGUAGE_CANDLE_INFERENCE`. Spec declares a model
//! reference (from manifest.environment.modelArtifacts) plus input binding
//! and output spec.
//!
//! TODO P4.1: load model artifact (IndexedDB cache + SHA verify), run
//! inference via Candle, emit text/tensor output.

use crate::outputs::CellOutput;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceCellRequest {
    pub spec: serde_json::Value,
    #[serde(default)]
    pub params: serde_json::Value,
}

pub fn run_inference_cell(_req: InferenceCellRequest) -> Result<Vec<CellOutput>, String> {
    Err("candle-inference cell dispatcher not yet implemented (P4.1)".into())
}
