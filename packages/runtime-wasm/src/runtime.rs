//! Runtime instance lifecycle — implements the `WorkbookRuntimeService` from
//! `proto/signal/runtime/v1/runtime.proto` directly in-page.
//!
//! Tier 1 (browser): the runtime is the WASM module loaded into the page;
//! method calls are JS function calls.
//! Tier 2/3: the same runtime served behind Connect over HTTP.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitRuntimeRequest {
    pub workbook_slug: String,
    pub environment: Environment,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitRuntimeResponse {
    pub runtime_id: String,
    pub init_ms: u32,
    pub warm_start: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Environment {
    pub runtime_features: Vec<String>,
    #[serde(default)]
    pub model_artifacts: Vec<ModelArtifactRef>,
    #[serde(default)]
    pub tier3_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelArtifactRef {
    pub name: String,
    pub url: String,
    pub format: String,
    pub size: i64,
    pub sha256: String,
}

/// Initialize a runtime instance for the given workbook.
///
/// Loads sql.js / DuckDB-WASM, initializes Polars LazyFrame engine, and
/// wires up any other feature slices the workbook declared. Returns a
/// `runtime_id` the caller passes back into `run_cell()`.
#[wasm_bindgen(js_name = initRuntime)]
pub fn init_runtime(req: JsValue) -> Result<JsValue, JsValue> {
    let req: InitRuntimeRequest = serde_wasm_bindgen::from_value(req)?;
    let start = js_sys::Date::now();

    // TODO P2.2: actual initialization of feature slices.
    // - SQL: instantiate DuckDB-WASM database from embedded data layer
    // - Polars: prepare LazyFrame execution context
    // - Candle: download model_artifacts (cache-first via IndexedDB)
    // - Linfa: nothing to init beyond crate features

    let runtime_id = format!("rt-{}", req.workbook_slug);
    let init_ms = (js_sys::Date::now() - start) as u32;

    let resp = InitRuntimeResponse {
        runtime_id,
        init_ms,
        warm_start: false,
    };
    serde_wasm_bindgen::to_value(&resp).map_err(Into::into)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PauseRuntimeRequest {
    pub runtime_id: String,
}

#[wasm_bindgen(js_name = pauseRuntime)]
pub fn pause_runtime(_req: JsValue) -> Result<JsValue, JsValue> {
    // TODO: persist in-memory state to IndexedDB so subsequent reopens warm-start.
    Ok(JsValue::NULL)
}

#[wasm_bindgen(js_name = destroyRuntime)]
pub fn destroy_runtime(_req: JsValue) -> Result<JsValue, JsValue> {
    // TODO: drop all bound state, free WASM memory.
    Ok(JsValue::NULL)
}
