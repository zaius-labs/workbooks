//! JS bridge — wasm-bindgen exports for the Svelte UI layer.
//!
//! `@signal/workbook-runtime` (the npm package) imports these and wraps them
//! in a Connect-shaped client that matches the `WorkbookRuntimeService`
//! Protobuf definition. Same method names, same wire format — just executed
//! in-page rather than over HTTP.

use crate::runtime::{init_runtime, pause_runtime, destroy_runtime};

// Re-exports — keeps the JS-side import surface flat.
pub use init_runtime as bridge_init_runtime;
pub use pause_runtime as bridge_pause_runtime;
pub use destroy_runtime as bridge_destroy_runtime;
