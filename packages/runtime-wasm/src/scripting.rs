//! Rhai cell dispatcher — orchestrates calls into the WASM runtime.
//!
//! Cell language: `CELL_LANGUAGE_RHAI`. Source is a Rhai script. Params
//! are bound as Rhai variables in the engine's Scope before evaluation,
//! so an upstream cell that provides `n` is referenceable as `n` in the
//! Rhai source.

use crate::outputs::CellOutput;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RhaiCellRequest {
    pub source: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// Evaluate a Rhai script and return the result as a stringified value.
///
/// `params` is a JSON object whose keys are bound as Rhai variables.
/// JSON types map: number → INT or FLOAT, string → ImmutableString,
/// boolean → bool, null → unit. Nested objects/arrays come through as
/// stringified Dynamic.
pub fn run_rhai_cell(req: RhaiCellRequest) -> Result<Vec<CellOutput>, String> {
    let engine = rhai::Engine::new();
    let mut scope = rhai::Scope::new();
    bind_params(&mut scope, &req.params);

    let result: rhai::Dynamic = engine
        .eval_with_scope(&mut scope, &req.source)
        .map_err(|e| format!("rhai eval error: {e}"))?;

    let rendered = stringify_dynamic(&result);
    Ok(vec![CellOutput::Text {
        content: rendered,
        mime_type: Some("text/plain".into()),
    }])
}

fn bind_params(scope: &mut rhai::Scope, params: &serde_json::Value) {
    let serde_json::Value::Object(map) = params else {
        return;
    };
    for (name, value) in map {
        let dynamic = match value {
            serde_json::Value::Null => rhai::Dynamic::UNIT,
            serde_json::Value::Bool(b) => rhai::Dynamic::from(*b),
            serde_json::Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    rhai::Dynamic::from(i)
                } else if let Some(f) = n.as_f64() {
                    rhai::Dynamic::from(f)
                } else {
                    continue;
                }
            }
            serde_json::Value::String(s) => rhai::Dynamic::from(s.clone()),
            other => rhai::Dynamic::from(format!("{other}")),
        };
        scope.push(name, dynamic);
    }
}

fn stringify_dynamic(value: &rhai::Dynamic) -> String {
    if value.is_unit() {
        return "()".into();
    }
    if let Some(b) = value.clone().try_cast::<bool>() {
        return b.to_string();
    }
    if let Some(i) = value.clone().try_cast::<i64>() {
        return i.to_string();
    }
    if let Some(f) = value.clone().try_cast::<f64>() {
        return f.to_string();
    }
    if let Some(s) = value.clone().try_cast::<String>() {
        return s;
    }
    format!("{value:?}")
}

/// JS-bridge entry — `runRhai(source, params?)` returns the cell outputs.
/// `params` is an optional JSON object whose keys are bound as variables
/// in the Rhai scope before eval. This is how upstream cell outputs and
/// workbook inputs reach a Rhai cell.
#[wasm_bindgen(js_name = runRhai)]
pub fn run_rhai_js(source: String, params: JsValue) -> Result<JsValue, JsValue> {
    let params: serde_json::Value = if params.is_undefined() || params.is_null() {
        serde_json::Value::Null
    } else {
        serde_wasm_bindgen::from_value(params)
            .map_err(|e| JsValue::from_str(&format!("params parse: {e}")))?
    };
    let req = RhaiCellRequest { source, params };
    let outputs = run_rhai_cell(req).map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&outputs).map_err(Into::into)
}
