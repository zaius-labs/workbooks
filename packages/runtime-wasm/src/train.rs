//! Linfa training cell dispatcher — classical ML in WASM.
//!
//! Cell language: `CELL_LANGUAGE_LINFA_TRAIN`. Spec declares an algorithm
//! (random_forest, k_means, regression, svm), dataset reference, and
//! hyperparameters.
//!
//! Status: P4.4 scaffold. Linfa-core + linfa-trees + linfa-clustering +
//! linfa-linear link in when the `linfa` feature is enabled. The
//! smoke-test path proves the toolchain works — fits a tiny linear model
//! and returns the coefficients. Full dataset-driven training (with the
//! workbook data layer) lands incrementally.

use crate::outputs::CellOutput;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrainCellRequest {
    pub spec: serde_json::Value,
    #[serde(default)]
    pub params: serde_json::Value,
}

pub fn run_train_cell(_req: TrainCellRequest) -> Result<Vec<CellOutput>, String> {
    Err("linfa-train cell dispatcher: full pipeline not yet wired (P4.4+)".into())
}

/// Smoke-test entry — proves Linfa is alive in the WASM bundle by fitting
/// a trivial 1-feature linear regression. Returns the slope + intercept.
///
/// Used by `examples/linfa-smoke/` (future) + P4.7 benchmarks.
#[wasm_bindgen(js_name = linfaSmokeTest)]
pub fn linfa_smoke_test() -> Result<JsValue, JsValue> {
    use linfa::traits::Fit;
    use linfa::Dataset;
    use linfa_linear::LinearRegression;
    use ndarray::{array, Array2};

    // y = 2x + 1 with a tiny bit of noise.
    let xs: Array2<f64> = array![[1.0], [2.0], [3.0], [4.0], [5.0]];
    let ys = array![3.0, 5.0, 7.1, 9.0, 11.0];

    let dataset = Dataset::new(xs, ys);
    let model = LinearRegression::default()
        .fit(&dataset)
        .map_err(|e| JsValue::from_str(&format!("linfa fit: {e}")))?;

    let coefficients = model.params();
    let intercept = model.intercept();

    let summary = format!(
        "slope={:.4}, intercept={:.4}",
        coefficients[0], intercept
    );

    let outputs = vec![CellOutput::Text {
        content: summary,
        mime_type: Some("text/plain".into()),
    }];
    serde_wasm_bindgen::to_value(&outputs).map_err(Into::into)
}
