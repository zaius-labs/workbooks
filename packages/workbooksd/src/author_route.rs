// Author-claim HTTP surface (C8.7-A).
//
// Two endpoints, both on the public router (no /wb/<token> scope).
// The CLI's `workbook seal --sign` calls these to embed a signed
// author claim into the wrapStudio envelope.
//
//   GET  /author/identity   → { pubkey, key_fingerprint }
//   POST /author/sign-claim → { sig }
//
// 8.7-A keeps the broker fully out of the daemon's hot path: the
// caller passes (author_sub, author_email, key_id) explicitly. 8.7-B
// will fold in broker auth + auto-registration so the daemon resolves
// its own identity. The byte layout the daemon signs is the same in
// both iterations — see claim_sign::canonical_claim_bytes.

use axum::{http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};

use crate::claim_sign::{self, ClaimArgs};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

#[derive(Serialize)]
pub struct IdentityResponse {
    /// Raw 32-byte ed25519 public key, base64url-no-pad. The recipient
    /// pre-auth shell imports this via WebCrypto's
    /// `crypto.subtle.importKey("raw", ..., "Ed25519")`. Same encoding
    /// the broker /v1/authors/me/keys POST handler accepts.
    pub pubkey: String,
    /// SHA-256 hex prefix of the pubkey bytes (16 hex chars). This is
    /// a STABLE local fingerprint — useful for the CLI to recognize
    /// "the daemon's identity hasn't changed" before re-using a cached
    /// key_id from the broker. The broker's `key_id` (random 16
    /// bytes) is not derived from the pubkey, so the CLI must store
    /// the broker-issued id alongside this fingerprint and validate
    /// they still pair. NOT a substitute for the broker key_id.
    pub key_fingerprint: String,
}

pub async fn get_identity() -> impl IntoResponse {
    let pubkey = match claim_sign::pubkey_bytes() {
        Ok(p) => p,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "identity_load_failed", "detail": e})),
            )
                .into_response();
        }
    };
    use sha2::{Digest, Sha256};
    let fp_full = hex::encode(Sha256::digest(pubkey));
    (
        StatusCode::OK,
        Json(IdentityResponse {
            pubkey: URL_SAFE_NO_PAD.encode(pubkey),
            key_fingerprint: fp_full[..16].to_string(),
        }),
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct SignClaimRequest {
    pub author_sub: String,
    pub author_email: String,
    pub key_id: String,
    pub workbook_id: String,
    pub ts: i64,
}

#[derive(Serialize)]
pub struct SignClaimResponse {
    /// Raw 64-byte ed25519 signature, base64url-no-pad. Caller
    /// (workbook-cli's seal command) passes this straight into
    /// wrapStudio as `claimSig`.
    pub sig: String,
}

pub async fn sign_claim(Json(req): Json<SignClaimRequest>) -> impl IntoResponse {
    // Bound input lengths to keep an attacker from forcing the daemon
    // to allocate or hash arbitrary input. None of these fields have
    // a legitimate reason to exceed a few hundred bytes; numbers
    // beyond that are signs of misuse, not creative authorship.
    if req.author_sub.is_empty()
        || req.author_email.is_empty()
        || req.key_id.is_empty()
        || req.workbook_id.is_empty()
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "missing_fields"})),
        )
            .into_response();
    }
    if req.author_sub.len() > 256
        || req.author_email.len() > 320
        || req.key_id.len() > 64
        || req.workbook_id.len() > 256
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "field_too_long"})),
        )
            .into_response();
    }

    let args = ClaimArgs {
        author_sub: &req.author_sub,
        author_email: &req.author_email,
        key_id: &req.key_id,
        workbook_id: &req.workbook_id,
        ts: req.ts,
    };
    match claim_sign::sign_claim(args) {
        Ok(sig_bytes) => (
            StatusCode::OK,
            Json(SignClaimResponse {
                sig: URL_SAFE_NO_PAD.encode(sig_bytes),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "sign_failed", "detail": e})),
        )
            .into_response(),
    }
}
