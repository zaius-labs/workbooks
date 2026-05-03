//! Generic ONNX model runner via Candle.
//!
//! Exposes three primitives the JS side composes into per-model
//! pipelines:
//!
//!   onnxLoad(modelBytes)         → handle (u32 id)
//!   onnxRun(handle, inputs)      → outputs
//!   onnxFree(handle)             → ()
//!   imageToTensorRgb(...)        → { data, shape } (CHW float32, 1×3×H×W)
//!
//! Parsing the ONNX proto is non-trivial (~tens of MB models); we
//! cache the parsed graph in a thread-local registry keyed by an
//! integer handle so subsequent runs skip the parse.
//!
//! Tensor I/O uses serde-wasm-bindgen — JS sends and receives plain
//! objects of shape `{ data: Float32Array, shape: number[] }`, with
//! the data marshalled as a regular JS array of numbers (loud but
//! works; specialized typed-array round-tripping can come later).
//!
//! Status: foundational. Each consumer cell layers preprocessing +
//! post-processing on top of `onnxRun`. Candle's ONNX op coverage is
//! incomplete; specific models may still surface "unsupported op"
//! errors at first run — surface those to the JS side so the cell
//! UI can fall back gracefully.

use candle_core::{DType, Device, Tensor};
use candle_onnx::{onnx::ModelProto, simple_eval};
use image::imageops::FilterType;
use image::ImageReader;
use prost::Message;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Cursor;
use wasm_bindgen::prelude::*;

thread_local! {
    static MODELS: RefCell<HashMap<u32, ModelProto>> = RefCell::new(HashMap::new());
    static NEXT_ID: RefCell<u32> = const { RefCell::new(1) };
}

/// Wire format for tensor I/O across the JS boundary. `data` is a flat
/// row-major float32 buffer; `shape` describes the dimensions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TensorJs {
    pub data: Vec<f32>,
    pub shape: Vec<usize>,
}

/// Parse an ONNX model from raw bytes and stash it in the registry.
/// Returns a handle the caller passes to `onnxRun` / `onnxFree`.
#[wasm_bindgen(js_name = onnxLoad)]
pub fn onnx_load(bytes: &[u8]) -> Result<u32, JsValue> {
    let model = ModelProto::decode(bytes)
        .map_err(|e| JsValue::from_str(&format!("decode onnx proto: {e}")))?;
    let id = NEXT_ID.with(|n| {
        let mut n = n.borrow_mut();
        let id = *n;
        *n = id.wrapping_add(1);
        id
    });
    MODELS.with(|m| m.borrow_mut().insert(id, model));
    Ok(id)
}

/// Drop a previously-loaded model, freeing its memory. Calling free on
/// an unknown id is a no-op (so the JS side can call it defensively
/// without first checking existence).
#[wasm_bindgen(js_name = onnxFree)]
pub fn onnx_free(handle: u32) {
    MODELS.with(|m| {
        m.borrow_mut().remove(&handle);
    });
}

/// Run inference on a previously-loaded model.
///
/// `inputs` is a JS object `{ name: TensorJs }`. The returned value is
/// shaped the same — `{ name: TensorJs }` — for every output the model
/// declares.
///
/// Errors from candle-onnx (unsupported op, shape mismatch, missing
/// input) are surfaced verbatim so the JS side can show useful
/// diagnostics.
#[wasm_bindgen(js_name = onnxRun)]
pub fn onnx_run(handle: u32, inputs: JsValue) -> Result<JsValue, JsValue> {
    let inputs_map: HashMap<String, TensorJs> = serde_wasm_bindgen::from_value(inputs)
        .map_err(|e| JsValue::from_str(&format!("decode inputs: {e}")))?;

    let device = Device::Cpu;
    let mut tensors: HashMap<String, Tensor> = HashMap::with_capacity(inputs_map.len());
    for (name, t) in inputs_map.into_iter() {
        let shape = t.shape.as_slice();
        let tensor = Tensor::from_vec(t.data, shape, &device)
            .map_err(|e| JsValue::from_str(&format!("tensor {name}: {e}")))?;
        tensors.insert(name, tensor);
    }

    let outputs = MODELS.with(|m| -> Result<HashMap<String, Tensor>, JsValue> {
        let m = m.borrow();
        let model = m
            .get(&handle)
            .ok_or_else(|| JsValue::from_str(&format!("onnx model handle {handle} not loaded")))?;
        simple_eval(model, tensors).map_err(|e| JsValue::from_str(&format!("onnx eval: {e}")))
    })?;

    let mut out_js: HashMap<String, TensorJs> = HashMap::with_capacity(outputs.len());
    for (name, t) in outputs.into_iter() {
        let shape = t
            .dims()
            .iter()
            .copied()
            .collect::<Vec<usize>>();
        // Flatten to f32 — promote f64 / f16, etc. so the JS side has
        // one type to deal with. Models that legitimately need other
        // dtypes can opt out later.
        let data = match t.dtype() {
            DType::F32 => t
                .flatten_all()
                .and_then(|f| f.to_vec1::<f32>())
                .map_err(|e| JsValue::from_str(&format!("output {name} → f32: {e}")))?,
            other => {
                let f = t
                    .to_dtype(DType::F32)
                    .and_then(|f| f.flatten_all())
                    .and_then(|f| f.to_vec1::<f32>())
                    .map_err(|e| JsValue::from_str(&format!("output {name} ({other:?}) → f32: {e}")))?;
                f
            }
        };
        out_js.insert(name, TensorJs { data, shape });
    }

    // Serialize HashMap as a plain JS object (default would be a Map),
    // so callers can do `outputs.predicted_depth` and `Object.keys(...)`.
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    out_js
        .serialize(&serializer)
        .map_err(|e| JsValue::from_str(&format!("encode outputs: {e}")))
}

/// Decode an image (jpeg/png/webp/etc), resize to (width × height),
/// normalize per-channel with the given mean/std, and emit a
/// CHW-ordered float32 tensor of shape `[1, 3, height, width]`.
///
/// Standard ImageNet defaults:
///   mean = [0.485, 0.456, 0.406]
///   std  = [0.229, 0.224, 0.225]
///
/// CLIP defaults:
///   mean = [0.48145466, 0.4578275, 0.40821073]
///   std  = [0.26862954, 0.26130258, 0.27577711]
#[wasm_bindgen(js_name = imageToTensorRgb)]
pub fn image_to_tensor_rgb(
    bytes: &[u8],
    width: u32,
    height: u32,
    mean: Vec<f32>,
    std: Vec<f32>,
) -> Result<JsValue, JsValue> {
    if mean.len() != 3 || std.len() != 3 {
        return Err(JsValue::from_str("mean and std must be length 3"));
    }
    let img = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| JsValue::from_str(&format!("guess format: {e}")))?
        .decode()
        .map_err(|e| JsValue::from_str(&format!("decode image: {e}")))?;
    let resized = img.resize_exact(width, height, FilterType::Triangle).to_rgb8();

    let w = width as usize;
    let h = height as usize;
    let mut data = vec![0f32; 3 * h * w];
    // CHW order: channel 0 (R) packed first, then G, then B.
    for y in 0..h {
        for x in 0..w {
            let p = resized.get_pixel(x as u32, y as u32);
            let r = (p[0] as f32 / 255.0 - mean[0]) / std[0];
            let g = (p[1] as f32 / 255.0 - mean[1]) / std[1];
            let b = (p[2] as f32 / 255.0 - mean[2]) / std[2];
            data[0 * h * w + y * w + x] = r;
            data[1 * h * w + y * w + x] = g;
            data[2 * h * w + y * w + x] = b;
        }
    }
    let out = TensorJs {
        data,
        shape: vec![1, 3, h, w],
    };
    serde_wasm_bindgen::to_value(&out).map_err(Into::into)
}
