//! Sentence embedding via Candle BERT (T1.3).
//!
//! Loads a BERT-architecture model (e.g. all-MiniLM-L6-v2) + its
//! tokenizer in WASM and produces fixed-dimensional sentence embeddings.
//! Pair with the vector index (T1.2) for full semantic search in the
//! browser.
//!
//! API:
//!   loadBertEmbedder(model_bytes, tokenizer_json, config_json) -> handle
//!   embedTextFlat(handle, text) -> Float32Array        (single sentence)
//!   embedBatchFlat(handle, texts_json) -> Float32Array (N×dim flat)
//!   dropEmbedder(handle)
//!
//! The output is mean-pooled + L2-normalized so cosine similarity is
//! just the dot product (matching the vector-knn module's storage).

use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config};
use std::cell::RefCell;
use std::collections::HashMap;
use tokenizers::Tokenizer;
use wasm_bindgen::prelude::*;

pub struct BertEmbedder {
    model: BertModel,
    tokenizer: Tokenizer,
    device: Device,
    hidden_size: usize,
}

thread_local! {
    static EMBEDDERS: RefCell<HashMap<u32, BertEmbedder>> = RefCell::new(HashMap::new());
    static NEXT_HANDLE: RefCell<u32> = const { RefCell::new(0) };
}

#[wasm_bindgen(js_name = loadBertEmbedder)]
pub fn load_bert_embedder(
    model_bytes: js_sys::Uint8Array,
    tokenizer_json: String,
    config_json: String,
) -> Result<u32, JsValue> {
    let device = Device::Cpu;

    let config: Config = serde_json::from_str(&config_json)
        .map_err(|e| JsValue::from_str(&format!("config parse: {e}")))?;

    let tokenizer = Tokenizer::from_bytes(tokenizer_json.as_bytes())
        .map_err(|e| JsValue::from_str(&format!("tokenizer load: {e}")))?;

    let weight_bytes = model_bytes.to_vec();
    let vb = VarBuilder::from_buffered_safetensors(weight_bytes, DType::F32, &device)
        .map_err(|e| JsValue::from_str(&format!("safetensors load: {e}")))?;

    let model = BertModel::load(vb, &config)
        .map_err(|e| JsValue::from_str(&format!("bert load: {e}")))?;

    let hidden_size = config.hidden_size;
    let embedder = BertEmbedder { model, tokenizer, device, hidden_size };

    let handle = NEXT_HANDLE.with(|h| {
        let mut h = h.borrow_mut();
        let v = *h;
        *h = h.saturating_add(1);
        v
    });
    EMBEDDERS.with(|m| m.borrow_mut().insert(handle, embedder));
    Ok(handle)
}

#[wasm_bindgen(js_name = embedTextFlat)]
pub fn embed_text_flat(handle: u32, text: String) -> Result<js_sys::Float32Array, JsValue> {
    EMBEDDERS.with(|m| -> Result<js_sys::Float32Array, JsValue> {
        let m = m.borrow();
        let e = m
            .get(&handle)
            .ok_or_else(|| JsValue::from_str(&format!("embedder: handle {handle} not found")))?;
        let v = embed_one(e, &text)?;
        let out = js_sys::Float32Array::new_with_length(v.len() as u32);
        out.copy_from(&v);
        Ok(out)
    })
}

/// Batch embed: input is a JSON-encoded `string[]`; output is a flat
/// Float32Array of length `texts.len() * hidden_size`.
#[wasm_bindgen(js_name = embedBatchFlat)]
pub fn embed_batch_flat(
    handle: u32,
    texts_json: String,
) -> Result<js_sys::Float32Array, JsValue> {
    let texts: Vec<String> = serde_json::from_str(&texts_json)
        .map_err(|e| JsValue::from_str(&format!("texts parse: {e}")))?;

    EMBEDDERS.with(|m| -> Result<js_sys::Float32Array, JsValue> {
        let m = m.borrow();
        let e = m
            .get(&handle)
            .ok_or_else(|| JsValue::from_str(&format!("embedder: handle {handle} not found")))?;

        let mut out = Vec::with_capacity(texts.len() * e.hidden_size);
        for t in &texts {
            let v = embed_one(e, t)?;
            out.extend(v);
        }
        let arr = js_sys::Float32Array::new_with_length(out.len() as u32);
        arr.copy_from(&out);
        Ok(arr)
    })
}

#[wasm_bindgen(js_name = dropEmbedder)]
pub fn drop_embedder(handle: u32) -> Result<JsValue, JsValue> {
    EMBEDDERS.with(|m| m.borrow_mut().remove(&handle));
    Ok(JsValue::TRUE)
}

fn embed_one(e: &BertEmbedder, text: &str) -> Result<Vec<f32>, JsValue> {
    let encoding = e
        .tokenizer
        .encode(text, true)
        .map_err(|err| JsValue::from_str(&format!("tokenize: {err}")))?;
    let token_ids: Vec<u32> = encoding.get_ids().to_vec();
    let attention_mask: Vec<u32> = encoding.get_attention_mask().to_vec();

    let token_ids_t = Tensor::new(token_ids.as_slice(), &e.device)
        .and_then(|t| t.unsqueeze(0))
        .map_err(|err| JsValue::from_str(&format!("token_ids tensor: {err}")))?;
    let token_type_ids = token_ids_t
        .zeros_like()
        .map_err(|err| JsValue::from_str(&format!("token_type_ids: {err}")))?;
    let attention_mask_t = Tensor::new(attention_mask.as_slice(), &e.device)
        .and_then(|t| t.unsqueeze(0))
        .map_err(|err| JsValue::from_str(&format!("attention_mask tensor: {err}")))?;

    let embeddings = e
        .model
        .forward(&token_ids_t, &token_type_ids, Some(&attention_mask_t))
        .map_err(|err| JsValue::from_str(&format!("bert forward: {err}")))?;

    // Mean-pool over the sequence dim (excluding padding tokens via the
    // attention mask), then L2-normalize.
    let pooled = mean_pool(&embeddings, &attention_mask_t)
        .map_err(|err| JsValue::from_str(&format!("mean_pool: {err}")))?;
    let normed = l2_normalize(&pooled)
        .map_err(|err| JsValue::from_str(&format!("l2_normalize: {err}")))?;

    normed
        .squeeze(0)
        .and_then(|t| t.to_vec1::<f32>())
        .map_err(|err| JsValue::from_str(&format!("to_vec: {err}")))
}

fn mean_pool(hidden: &Tensor, attention_mask: &Tensor) -> candle_core::Result<Tensor> {
    // hidden: (1, n_tokens, hidden_size)
    // attention_mask: (1, n_tokens) — 1 for real, 0 for pad.
    let mask = attention_mask
        .to_dtype(DType::F32)?
        .unsqueeze(2)?; // (1, n_tokens, 1)
    let weighted = hidden.broadcast_mul(&mask)?;
    let sum = weighted.sum(1)?;          // (1, hidden_size)
    let count = mask.sum(1)?;            // (1, 1)
    sum.broadcast_div(&count)
}

fn l2_normalize(t: &Tensor) -> candle_core::Result<Tensor> {
    let norm = t.sqr()?.sum_keepdim(t.dims().len() - 1)?.sqrt()?;
    t.broadcast_div(&norm)
}
