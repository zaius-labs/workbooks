//! Minimal content-addressed history primitive for `<wb-history>`.
//!
//! Phase-1 scope: depth-1 tree (single leaf chunk per commit, no
//! rolling-hash boundaries). Real chunk storage with content-addressing,
//! Merkle linking parent → commit → root → leaf, and the on-wire
//! serialization format ship now. Multi-level interior nodes (rolling
//! hash, ~4 KB chunks) and three-way structural merge land later.
//!
//! ## Why this primitive
//!
//! `<wb-data>` stores authored datasets, `<wb-memory>` append-shaped
//! tabular state, `<wb-doc>` live mergeable document state. None of
//! those answer "what changed in this workbook over time, by whom,
//! verifiably?" `<wb-history>` carries a Merkle commit chain — every
//! commit points at a content-addressed root chunk. Properties that
//! hold even at this minimal depth-1 tier:
//!
//!   - corruption is detectable (hash mismatch on read, integrity-
//!     verified at deserialize)
//!   - history is preserved (commits accrete, never overwrite)
//!   - copy-on-write writes don't mutate prior chunks
//!   - the bytes ARE the database — no out-of-band ledger
//!
//! ## On-wire format (v1)
//!
//! ```text
//!   4  bytes   magic = "WBHP"
//!   4  bytes   version (LE u32, current = 1)
//!   32 bytes   head sha256 (raw)
//!   4  bytes   chunk count (LE u32)
//!   for each chunk:
//!     32 bytes   chunk sha256 (raw)
//!     4  bytes   chunk byte length (LE u32)
//!     N  bytes   chunk content (commit | leaf, see below)
//! ```
//!
//! Each chunk's content begins with a 1-byte type discriminator:
//!
//! ```text
//!   commit (0x00):
//!     1 byte    parent flag (0 = root commit, 1 = has parent)
//!     32 bytes  parent sha256 (only if parent flag = 1)
//!     32 bytes  root sha256 (always)
//!     8  bytes  timestamp ms (LE i64)
//!     4  bytes  message length (LE u32)
//!     N  bytes  message (utf-8)
//!
//!   leaf (0x02):
//!     4  bytes  entry count (LE u32)
//!     for each entry:
//!       4 bytes   key length (LE u32)
//!       N bytes   key (utf-8)
//!       4 bytes   value length (LE u32)
//!       N bytes   value (raw bytes — typically utf-8 JSON, but any bytes ok)
//! ```
//!
//! Type 0x01 is reserved for interior nodes (Phase 2 — multi-level
//! tree). The on-wire format is forward-compatible: a v1 reader will
//! reject v2 files via the version field, but the chunk-record
//! structure is the same so a v2 reader can read v1 files.
//!
//! ## What's NOT here yet
//!
//! - rolling-hash chunk boundaries (Rabin-Karp / buzhash) — Phase-2
//! - multi-level interior nodes / B-tree fanout — Phase-2
//! - structural three-way merge — Phase-2 (the merge primitive is
//!   what makes this a "Prolly" Tree vs a generic Merkle log; depth-1
//!   ships the storage shape but not the merge magic yet)
//! - garbage collection of orphan chunks — Phase-2
//! - sync / pull / push protocol — Phase-2
//!
//! Today's implementation gives integrity, history, and append-only
//! semantics with no merge story. That's enough to ship audit-quality
//! workbook history; merge requires more careful design.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;

const MAGIC: &[u8; 4] = b"WBHP";
const VERSION: u32 = 1;

const CHUNK_COMMIT: u8 = 0x00;
// const CHUNK_INTERIOR: u8 = 0x01;  // reserved for Phase-2
const CHUNK_LEAF: u8 = 0x02;

type Hash = [u8; 32];

fn sha256(bytes: &[u8]) -> Hash {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

fn hex(h: &Hash) -> String {
    h.iter().map(|b| format!("{:02x}", b)).collect()
}

fn parse_hex(s: &str) -> Result<Hash, String> {
    if s.len() != 64 {
        return Err(format!("expected 64-char hex hash, got {}", s.len()));
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16)
            .map_err(|e| format!("hex parse: {e}"))?;
    }
    Ok(out)
}

fn now_ms() -> i64 {
    js_sys::Date::now() as i64
}

// ----------------------------------------------------------------------
// Commit + Leaf encode/decode
// ----------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Commit {
    parent: Option<Hash>,
    root: Hash,
    timestamp_ms: i64,
    message: String,
}

#[derive(Clone, Debug, Default)]
struct Leaf {
    /// Sorted by key. BTreeMap preserves order on iteration so
    /// encoded leaves are deterministic — same logical content
    /// produces the same hash regardless of insert order.
    entries: BTreeMap<Vec<u8>, Vec<u8>>,
}

fn encode_commit(c: &Commit) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + 1 + 32 + 32 + 8 + 4 + c.message.len());
    buf.push(CHUNK_COMMIT);
    match c.parent {
        Some(p) => {
            buf.push(1);
            buf.extend_from_slice(&p);
        }
        None => {
            buf.push(0);
        }
    }
    buf.extend_from_slice(&c.root);
    buf.extend_from_slice(&c.timestamp_ms.to_le_bytes());
    let msg = c.message.as_bytes();
    buf.extend_from_slice(&(msg.len() as u32).to_le_bytes());
    buf.extend_from_slice(msg);
    buf
}

fn decode_commit(bytes: &[u8]) -> Result<Commit, String> {
    if bytes.first().copied() != Some(CHUNK_COMMIT) {
        return Err("decode_commit: not a commit chunk".into());
    }
    let mut i = 1usize;
    let has_parent = *bytes.get(i).ok_or("decode_commit: truncated parent flag")?;
    i += 1;
    let parent = if has_parent == 1 {
        let h = bytes
            .get(i..i + 32)
            .ok_or("decode_commit: truncated parent hash")?;
        i += 32;
        let mut out = [0u8; 32];
        out.copy_from_slice(h);
        Some(out)
    } else {
        None
    };
    let root_bytes = bytes.get(i..i + 32).ok_or("decode_commit: truncated root")?;
    let mut root = [0u8; 32];
    root.copy_from_slice(root_bytes);
    i += 32;
    let ts_bytes = bytes
        .get(i..i + 8)
        .ok_or("decode_commit: truncated timestamp")?;
    let timestamp_ms = i64::from_le_bytes(ts_bytes.try_into().unwrap());
    i += 8;
    let len_bytes = bytes
        .get(i..i + 4)
        .ok_or("decode_commit: truncated message length")?;
    let msg_len = u32::from_le_bytes(len_bytes.try_into().unwrap()) as usize;
    i += 4;
    let msg = bytes
        .get(i..i + msg_len)
        .ok_or("decode_commit: truncated message")?;
    let message = std::str::from_utf8(msg)
        .map_err(|e| format!("decode_commit: utf8: {e}"))?
        .to_string();
    Ok(Commit { parent, root, timestamp_ms, message })
}

fn encode_leaf(leaf: &Leaf) -> Vec<u8> {
    let mut size = 1 + 4;
    for (k, v) in &leaf.entries {
        size += 4 + k.len() + 4 + v.len();
    }
    let mut buf = Vec::with_capacity(size);
    buf.push(CHUNK_LEAF);
    buf.extend_from_slice(&(leaf.entries.len() as u32).to_le_bytes());
    for (k, v) in &leaf.entries {
        buf.extend_from_slice(&(k.len() as u32).to_le_bytes());
        buf.extend_from_slice(k);
        buf.extend_from_slice(&(v.len() as u32).to_le_bytes());
        buf.extend_from_slice(v);
    }
    buf
}

fn decode_leaf(bytes: &[u8]) -> Result<Leaf, String> {
    if bytes.first().copied() != Some(CHUNK_LEAF) {
        return Err("decode_leaf: not a leaf chunk".into());
    }
    let mut i = 1usize;
    let count_bytes = bytes.get(i..i + 4).ok_or("decode_leaf: truncated count")?;
    let count = u32::from_le_bytes(count_bytes.try_into().unwrap()) as usize;
    i += 4;
    let mut entries = BTreeMap::new();
    for entry_idx in 0..count {
        let kl_bytes = bytes
            .get(i..i + 4)
            .ok_or_else(|| format!("decode_leaf: entry {entry_idx} truncated key length"))?;
        let kl = u32::from_le_bytes(kl_bytes.try_into().unwrap()) as usize;
        i += 4;
        let key = bytes
            .get(i..i + kl)
            .ok_or_else(|| format!("decode_leaf: entry {entry_idx} truncated key"))?
            .to_vec();
        i += kl;
        let vl_bytes = bytes
            .get(i..i + 4)
            .ok_or_else(|| format!("decode_leaf: entry {entry_idx} truncated value length"))?;
        let vl = u32::from_le_bytes(vl_bytes.try_into().unwrap()) as usize;
        i += 4;
        let val = bytes
            .get(i..i + vl)
            .ok_or_else(|| format!("decode_leaf: entry {entry_idx} truncated value"))?
            .to_vec();
        i += vl;
        entries.insert(key, val);
    }
    Ok(Leaf { entries })
}

// ----------------------------------------------------------------------
// History — owns the chunk store + HEAD pointer
// ----------------------------------------------------------------------

struct History {
    head: Hash,
    chunks: BTreeMap<Hash, Vec<u8>>,
}

impl History {
    fn new(message: String) -> Self {
        let leaf = Leaf::default();
        let leaf_bytes = encode_leaf(&leaf);
        let leaf_hash = sha256(&leaf_bytes);
        let commit = Commit {
            parent: None,
            root: leaf_hash,
            timestamp_ms: now_ms(),
            message,
        };
        let commit_bytes = encode_commit(&commit);
        let commit_hash = sha256(&commit_bytes);
        let mut chunks = BTreeMap::new();
        chunks.insert(leaf_hash, leaf_bytes);
        chunks.insert(commit_hash, commit_bytes);
        History { head: commit_hash, chunks }
    }

    fn head_commit(&self) -> Result<Commit, String> {
        let bytes = self
            .chunks
            .get(&self.head)
            .ok_or_else(|| format!("HEAD chunk missing: {}", hex(&self.head)))?;
        decode_commit(bytes)
    }

    fn current_leaf(&self) -> Result<Leaf, String> {
        let commit = self.head_commit()?;
        let leaf_bytes = self
            .chunks
            .get(&commit.root)
            .ok_or_else(|| format!("root chunk missing: {}", hex(&commit.root)))?;
        decode_leaf(leaf_bytes)
    }

    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>, String> {
        Ok(self.current_leaf()?.entries.get(key).cloned())
    }

    fn commit(&mut self, leaf: Leaf, message: String) -> Result<Hash, String> {
        let leaf_bytes = encode_leaf(&leaf);
        let leaf_hash = sha256(&leaf_bytes);
        let commit = Commit {
            parent: Some(self.head),
            root: leaf_hash,
            timestamp_ms: now_ms(),
            message,
        };
        let commit_bytes = encode_commit(&commit);
        let commit_hash = sha256(&commit_bytes);
        // Chunks are content-addressed — duplicate inserts (same hash,
        // same content) are no-ops. BTreeMap.insert handles both.
        self.chunks.insert(leaf_hash, leaf_bytes);
        self.chunks.insert(commit_hash, commit_bytes);
        self.head = commit_hash;
        Ok(commit_hash)
    }

    fn set(&mut self, key: Vec<u8>, value: Vec<u8>, message: String) -> Result<Hash, String> {
        let mut leaf = self.current_leaf()?;
        leaf.entries.insert(key, value);
        self.commit(leaf, message)
    }

    fn delete(&mut self, key: &[u8], message: String) -> Result<Hash, String> {
        let mut leaf = self.current_leaf()?;
        leaf.entries.remove(key);
        self.commit(leaf, message)
    }

    fn log(&self) -> Result<Vec<CommitInfo>, String> {
        let mut out = Vec::new();
        let mut cur = Some(self.head);
        while let Some(h) = cur {
            let bytes = self
                .chunks
                .get(&h)
                .ok_or_else(|| format!("commit chunk missing: {}", hex(&h)))?;
            let commit = decode_commit(bytes)?;
            out.push(CommitInfo {
                hash: hex(&h),
                parent: commit.parent.map(|p| hex(&p)),
                root: hex(&commit.root),
                timestamp_ms: commit.timestamp_ms,
                message: commit.message.clone(),
            });
            cur = commit.parent;
        }
        Ok(out)
    }

    fn keys(&self) -> Result<Vec<String>, String> {
        let leaf = self.current_leaf()?;
        Ok(leaf
            .entries
            .keys()
            .filter_map(|k| std::str::from_utf8(k).ok().map(|s| s.to_string()))
            .collect())
    }

    fn checkout(&self, commit_hash: &Hash) -> Result<Vec<(String, Vec<u8>)>, String> {
        let bytes = self
            .chunks
            .get(commit_hash)
            .ok_or_else(|| format!("commit not in chunk store: {}", hex(commit_hash)))?;
        let commit = decode_commit(bytes)?;
        let leaf_bytes = self
            .chunks
            .get(&commit.root)
            .ok_or_else(|| format!("root chunk missing: {}", hex(&commit.root)))?;
        let leaf = decode_leaf(leaf_bytes)?;
        let mut out = Vec::with_capacity(leaf.entries.len());
        for (k, v) in leaf.entries {
            let key = String::from_utf8(k).map_err(|e| format!("key utf8: {e}"))?;
            out.push((key, v));
        }
        Ok(out)
    }

    fn serialize(&self) -> Vec<u8> {
        let mut size = 4 + 4 + 32 + 4;
        for (_, b) in &self.chunks {
            size += 32 + 4 + b.len();
        }
        let mut buf = Vec::with_capacity(size);
        buf.extend_from_slice(MAGIC);
        buf.extend_from_slice(&VERSION.to_le_bytes());
        buf.extend_from_slice(&self.head);
        buf.extend_from_slice(&(self.chunks.len() as u32).to_le_bytes());
        // BTreeMap iteration order is sorted by key (by hash) — so
        // serialize is deterministic for the same chunk set.
        for (h, b) in &self.chunks {
            buf.extend_from_slice(h);
            buf.extend_from_slice(&(b.len() as u32).to_le_bytes());
            buf.extend_from_slice(b);
        }
        buf
    }

    fn deserialize(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < 4 + 4 + 32 + 4 {
            return Err("deserialize: too short for header".into());
        }
        if &bytes[0..4] != MAGIC {
            return Err("deserialize: bad magic (not a wb-history blob)".into());
        }
        let version = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        if version != VERSION {
            return Err(format!(
                "deserialize: unsupported version {version} (this build supports {VERSION})"
            ));
        }
        let mut head = [0u8; 32];
        head.copy_from_slice(&bytes[8..40]);
        let chunk_count = u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize;
        let mut chunks = BTreeMap::new();
        let mut i = 44;
        for chunk_idx in 0..chunk_count {
            if i + 32 + 4 > bytes.len() {
                return Err(format!("deserialize: truncated at chunk {chunk_idx} header"));
            }
            let mut h = [0u8; 32];
            h.copy_from_slice(&bytes[i..i + 32]);
            i += 32;
            let len = u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap()) as usize;
            i += 4;
            if i + len > bytes.len() {
                return Err(format!("deserialize: truncated at chunk {chunk_idx} body"));
            }
            let chunk_bytes = bytes[i..i + len].to_vec();
            i += len;
            // Content-addressing: verify the declared hash matches the
            // bytes. Any mismatch means the file was tampered with or
            // truncated mid-write.
            let actual = sha256(&chunk_bytes);
            if actual != h {
                return Err(format!(
                    "deserialize: chunk {chunk_idx} hash mismatch (declared {}, actual {})",
                    hex(&h),
                    hex(&actual)
                ));
            }
            chunks.insert(h, chunk_bytes);
        }
        // HEAD must point at a known chunk.
        if !chunks.contains_key(&head) {
            return Err(format!(
                "deserialize: HEAD {} not in chunk store",
                hex(&head)
            ));
        }
        Ok(History { head, chunks })
    }
}

// ----------------------------------------------------------------------
// JS-bridge surface (wasm-bindgen)
// ----------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
pub struct CommitInfo {
    pub hash: String,
    pub parent: Option<String>,
    pub root: String,
    pub timestamp_ms: i64,
    pub message: String,
}

/// Initialize a fresh history with one root commit. Returns the
/// serialized bytes ready for embedding in `<wb-history>`.
#[wasm_bindgen(js_name = prollyInit)]
pub fn prolly_init(message: String) -> Vec<u8> {
    History::new(message).serialize()
}

/// Read the HEAD commit's hash as hex.
#[wasm_bindgen(js_name = prollyHead)]
pub fn prolly_head(serialized: Vec<u8>) -> Result<String, JsValue> {
    let h = History::deserialize(&serialized).map_err(|e| JsValue::from_str(&e))?;
    Ok(hex(&h.head))
}

/// Get a value at key from the current HEAD's leaf.
#[wasm_bindgen(js_name = prollyGet)]
pub fn prolly_get(serialized: Vec<u8>, key: String) -> Result<JsValue, JsValue> {
    let h = History::deserialize(&serialized).map_err(|e| JsValue::from_str(&e))?;
    match h.get(key.as_bytes()).map_err(|e| JsValue::from_str(&e))? {
        Some(v) => Ok(serde_wasm_bindgen::to_value(&v)?),
        None => Ok(JsValue::NULL),
    }
}

/// List all keys present in the current HEAD's leaf (utf-8 keys only).
#[wasm_bindgen(js_name = prollyKeys)]
pub fn prolly_keys(serialized: Vec<u8>) -> Result<JsValue, JsValue> {
    let h = History::deserialize(&serialized).map_err(|e| JsValue::from_str(&e))?;
    let keys = h.keys().map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&keys).map_err(Into::into)
}

/// Set a key=value in the current leaf and commit. Returns new
/// serialized history bytes — the host writes them back to the
/// `<wb-history>` element body on save.
#[wasm_bindgen(js_name = prollySet)]
pub fn prolly_set(
    serialized: Vec<u8>,
    key: String,
    value: Vec<u8>,
    message: String,
) -> Result<Vec<u8>, JsValue> {
    let mut h = History::deserialize(&serialized).map_err(|e| JsValue::from_str(&e))?;
    h.set(key.into_bytes(), value, message)
        .map_err(|e| JsValue::from_str(&e))?;
    Ok(h.serialize())
}

/// Remove a key in the current leaf and commit. Returns new
/// serialized history bytes.
#[wasm_bindgen(js_name = prollyDelete)]
pub fn prolly_delete(
    serialized: Vec<u8>,
    key: String,
    message: String,
) -> Result<Vec<u8>, JsValue> {
    let mut h = History::deserialize(&serialized).map_err(|e| JsValue::from_str(&e))?;
    h.delete(key.as_bytes(), message)
        .map_err(|e| JsValue::from_str(&e))?;
    Ok(h.serialize())
}

/// Walk the parent chain from HEAD, returning each commit as
/// {hash, parent, root, timestamp_ms, message}.
#[wasm_bindgen(js_name = prollyLog)]
pub fn prolly_log(serialized: Vec<u8>) -> Result<JsValue, JsValue> {
    let h = History::deserialize(&serialized).map_err(|e| JsValue::from_str(&e))?;
    let log = h.log().map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&log).map_err(Into::into)
}

/// Materialize the full leaf at a past commit. Returns an array of
/// [key, value] pairs (value is a Uint8Array on the JS side).
#[wasm_bindgen(js_name = prollyCheckout)]
pub fn prolly_checkout(serialized: Vec<u8>, commit_hash_hex: String) -> Result<JsValue, JsValue> {
    let h = History::deserialize(&serialized).map_err(|e| JsValue::from_str(&e))?;
    let commit_hash = parse_hex(&commit_hash_hex).map_err(|e| JsValue::from_str(&e))?;
    let entries = h.checkout(&commit_hash).map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&entries).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_empty() {
        // Test only the encode/decode primitives — full History uses
        // js_sys::Date which isn't available in cargo test outside wasm.
        let leaf = Leaf::default();
        let bytes = encode_leaf(&leaf);
        let decoded = decode_leaf(&bytes).expect("decode");
        assert_eq!(decoded.entries.len(), 0);
    }

    #[test]
    fn leaf_with_entries() {
        let mut leaf = Leaf::default();
        leaf.entries.insert(b"foo".to_vec(), b"1".to_vec());
        leaf.entries.insert(b"bar".to_vec(), b"2".to_vec());
        let bytes = encode_leaf(&leaf);
        let decoded = decode_leaf(&bytes).expect("decode");
        assert_eq!(decoded.entries.len(), 2);
        assert_eq!(decoded.entries.get(b"foo".as_ref()).map(|v| v.as_slice()), Some(b"1".as_ref()));
    }

    #[test]
    fn commit_with_parent() {
        let parent_hash = sha256(b"parent");
        let root_hash = sha256(b"root");
        let c = Commit {
            parent: Some(parent_hash),
            root: root_hash,
            timestamp_ms: 1234567890,
            message: "test commit".to_string(),
        };
        let bytes = encode_commit(&c);
        let decoded = decode_commit(&bytes).expect("decode");
        assert_eq!(decoded.parent, Some(parent_hash));
        assert_eq!(decoded.root, root_hash);
        assert_eq!(decoded.timestamp_ms, 1234567890);
        assert_eq!(decoded.message, "test commit");
    }

    #[test]
    fn commit_root_no_parent() {
        let c = Commit {
            parent: None,
            root: sha256(b"first"),
            timestamp_ms: 0,
            message: "init".to_string(),
        };
        let bytes = encode_commit(&c);
        let decoded = decode_commit(&bytes).expect("decode");
        assert_eq!(decoded.parent, None);
    }
}
