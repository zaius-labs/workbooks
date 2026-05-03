//! JS bridge — wasm-bindgen exports for the Svelte UI layer.
//!
//! `@workbook/runtime` (the npm package) imports the wasm-bindgen-generated
//! functions from `runtime.rs` (and the per-language cell modules) and wraps
//! them in a Connect-shaped client that matches the `WorkbookRuntimeService`
//! Protobuf definition. Same method names, same wire format — just executed
//! in-page rather than over HTTP.
//!
//! No exports live in this file directly. The `#[wasm_bindgen]`-annotated
//! functions in sibling modules are picked up automatically by wasm-bindgen
//! and surface in the generated `.d.ts` / `.js` glue layer.
