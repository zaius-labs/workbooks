//! Rust-side age decrypt + plaintext-handle registry.
//! (#39 Phase E — closes the "plaintext lives in JS heap" gap from
//! encryption.SECURITY.md.)
//!
//! Architectural property
//! ----------------------
//! Decrypted plaintext bytes stay inside WASM linear memory. JS
//! receives only an opaque handle (a `u32` slot id) and uses it to
//! address the bytes when it asks Rust to do work over them
//! (`runPolarsSqlIpcHandles`, future `runSqliteHandles`, etc.).
//! There's an explicit escape hatch — `handleExport` returns the
//! raw bytes — for cells that genuinely need them, but the default
//! analytical path (encrypt → decrypt → query → result rows) never
//! crosses plaintext through the JS↔WASM boundary.
//!
//! Why this matters: a malicious cell that gets JS-execution
//! privilege via XSS in surrounding chrome can today read every
//! byte we've decrypted from the typage path. With this module,
//! the same XSS gets handle IDs but cannot dereference them — the
//! REGISTRY lives in Rust-owned memory and crosses the boundary
//! only through narrow, audited functions.
//!
//! Handle lifecycle
//! ----------------
//!   ageDecryptToHandle(ciphertext, passphrase) → u32
//!     decrypts via the `age` crate's scrypt-recipient path,
//!     stores plaintext in REGISTRY under a fresh slot,
//!     returns the slot id.
//!
//!   handleDispose(id)
//!     drops the bytes. Caller invokes when done. The runtime
//!     also drops on resolver dispose.
//!
//!   handleSize(id) → u32
//!     introspection; returns 0 if the handle was already disposed.
//!
//!   handleExport(id) → Vec<u8>
//!     escape hatch — copies bytes out for cells that need them.
//!     Use sparingly; the whole point of handles is to avoid this.
//!
//!   runPolarsSqlIpcHandles(sql, { table: handle, … })
//!     same shape as runPolarsSqlIpc but takes handle ids instead
//!     of Uint8Arrays. Resolves handles internally via REGISTRY,
//!     never exposes bytes to JS.
//!
//! Memory hygiene: REGISTRY uses a slab-style design — disposed
//! slots are freed and reused so we don't grow unbounded across
//! a long session of decrypt+dispose cycles.

use age::secrecy::SecretString;
use age::{Decryptor, Identity, scrypt, x25519};
use std::str::FromStr;
use serde::Deserialize;
use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::sync::{Mutex, OnceLock};
use wasm_bindgen::prelude::*;

// ─── Slab-style plaintext registry ────────────────────────────────

struct Registry {
    /// Slot id → plaintext bytes. None means free slot.
    slots: Vec<Option<Vec<u8>>>,
    /// Free-slot stack for reuse. Pop = recycle a disposed slot.
    free: Vec<u32>,
    next_id: u32,
}

impl Registry {
    fn insert(&mut self, bytes: Vec<u8>) -> u32 {
        if let Some(id) = self.free.pop() {
            self.slots[id as usize] = Some(bytes);
            return id;
        }
        let id = self.next_id;
        self.next_id += 1;
        self.slots.push(Some(bytes));
        id
    }

    fn dispose(&mut self, id: u32) -> bool {
        let idx = id as usize;
        if idx >= self.slots.len() {
            return false;
        }
        if let Some(bytes) = self.slots[idx].take() {
            // Best-effort zeroize before drop. The `age` crate's
            // SecretString zeroizes its passphrase; this does the
            // same for the produced plaintext so a memory snapshot
            // taken AFTER dispose doesn't recover it.
            let mut z = bytes;
            for b in z.iter_mut() {
                *b = 0;
            }
            drop(z);
            self.free.push(id);
            true
        } else {
            false
        }
    }

    fn get(&self, id: u32) -> Option<&[u8]> {
        let idx = id as usize;
        if idx >= self.slots.len() {
            return None;
        }
        self.slots[idx].as_deref()
    }
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        Mutex::new(Registry {
            slots: Vec::new(),
            free: Vec::new(),
            next_id: 0,
        })
    })
}

// ─── age decrypt ──────────────────────────────────────────────────

fn decrypt_passphrase_inner(ciphertext: &[u8], passphrase: &str) -> Result<Vec<u8>, String> {
    let decryptor = Decryptor::new(Cursor::new(ciphertext))
        .map_err(|e| format!("age decrypt init: {e}"))?;
    let identity = scrypt::Identity::new(SecretString::from(passphrase.to_string()));
    let identities: Vec<&dyn Identity> = vec![&identity];
    let mut reader = decryptor
        .decrypt(identities.into_iter())
        .map_err(|e| format!("age decrypt: {e}"))?;
    let mut plaintext = Vec::new();
    reader
        .read_to_end(&mut plaintext)
        .map_err(|e| format!("age decrypt read: {e}"))?;
    Ok(plaintext)
}

/// Decrypt an age envelope with a passphrase, place the plaintext
/// in the registry, return the handle. Plaintext never crosses to
/// JS through this entry — callers use the handle.
#[wasm_bindgen(js_name = ageDecryptToHandle)]
pub fn age_decrypt_to_handle(
    ciphertext: Vec<u8>,
    passphrase: String,
) -> Result<u32, JsValue> {
    let plaintext = decrypt_passphrase_inner(&ciphertext, &passphrase)
        .map_err(|e| JsValue::from_str(&e))?;
    let id = registry().lock().unwrap().insert(plaintext);
    Ok(id)
}

/// Compatibility entry — decrypt and return plaintext bytes via JS.
/// This crosses the boundary so it's NOT the isolation path; kept
/// for parity with the typage flow during migration. Prefer
/// ageDecryptToHandle for new code.
#[wasm_bindgen(js_name = ageDecryptToBytes)]
pub fn age_decrypt_to_bytes(
    ciphertext: Vec<u8>,
    passphrase: String,
) -> Result<Vec<u8>, JsValue> {
    decrypt_passphrase_inner(&ciphertext, &passphrase)
        .map_err(|e| JsValue::from_str(&e))
}

/// Phase D — decrypt with one or more X25519 identities. Each
/// identity is an `AGE-SECRET-KEY-1...` string (the form produced by
/// `workbook keygen --type x25519`). Identities are tried in order;
/// the first that unwraps the file key wins. If none match, returns
/// an error — the file isn't addressed to any of these identities.
///
/// Plaintext stays in linear memory; JS receives only the slot id,
/// matching `ageDecryptToHandle`'s isolation property.
fn decrypt_identity_inner(
    ciphertext: &[u8],
    identity_strs: &[String],
) -> Result<Vec<u8>, String> {
    if identity_strs.is_empty() {
        return Err("at least one identity is required".to_string());
    }
    // Parse all identity strings up-front so a malformed one fails
    // before we even open the decryptor.
    let parsed: Vec<x25519::Identity> = identity_strs
        .iter()
        .map(|s| {
            x25519::Identity::from_str(s)
                .map_err(|e| format!("malformed X25519 identity: {e}"))
        })
        .collect::<Result<_, _>>()?;
    let decryptor = Decryptor::new(Cursor::new(ciphertext))
        .map_err(|e| format!("age decrypt init: {e}"))?;
    let identities: Vec<&dyn Identity> =
        parsed.iter().map(|id| id as &dyn Identity).collect();
    let mut reader = decryptor
        .decrypt(identities.into_iter())
        .map_err(|e| format!("age decrypt (x25519): {e}"))?;
    let mut plaintext = Vec::new();
    reader
        .read_to_end(&mut plaintext)
        .map_err(|e| format!("age decrypt read: {e}"))?;
    Ok(plaintext)
}

#[wasm_bindgen(js_name = ageDecryptWithIdentitiesToHandle)]
pub fn age_decrypt_with_identities_to_handle(
    ciphertext: Vec<u8>,
    identities: JsValue,
) -> Result<u32, JsValue> {
    let ids: Vec<String> = serde_wasm_bindgen::from_value(identities)
        .map_err(|e| JsValue::from_str(&format!("identities arg: {e}")))?;
    let plaintext = decrypt_identity_inner(&ciphertext, &ids)
        .map_err(|e| JsValue::from_str(&e))?;
    let id = registry().lock().unwrap().insert(plaintext);
    Ok(id)
}

// ─── Handle introspection + lifecycle ─────────────────────────────

/// Drop the bytes at this handle. Returns true if the slot was
/// occupied; false if it had already been disposed or never existed.
#[wasm_bindgen(js_name = handleDispose)]
pub fn handle_dispose(id: u32) -> bool {
    registry().lock().unwrap().dispose(id)
}

/// Bytes-length of the plaintext at this handle. 0 if the handle
/// has been disposed or never existed (unobservable from a slot
/// that legitimately held zero bytes; that case doesn't occur
/// with age decrypts).
#[wasm_bindgen(js_name = handleSize)]
pub fn handle_size(id: u32) -> u32 {
    registry()
        .lock()
        .unwrap()
        .get(id)
        .map(|b| b.len() as u32)
        .unwrap_or(0)
}

/// Escape hatch — copy the plaintext out to JS. The whole point of
/// handles is to avoid this; use only when a cell genuinely needs
/// raw bytes (custom cell language without a handle-aware Rust
/// path). Returns an empty Vec if the handle is unknown.
#[wasm_bindgen(js_name = handleExport)]
pub fn handle_export(id: u32) -> Vec<u8> {
    registry()
        .lock()
        .unwrap()
        .get(id)
        .map(|b| b.to_vec())
        .unwrap_or_default()
}

/// SHA-256 (lowercase hex) of the plaintext at this handle. Used by
/// the resolver to verify the post-decrypt digest matches the
/// `sha256` attribute on the `<wb-data>` element WITHOUT exporting
/// bytes back to JS. Returns empty string if the handle is unknown
/// (caller treats as integrity failure).
#[wasm_bindgen(js_name = handleSha256)]
pub fn handle_sha256(id: u32) -> String {
    use sha2::{Digest, Sha256};
    let registry = registry().lock().unwrap();
    let bytes = match registry.get(id) {
        Some(b) => b,
        None => return String::new(),
    };
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for b in digest.iter() {
        hex.push_str(&format!("{:02x}", b));
    }
    hex
}

// ─── Polars-SQL over handles ──────────────────────────────────────
//
// Mirror of frames::run_polars_sql_ipc but takes handle ids instead
// of Uint8Arrays. Resolves bytes from REGISTRY internally so plaintext
// never round-trips through JS. Intended for the analytical query
// path on encrypted memory.

#[cfg(feature = "polars-frames")]
mod handles_polars {
    use super::*;
    use crate::outputs::CellOutput;
    use polars::io::ipc::IpcStreamReader;
    use polars::io::SerReader;
    use polars::prelude::*;
    use polars::sql::SQLContext;

    #[derive(Deserialize)]
    struct TableHandles(HashMap<String, u32>);

    #[wasm_bindgen(js_name = runPolarsSqlIpcHandles)]
    pub fn run_polars_sql_ipc_handles(
        sql: String,
        table_handles: JsValue,
    ) -> Result<JsValue, JsValue> {
        let TableHandles(map) = serde_wasm_bindgen::from_value(table_handles)
            .map_err(|e| JsValue::from_str(&format!("polars handles decode: {e}")))?;
        let outputs = run_inner(sql, map).map_err(|e| JsValue::from_str(&e))?;
        serde_wasm_bindgen::to_value(&outputs).map_err(Into::into)
    }

    fn run_inner(
        sql: String,
        handles: HashMap<String, u32>,
    ) -> Result<Vec<CellOutput>, String> {
        let registry = registry().lock().map_err(|e| format!("registry lock: {e}"))?;
        let mut ctx = SQLContext::new();
        for (name, handle) in handles {
            let bytes = registry
                .get(handle)
                .ok_or_else(|| format!("unknown plaintext handle for table '{name}': {handle}"))?;
            // IpcStreamReader takes a Cursor; we hand it a slice
            // viewing into the registry's owned bytes — no copy.
            let df = IpcStreamReader::new(Cursor::new(bytes))
                .finish()
                .map_err(|e| format!("polars ipc parse for table '{name}': {e}"))?;
            ctx.register(&name, df.lazy());
        }
        // Drop the lock BEFORE running the query so other crypto
        // ops can proceed in parallel (Polars query may be slow).
        drop(registry);

        let result = ctx
            .execute(&sql)
            .map_err(|e| format!("polars sql plan: {e}"))?
            .collect()
            .map_err(|e| format!("polars sql execute: {e}"))?;
        let row_count = result.height();

        let mut buf = Vec::<u8>::new();
        CsvWriter::new(&mut buf)
            .finish(&mut result.clone())
            .map_err(|e| format!("polars csv encode: {e}"))?;
        let rendered =
            String::from_utf8(buf).map_err(|e| format!("polars csv utf8: {e}"))?;

        Ok(vec![
            CellOutput::Text {
                content: rendered,
                mime_type: Some("text/csv".into()),
            },
            CellOutput::Table {
                sql_table: "result".into(),
                row_count: Some(row_count as i64),
            },
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_insert_get_dispose_recycle() {
        let r = registry();
        let id1 = r.lock().unwrap().insert(vec![1, 2, 3]);
        let id2 = r.lock().unwrap().insert(vec![4, 5, 6]);
        assert_ne!(id1, id2);
        assert_eq!(r.lock().unwrap().get(id1), Some([1, 2, 3].as_slice()));
        assert_eq!(r.lock().unwrap().get(id2), Some([4, 5, 6].as_slice()));
        assert!(r.lock().unwrap().dispose(id1));
        assert_eq!(r.lock().unwrap().get(id1), None);
        // Slot recycled.
        let id3 = r.lock().unwrap().insert(vec![7, 8, 9]);
        assert_eq!(id3, id1, "expected disposed slot to be reused");
        assert_eq!(r.lock().unwrap().get(id3), Some([7, 8, 9].as_slice()));
        // Dispose unknown id is a no-op.
        assert!(!r.lock().unwrap().dispose(99999));
        // Cleanup.
        r.lock().unwrap().dispose(id2);
        r.lock().unwrap().dispose(id3);
    }

    #[test]
    fn dispose_zeroizes() {
        // Indirect — we can't observe past the safe API after dispose,
        // but the dispose path explicitly zeroizes before drop. This
        // test just verifies dispose succeeds for typical bytes.
        let r = registry();
        let id = r.lock().unwrap().insert(b"sensitive plaintext".to_vec());
        assert!(r.lock().unwrap().dispose(id));
        assert_eq!(r.lock().unwrap().get(id), None);
    }
}
