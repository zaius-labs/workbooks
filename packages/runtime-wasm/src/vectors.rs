//! Vector ops cell dispatcher (T1.2) — HNSW nearest-neighbor search via
//! `instant-distance`.
//!
//! Workbooks doing semantic search / clustering need vector ops. Building
//! an HNSW index in browser memory + querying it is the foundational
//! primitive — embeddings (from Candle, T1.3) become useful when paired
//! with KNN.
//!
//! API surface (T1.2):
//!
//!   buildVectorIndex(items, options) -> { handle, build_ms }
//!   queryVectorIndex(handle, query, k) -> [{ id, distance }]
//!   dropVectorIndex(handle)
//!
//! `items` is JSON: [{ id: string, vector: number[] }, ...]. Dimension is
//! inferred from the first item; subsequent items must match.
//!
//! Distance: cosine via instant-distance's `Point` + custom impl. `f32`
//! vectors throughout. Higher-dimensional vectors (768/1024/1536 from
//! production embedding models) are the target use; the demo exercises
//! 32-dim toy vectors to keep the page snappy.

use instant_distance::{Builder, HnswMap, Point, Search};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorItem {
    pub id: String,
    pub vector: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BuildOptions {
    /// Index quality knob. Higher = better recall, slower build.
    /// `instant-distance` default is 100; we keep it.
    #[serde(default)]
    pub ef_construction: Option<usize>,
    /// Search-time candidate list. Higher = better recall, slower query.
    #[serde(default)]
    pub ef_search: Option<usize>,
}

/// A vector wrapper that implements `instant_distance::Point` with cosine
/// distance. Stored normalized for cheap cosine-as-1-minus-dot.
#[derive(Debug, Clone)]
struct CosinePoint(Vec<f32>);

impl Point for CosinePoint {
    fn distance(&self, other: &Self) -> f32 {
        // self + other are pre-normalized to unit length, so cosine
        // similarity is just the dot product. Distance = 1 - similarity.
        let dot: f32 = self.0.iter().zip(other.0.iter()).map(|(a, b)| a * b).sum();
        1.0 - dot
    }
}

fn normalize(v: &mut [f32]) {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

// Single-page-instance index store. Workbooks rarely keep more than a
// handful of indexes alive; a HashMap is plenty.
thread_local! {
    static INDEXES: RefCell<HashMap<u32, HnswMap<CosinePoint, String>>> =
        RefCell::new(HashMap::new());
    static NEXT_HANDLE: RefCell<u32> = const { RefCell::new(0) };
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BuildResult {
    pub handle: u32,
    pub build_ms: f64,
    pub item_count: usize,
    pub dimension: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Neighbor {
    pub id: String,
    pub distance: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct QueryResult {
    pub neighbors: Vec<Neighbor>,
    pub query_ms: f64,
}

/// Build an HNSW index over `items` and return a handle the JS side
/// reuses for queries. Stores in a thread-local index map; call
/// `dropVectorIndex(handle)` to release.
#[wasm_bindgen(js_name = buildVectorIndex)]
pub fn build_vector_index(items: JsValue, options: JsValue) -> Result<JsValue, JsValue> {
    let items: Vec<VectorItem> = serde_wasm_bindgen::from_value(items)
        .map_err(|e| JsValue::from_str(&format!("items parse: {e}")))?;
    let opts: BuildOptions = if options.is_undefined() || options.is_null() {
        BuildOptions::default()
    } else {
        serde_wasm_bindgen::from_value(options)
            .map_err(|e| JsValue::from_str(&format!("options parse: {e}")))?
    };

    if items.is_empty() {
        return Err(JsValue::from_str("vector index: empty items"));
    }
    let dim = items[0].vector.len();
    if dim == 0 {
        return Err(JsValue::from_str("vector index: zero-length vector"));
    }
    for (i, item) in items.iter().enumerate() {
        if item.vector.len() != dim {
            return Err(JsValue::from_str(&format!(
                "vector index: item {} has dim {} but expected {}",
                i,
                item.vector.len(),
                dim
            )));
        }
    }

    let item_count = items.len();
    let mut points = Vec::with_capacity(item_count);
    let mut ids = Vec::with_capacity(item_count);
    for item in items {
        let mut v = item.vector;
        normalize(&mut v);
        points.push(CosinePoint(v));
        ids.push(item.id);
    }

    let t0 = js_sys::Date::now();
    let mut builder = Builder::default();
    if let Some(ef) = opts.ef_construction {
        builder = builder.ef_construction(ef);
    }
    if let Some(ef) = opts.ef_search {
        builder = builder.ef_search(ef);
    }
    let map = builder.build(points, ids);
    let build_ms = js_sys::Date::now() - t0;

    let handle = NEXT_HANDLE.with(|n| {
        let mut n = n.borrow_mut();
        let h = *n;
        *n = n.saturating_add(1);
        h
    });
    INDEXES.with(|idxs| idxs.borrow_mut().insert(handle, map));

    let result = BuildResult { handle, build_ms, item_count, dimension: dim };
    use serde::Serialize;
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    result.serialize(&serializer).map_err(Into::into)
}

/// Query an existing index for the K nearest neighbors of `query`.
#[wasm_bindgen(js_name = queryVectorIndex)]
pub fn query_vector_index(handle: u32, query: JsValue, k: u32) -> Result<JsValue, JsValue> {
    let mut q: Vec<f32> = serde_wasm_bindgen::from_value(query)
        .map_err(|e| JsValue::from_str(&format!("query parse: {e}")))?;
    if q.is_empty() {
        return Err(JsValue::from_str("query: empty vector"));
    }
    normalize(&mut q);
    let qp = CosinePoint(q);
    let k = (k as usize).max(1);

    let t0 = js_sys::Date::now();
    let neighbors = INDEXES.with(|idxs| -> Result<Vec<Neighbor>, JsValue> {
        let idxs = idxs.borrow();
        let map = idxs
            .get(&handle)
            .ok_or_else(|| JsValue::from_str(&format!("vector index: handle {handle} not found")))?;

        let mut search = Search::default();
        let results: Vec<Neighbor> = map
            .search(&qp, &mut search)
            .take(k)
            .map(|item| Neighbor {
                id: item.value.clone(),
                distance: item.distance,
            })
            .collect();
        Ok(results)
    })?;
    let query_ms = js_sys::Date::now() - t0;

    let result = QueryResult { neighbors, query_ms };
    use serde::Serialize;
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    result.serialize(&serializer).map_err(Into::into)
}

#[wasm_bindgen(js_name = dropVectorIndex)]
pub fn drop_vector_index(handle: u32) -> Result<JsValue, JsValue> {
    INDEXES.with(|idxs| idxs.borrow_mut().remove(&handle));
    Ok(JsValue::TRUE)
}

/// Typed-array fast path — `vectors` is a contiguous Float32Array of
/// length `ids.length * dim`. ~10× faster than the object-array form
/// for production-size corpora since serde-wasm-bindgen doesn't have to
/// walk an array-of-objects-of-arrays.
///
/// Use this when you already have embeddings as a flat Float32Array (the
/// common shape coming back from a model inference batch).
#[wasm_bindgen(js_name = buildVectorIndexFlat)]
pub fn build_vector_index_flat(
    ids: JsValue,
    vectors: js_sys::Float32Array,
    dim: u32,
    options: JsValue,
) -> Result<JsValue, JsValue> {
    let ids: Vec<String> = serde_wasm_bindgen::from_value(ids)
        .map_err(|e| JsValue::from_str(&format!("ids parse: {e}")))?;
    let opts: BuildOptions = if options.is_undefined() || options.is_null() {
        BuildOptions::default()
    } else {
        serde_wasm_bindgen::from_value(options)
            .map_err(|e| JsValue::from_str(&format!("options parse: {e}")))?
    };

    let dim = dim as usize;
    if dim == 0 {
        return Err(JsValue::from_str("vector index: dim must be > 0"));
    }
    let n = ids.len();
    let total = vectors.length() as usize;
    if total != n * dim {
        return Err(JsValue::from_str(&format!(
            "vector index: vectors.length ({}) != ids.length ({}) * dim ({})",
            total, n, dim
        )));
    }

    // Single bulk copy across the boundary, then chunk + normalize.
    let buf = vectors.to_vec();
    let mut points = Vec::with_capacity(n);
    for chunk in buf.chunks_exact(dim) {
        let mut v = chunk.to_vec();
        normalize(&mut v);
        points.push(CosinePoint(v));
    }

    let t0 = js_sys::Date::now();
    let mut builder = Builder::default();
    if let Some(ef) = opts.ef_construction {
        builder = builder.ef_construction(ef);
    }
    if let Some(ef) = opts.ef_search {
        builder = builder.ef_search(ef);
    }
    let map = builder.build(points, ids);
    let build_ms = js_sys::Date::now() - t0;

    let handle = NEXT_HANDLE.with(|h| {
        let mut h = h.borrow_mut();
        let v = *h;
        *h = h.saturating_add(1);
        v
    });
    INDEXES.with(|idxs| idxs.borrow_mut().insert(handle, map));

    let result = BuildResult { handle, build_ms, item_count: n, dimension: dim };
    use serde::Serialize;
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    result.serialize(&serializer).map_err(Into::into)
}

/// Typed-array query — same idea as `buildVectorIndexFlat`. `query` is a
/// Float32Array.
#[wasm_bindgen(js_name = queryVectorIndexFlat)]
pub fn query_vector_index_flat(
    handle: u32,
    query: js_sys::Float32Array,
    k: u32,
) -> Result<JsValue, JsValue> {
    let mut q = query.to_vec();
    if q.is_empty() {
        return Err(JsValue::from_str("query: empty vector"));
    }
    normalize(&mut q);
    let qp = CosinePoint(q);
    let k = (k as usize).max(1);

    let t0 = js_sys::Date::now();
    let neighbors = INDEXES.with(|idxs| -> Result<Vec<Neighbor>, JsValue> {
        let idxs = idxs.borrow();
        let map = idxs
            .get(&handle)
            .ok_or_else(|| JsValue::from_str(&format!("vector index: handle {handle} not found")))?;
        let mut search = Search::default();
        let results: Vec<Neighbor> = map
            .search(&qp, &mut search)
            .take(k)
            .map(|item| Neighbor { id: item.value.clone(), distance: item.distance })
            .collect();
        Ok(results)
    })?;
    let query_ms = js_sys::Date::now() - t0;

    let result = QueryResult { neighbors, query_ms };
    use serde::Serialize;
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    result.serialize(&serializer).map_err(Into::into)
}
