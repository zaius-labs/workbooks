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

use crate::author_identity::{self, AuthorIdentity};
use crate::broker_client;
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
    /// All identity fields are optional — when omitted, the daemon
    /// falls back to ~/Library/.../signing/author_identity.json
    /// written by /author/register (C8.7-B). When present, they
    /// override the cache (used by callers who manage identity
    /// themselves — C8.7-A wire shape).
    #[serde(default)]
    pub author_sub: Option<String>,
    #[serde(default)]
    pub author_email: Option<String>,
    #[serde(default)]
    pub key_id: Option<String>,
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
    if req.workbook_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "missing_fields", "missing": "workbook_id"})),
        )
            .into_response();
    }
    if req.workbook_id.len() > 256 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "field_too_long"})),
        )
            .into_response();
    }

    // Resolve identity — explicit body fields override; otherwise
    // fall back to the cached registration written by /author/register.
    // If the request has none of the three identity fields AND there's
    // no cached identity, we 401 with a clear hint pointing at
    // /author/register so the CLI can auto-trigger the flow.
    let cached = match author_identity::load() {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "identity_load_failed", "detail": e})),
            )
                .into_response();
        }
    };

    let author_sub = match (&req.author_sub, &cached) {
        (Some(s), _) if !s.is_empty() => s.clone(),
        (_, Some(c)) => c.author_sub.clone(),
        _ => {
            return not_registered_response();
        }
    };
    let author_email = match (&req.author_email, &cached) {
        (Some(s), _) if !s.is_empty() => s.clone(),
        (_, Some(c)) => c.author_email.clone(),
        _ => {
            return not_registered_response();
        }
    };
    let key_id = match (&req.key_id, &cached) {
        (Some(s), _) if !s.is_empty() => s.clone(),
        (_, Some(c)) => c.key_id.clone(),
        _ => {
            return not_registered_response();
        }
    };

    if author_sub.len() > 256 || author_email.len() > 320 || key_id.len() > 64 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "field_too_long"})),
        )
            .into_response();
    }

    let args = ClaimArgs {
        author_sub: &author_sub,
        author_email: &author_email,
        key_id: &key_id,
        workbook_id: &req.workbook_id,
        ts: req.ts,
    };
    match claim_sign::sign_claim(args) {
        Ok(sig_bytes) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "sig": URL_SAFE_NO_PAD.encode(sig_bytes),
                "author_sub": author_sub,
                "author_email": author_email,
                "key_id": key_id,
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "sign_failed", "detail": e})),
        )
            .into_response(),
    }
}

fn not_registered_response() -> axum::response::Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({
            "error": "not_registered",
            "hint": "POST /author/register to authenticate + register this machine's pubkey",
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub broker_url: String,
    /// Optional human label for the registered key (surfaced on the
    /// public verification page). Defaults to the machine's hostname
    /// when omitted; harmless if missing.
    #[serde(default)]
    pub label: Option<String>,
}

/// POST /author/register
///
/// Run the broker's interactive auth flow (browser opens, user signs
/// in via WorkOS), receive a bearer, register this machine's ed25519
/// pubkey at the broker under the resulting WorkOS sub, persist the
/// (sub, email, key_id) tuple to ~/.../signing/author_identity.json.
///
/// Idempotent on the broker side — re-registering the same pubkey
/// returns the same key_id (broker uses an upsert keyed on (sub,
/// pubkey)). Calling this when an identity is already cached
/// REFRESHES the cache + updates registered_at.
///
/// Blocks for up to 5 minutes (broker_client::AUTH_FLOW_TIMEOUT).
/// Caller should display "check your browser" UX while waiting.
pub async fn register(Json(req): Json<RegisterRequest>) -> impl IntoResponse {
    if req.broker_url.is_empty() || !req.broker_url.starts_with("http") {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "bad_broker_url"})),
        )
            .into_response();
    }

    // Step 1 — pubkey we're about to register. Loaded BEFORE auth so
    // a missing identity (cert+key not yet minted) fails fast.
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
    let pubkey_b64 = URL_SAFE_NO_PAD.encode(pubkey);

    // Step 2 — interactive broker auth.
    let auth = match broker_client::run_auth_only(&req.broker_url, |url| {
        // Best-effort browser open. macOS `open <url>`. Failure is
        // logged but not fatal; the CLI can surface the URL to the
        // user via stderr.
        eprintln!("[workbooksd] /author/register opening browser: {url}");
        let _ = std::process::Command::new("open").arg(url).spawn();
    })
    .await
    {
        Ok(a) => a,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(
                    serde_json::json!({"error": "broker_auth_failed", "detail": format!("{e}")}),
                ),
            )
                .into_response();
        }
    };

    // Step 3 — register pubkey at broker.
    // Default label: try `uname -n` via the gethostname C call,
    // fall back to a static string. Surfaced on the broker's public
    // verification page so the user can recognize "this is alice's
    // macbook" later.
    let label = req
        .label
        .unwrap_or_else(|| machine_label().unwrap_or_else(|| "workbooks-daemon".to_string()));
    let key_id = match broker_client::register_author_key(
        &req.broker_url,
        &auth.bearer,
        &pubkey_b64,
        &label,
    )
    .await
    {
        Ok(id) => id,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({
                    "error": "register_key_failed",
                    "detail": format!("{e}"),
                })),
            )
                .into_response();
        }
    };

    // Step 4 — persist.
    let identity = AuthorIdentity {
        schema_version: 1,
        author_sub: auth.sub.clone(),
        author_email: auth.email.clone(),
        key_id: key_id.clone(),
        broker_url: req.broker_url.trim_end_matches('/').to_string(),
        registered_at: author_identity::current_unix(),
    };
    if let Err(e) = author_identity::save(&identity) {
        // Save failed — return success-ish but flag the persistence
        // problem. The broker registration already happened; if the
        // user re-runs we'll just re-register (idempotent) and try
        // saving again.
        return (
            StatusCode::OK,
            Json(serde_json::json!({
                "author_sub": auth.sub,
                "author_email": auth.email,
                "key_id": key_id,
                "warning": format!("registered at broker but failed to persist locally: {e}"),
            })),
        )
            .into_response();
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "author_sub": auth.sub,
            "author_email": auth.email,
            "key_id": key_id,
        })),
    )
        .into_response()
}

/// Best-effort machine label. Reads HOSTNAME / COMPUTERNAME env, or
/// falls back to the binary path basename. Avoids a hostname-crate
/// dep for what's a single label string surfaced on the broker.
fn machine_label() -> Option<String> {
    if let Ok(h) = std::env::var("HOSTNAME") {
        if !h.is_empty() {
            return Some(h);
        }
    }
    if let Ok(h) = std::env::var("COMPUTERNAME") {
        if !h.is_empty() {
            return Some(h);
        }
    }
    // /etc/hostname on Linux; /var/run/hostname on macOS doesn't
    // always exist — fall through to None on macOS, which is fine
    // since the user can pass a label explicitly.
    if let Ok(h) = std::fs::read_to_string("/etc/hostname") {
        let trimmed = h.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// GET /author/registration — read-only view of the cached identity.
/// Returns 200 with the tuple if present, 404 if not registered.
/// Used by CLIs that want to know whether `/author/register` has
/// run before kicking off a sign-claim.
pub async fn get_registration() -> impl IntoResponse {
    match author_identity::load() {
        Ok(Some(id)) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "author_sub": id.author_sub,
                "author_email": id.author_email,
                "key_id": id.key_id,
                "broker_url": id.broker_url,
                "registered_at": id.registered_at,
            })),
        )
            .into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "not_registered"})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "load_failed", "detail": e})),
        )
            .into_response(),
    }
}
