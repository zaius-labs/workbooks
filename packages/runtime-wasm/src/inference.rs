//! Candle inference cell dispatcher — runs ML model inference in WASM.
//!
//! Cell language: `CELL_LANGUAGE_CANDLE_INFERENCE`. Spec declares a model
//! reference (from manifest.runtime.modelArtifacts) plus input binding
//! and output spec.
//!
//! Status: P4.1 scaffold. Candle-core + candle-nn link in when the
//! `candle` feature is enabled. The smoke-test path proves the toolchain
//! works — instantiate a tensor, run a basic op, return the result.
//! Full model-loading + inference (using the modelArtifactResolver
//! cache from the JS side) lands incrementally; this scaffold unblocks
//! that work by proving Candle compiles to wasm32 with the rest of the
//! runtime.

use crate::outputs::CellOutput;
use candle_core::{Device, Tensor};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceCellRequest {
    pub spec: serde_json::Value,
    #[serde(default)]
    pub params: serde_json::Value,
}

pub fn run_inference_cell(_req: InferenceCellRequest) -> Result<Vec<CellOutput>, String> {
    Err("candle-inference cell dispatcher: full model pipeline not yet wired (P4.1+)".into())
}

/// Smoke-test entry — proves Candle is alive in the WASM bundle by doing
/// a trivial tensor operation. Returns the result as a stringified vec.
///
/// Used by the future `examples/candle-smoke/` demo and by P4.7 benchmarks
/// to capture the cold-start cost of Candle initialization separately
/// from the cost of actual model loading.
#[wasm_bindgen(js_name = candleSmokeTest)]
pub fn candle_smoke_test() -> Result<JsValue, JsValue> {
    let device = Device::Cpu;
    let a = Tensor::new(&[1.0f32, 2.0, 3.0, 4.0], &device)
        .map_err(|e| JsValue::from_str(&format!("tensor: {e}")))?;
    let b = Tensor::new(&[10.0f32, 20.0, 30.0, 40.0], &device)
        .map_err(|e| JsValue::from_str(&format!("tensor: {e}")))?;
    let sum = (&a + &b).map_err(|e| JsValue::from_str(&format!("add: {e}")))?;
    let values: Vec<f32> = sum
        .to_vec1::<f32>()
        .map_err(|e| JsValue::from_str(&format!("to_vec1: {e}")))?;

    let outputs = vec![CellOutput::Text {
        content: format!("{values:?}"),
        mime_type: Some("text/plain".into()),
    }];
    serde_wasm_bindgen::to_value(&outputs).map_err(Into::into)
}

/// Heavier tensor-op demo (T1.1) — runs three ops typical of a real ML
/// workload and reports wall-clock timing + first few output values:
///
///   matmul:   (N x N) @ (N x N) where N = 256 by default
///   softmax:  length-1024 vector
///   conv2d:   (1 x 3 x 32 x 32) input × (8 x 3 x 3 x 3) filter
///
/// Used by `examples/candle-ops/` to demonstrate the heavy compute path
/// in the browser (beyond the trivial 4-element add). Numbers compare
/// against the JS reference baseline in the demo's UI.
#[wasm_bindgen(js_name = runCandleOps)]
pub fn run_candle_ops(matmul_n: u32) -> Result<JsValue, JsValue> {
    let device = Device::Cpu;
    let n = matmul_n.max(8) as usize;

    // Build deterministic inputs from a stride pattern. Using deterministic
    // inputs keeps the output values stable across runs so the demo can
    // sanity-check correctness (rather than just timing).
    let a_data: Vec<f32> = (0..n * n).map(|i| ((i % 17) as f32) * 0.05 - 0.4).collect();
    let b_data: Vec<f32> = (0..n * n).map(|i| ((i * 3 % 13) as f32) * 0.1 - 0.6).collect();

    let a = Tensor::from_vec(a_data, (n, n), &device)
        .map_err(|e| JsValue::from_str(&format!("matmul a: {e}")))?;
    let b = Tensor::from_vec(b_data, (n, n), &device)
        .map_err(|e| JsValue::from_str(&format!("matmul b: {e}")))?;

    let t0 = now_ms();
    let c = a.matmul(&b)
        .map_err(|e| JsValue::from_str(&format!("matmul: {e}")))?;
    let matmul_ms = now_ms() - t0;
    let matmul_sample = c.flatten_all()
        .and_then(|t| t.to_vec1::<f32>())
        .map(|v| v.into_iter().take(4).collect::<Vec<_>>())
        .unwrap_or_default();

    // Softmax over a 1024-vec.
    let v_data: Vec<f32> = (0..1024).map(|i| (i as f32 * 0.01).sin()).collect();
    let v = Tensor::from_vec(v_data, 1024, &device)
        .map_err(|e| JsValue::from_str(&format!("softmax v: {e}")))?;
    let t1 = now_ms();
    let s = candle_nn::ops::softmax(&v, 0)
        .map_err(|e| JsValue::from_str(&format!("softmax: {e}")))?;
    let softmax_ms = now_ms() - t1;
    let softmax_sample = s.to_vec1::<f32>()
        .map(|v| v.into_iter().take(4).collect::<Vec<_>>())
        .unwrap_or_default();

    // Conv2d: (1, 3, 32, 32) input × (8, 3, 3, 3) filter, no padding, stride 1.
    let input_data: Vec<f32> = (0..(1 * 3 * 32 * 32))
        .map(|i| ((i % 7) as f32) * 0.1)
        .collect();
    let weights_data: Vec<f32> = (0..(8 * 3 * 3 * 3))
        .map(|i| ((i % 11) as f32) * 0.05 - 0.25)
        .collect();
    let input = Tensor::from_vec(input_data, (1, 3, 32, 32), &device)
        .map_err(|e| JsValue::from_str(&format!("conv input: {e}")))?;
    let weights = Tensor::from_vec(weights_data, (8, 3, 3, 3), &device)
        .map_err(|e| JsValue::from_str(&format!("conv weights: {e}")))?;
    let t2 = now_ms();
    let conv_out = input.conv2d(&weights, 0, 1, 1, 1)
        .map_err(|e| JsValue::from_str(&format!("conv2d: {e}")))?;
    let conv_ms = now_ms() - t2;
    let conv_shape = conv_out.dims().to_vec();
    let conv_sample = conv_out.flatten_all()
        .and_then(|t| t.to_vec1::<f32>())
        .map(|v| v.into_iter().take(4).collect::<Vec<_>>())
        .unwrap_or_default();

    let info = serde_json::json!({
        "matmul": {
            "shape": [n, n],
            "ms": matmul_ms,
            "sample": matmul_sample,
        },
        "softmax": {
            "len": 1024,
            "ms": softmax_ms,
            "sample": softmax_sample,
        },
        "conv2d": {
            "input_shape": [1, 3, 32, 32],
            "filter_shape": [8, 3, 3, 3],
            "output_shape": conv_shape,
            "ms": conv_ms,
            "sample": conv_sample,
        },
    });
    // serde_wasm_bindgen serializes JSON Object as JS `Map` by default.
    // Use maps-as-objects so JS callers can do `result.matmul.ms` instead
    // of `result.get("matmul").get("ms")`.
    use serde::Serialize;
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    info.serialize(&serializer).map_err(Into::into)
}

fn now_ms() -> f64 {
    js_sys::Date::now()
}
