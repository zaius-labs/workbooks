//! Chart cell dispatcher — renders Plotters charts to SVG.
//!
//! Cell language: `CELL_LANGUAGE_CHART`. Spec is a declarative chart binding:
//!
//! ```json
//! {
//!   "kind": "bar",
//!   "title": "Revenue by region",
//!   "x_label": "region",
//!   "y_label": "revenue",
//!   "categories": ["us", "eu", "apac"],
//!   "values": [30200, 18800, 25400]
//! }
//! ```
//!
//! Today (P2): bar + line spec types. Returns CellOutput::Image with
//! mime_type "image/svg+xml" so the workbook UI can drop the SVG inline.
//! P3.3 will widen the spec to multi-series + axis config + theming.

use crate::outputs::CellOutput;
use plotters::prelude::*;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChartSpec {
    Bar(BarSpec),
    Line(LineSpec),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BarSpec {
    pub categories: Vec<String>,
    pub values: Vec<f64>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub x_label: String,
    #[serde(default)]
    pub y_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineSpec {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub x_label: String,
    #[serde(default)]
    pub y_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChartCellRequest {
    pub spec: ChartSpec,
}

pub fn run_chart_cell(req: ChartCellRequest) -> Result<Vec<CellOutput>, String> {
    let svg = match req.spec {
        ChartSpec::Bar(spec) => render_bar(&spec)?,
        ChartSpec::Line(spec) => render_line(&spec)?,
    };
    Ok(vec![CellOutput::Image {
        content: svg,
        mime_type: "image/svg+xml".into(),
    }])
}

const WIDTH: u32 = 800;
const HEIGHT: u32 = 400;

fn render_bar(spec: &BarSpec) -> Result<String, String> {
    if spec.categories.len() != spec.values.len() {
        return Err(format!(
            "bar chart: categories.len() ({}) != values.len() ({})",
            spec.categories.len(),
            spec.values.len()
        ));
    }
    let mut buf = String::new();
    {
        let backend = SVGBackend::with_string(&mut buf, (WIDTH, HEIGHT)).into_drawing_area();
        backend.fill(&WHITE).map_err(|e| e.to_string())?;

        let max_y = spec
            .values
            .iter()
            .cloned()
            .fold(f64::NEG_INFINITY, f64::max)
            .max(0.0)
            * 1.1;
        let min_y = spec
            .values
            .iter()
            .cloned()
            .fold(f64::INFINITY, f64::min)
            .min(0.0);

        let x_labels: Vec<&str> = spec.categories.iter().map(String::as_str).collect();

        let mut chart = ChartBuilder::on(&backend)
            .caption(&spec.title, ("sans-serif", 22))
            .margin(20)
            .x_label_area_size(40)
            .y_label_area_size(60)
            .build_cartesian_2d((0..spec.categories.len() as i32).into_segmented(), min_y..max_y)
            .map_err(|e| e.to_string())?;

        chart
            .configure_mesh()
            .x_labels(spec.categories.len())
            .x_label_formatter(&|seg| match seg {
                SegmentValue::CenterOf(i) => x_labels.get(*i as usize).copied().unwrap_or("").to_string(),
                _ => String::new(),
            })
            .x_desc(&spec.x_label)
            .y_desc(&spec.y_label)
            .draw()
            .map_err(|e| e.to_string())?;

        chart
            .draw_series(
                spec.values
                    .iter()
                    .enumerate()
                    .map(|(i, v)| {
                        let i = i as i32;
                        let mut bar = Rectangle::new(
                            [
                                (SegmentValue::Exact(i), 0.0),
                                (SegmentValue::Exact(i + 1), *v),
                            ],
                            BLUE.filled(),
                        );
                        bar.set_margin(0, 0, 5, 5);
                        bar
                    }),
            )
            .map_err(|e| e.to_string())?;

        backend.present().map_err(|e| e.to_string())?;
    }
    Ok(buf)
}

fn render_line(spec: &LineSpec) -> Result<String, String> {
    if spec.x.len() != spec.y.len() {
        return Err(format!(
            "line chart: x.len() ({}) != y.len() ({})",
            spec.x.len(),
            spec.y.len()
        ));
    }
    if spec.x.is_empty() {
        return Err("line chart: empty data".into());
    }
    let mut buf = String::new();
    {
        let backend = SVGBackend::with_string(&mut buf, (WIDTH, HEIGHT)).into_drawing_area();
        backend.fill(&WHITE).map_err(|e| e.to_string())?;

        let x_min = spec.x.iter().cloned().fold(f64::INFINITY, f64::min);
        let x_max = spec.x.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let y_min = spec.y.iter().cloned().fold(f64::INFINITY, f64::min);
        let y_max = spec.y.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

        let mut chart = ChartBuilder::on(&backend)
            .caption(&spec.title, ("sans-serif", 22))
            .margin(20)
            .x_label_area_size(40)
            .y_label_area_size(60)
            .build_cartesian_2d(x_min..x_max, y_min..y_max)
            .map_err(|e| e.to_string())?;

        chart
            .configure_mesh()
            .x_desc(&spec.x_label)
            .y_desc(&spec.y_label)
            .draw()
            .map_err(|e| e.to_string())?;

        chart
            .draw_series(LineSeries::new(
                spec.x.iter().cloned().zip(spec.y.iter().cloned()),
                BLUE.stroke_width(2),
            ))
            .map_err(|e| e.to_string())?;

        backend.present().map_err(|e| e.to_string())?;
    }
    Ok(buf)
}

/// JS-bridge entry — `runChart(spec)` takes a JSON-encoded ChartSpec and
/// returns the cell outputs (one Image entry with SVG content).
#[wasm_bindgen(js_name = runChart)]
pub fn run_chart_js(spec_json: String) -> Result<JsValue, JsValue> {
    let spec: ChartSpec = serde_json::from_str(&spec_json)
        .map_err(|e| JsValue::from_str(&format!("chart spec parse: {e}")))?;
    let outputs = run_chart_cell(ChartCellRequest { spec }).map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&outputs).map_err(Into::into)
}
