//! Signal Workbook execution runtime — WASM entry point.
//!
//! This crate is compiled to WebAssembly and shipped as the workbook's
//! execution layer. It provides the cell dispatchers that match each cell
//! `language` (sql, polars, rhai, candle-inference, linfa-train, chart,
//! wasm-fn) and runs them client-side in the browser.
//!
//! ## Architecture
//!
//! ```text
//!     +---------------------+    +---------------------+
//!     | Workbook.svelte     |    | @signal/workbook-   |
//!     | (UI runtime)        |--->| runtime-wasm (this) |
//!     +---------------------+    +---------------------+
//!         JS bridge via wasm-bindgen
//!                  |
//!                  v
//!     +---------------------+
//!     | Polars / DuckDB /   |
//!     | Candle / Linfa / .. |
//!     +---------------------+
//! ```
//!
//! ## Loading
//!
//! The bundle is loaded once per session from the CDN (or inlined in
//! `portable` export mode). The `init_runtime()` entry point initializes
//! the runtime with the feature slices requested by
//! `manifest.environment.runtimeFeatures`.
//!
//! ## Tree-shaking
//!
//! Each cell language is gated behind a Cargo feature (see `Cargo.toml`).
//! Workbooks that don't use Candle or Burn don't pay their bundle-size cost.
//!
//! ## Reference
//!
//! - `docs/WORKBOOK_SPEC.md` — full spec
//! - `docs/WORKBOOK_RUST_PIVOT.md` — pivot rationale + tool migration

use wasm_bindgen::prelude::*;

// Core (always on) — wb-doc registration glue, panic-forwarding, the
// runtime client struct itself. Stays minimal so app-shape workbooks
// (color.wave) can opt out of every cell-engine + IO module below.
pub mod bridge;
pub mod runtime;

// Phase 3 opt-out features. These are default-on so existing workbook
// builds keep working unchanged, but `--no-default-features` (or
// `--features=...` listing only what's needed) drops their weight.
#[cfg(feature = "cell-outputs")]
pub mod outputs;

#[cfg(feature = "history-prolly")]
pub mod prolly;

#[cfg(feature = "arrow")]
pub mod arrow_json;

#[cfg(feature = "crypto")]
pub mod crypto;

#[cfg(feature = "polars-frames")]
pub mod frames;

#[cfg(feature = "charts")]
pub mod charts;

#[cfg(feature = "rhai-glue")]
pub mod scripting;

#[cfg(feature = "candle")]
pub mod inference;

#[cfg(feature = "onnx")]
pub mod onnx;

#[cfg(feature = "linfa")]
pub mod train;

#[cfg(feature = "vectors")]
pub mod vectors;

#[cfg(feature = "embeddings")]
pub mod embed;

/// Library-load hook. Wires up panic forwarding to the JS console so a panic
/// in any cell surfaces as a readable error in the workbook UI rather than a
/// silent abort.
#[wasm_bindgen(start)]
pub fn on_load() {
    console_error_panic_hook::set_once();
}

/// Build metadata for compatibility checks against the manifest's
/// `runtime.bundleVersion` and `runtime.contractVersion`.
#[wasm_bindgen]
pub fn build_info() -> JsValue {
    use serde::Serialize;
    let info = serde_json::json!({
        "name": env!("CARGO_PKG_NAME"),
        "version": env!("CARGO_PKG_VERSION"),
        "contract_version": "1.0",
        "features": active_features(),
    });
    // Serialize JSON Object as a JS plain object (default is Map),
    // so callers can do `info.contract_version` not `info.get(...)`.
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    info.serialize(&serializer).unwrap_or(JsValue::NULL)
}

fn active_features() -> Vec<&'static str> {
    let mut features: Vec<&'static str> = Vec::new();
    #[cfg(feature = "polars-frames")]
    features.push("polars");
    #[cfg(feature = "charts")]
    features.push("plotters");
    #[cfg(feature = "rhai-glue")]
    features.push("rhai");
    #[cfg(feature = "candle")]
    features.push("candle");
    #[cfg(feature = "onnx")]
    features.push("onnx");
    #[cfg(feature = "linfa")]
    features.push("linfa");
    #[cfg(feature = "burn")]
    features.push("burn");
    #[cfg(feature = "stats")]
    features.push("stats");
    #[cfg(feature = "vectors")]
    features.push("vectors");
    #[cfg(feature = "tokenizers")]
    features.push("tokenizers");
    #[cfg(feature = "image-ops")]
    features.push("image");
    features
}
