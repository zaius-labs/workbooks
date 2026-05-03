// Author identity persistence (C8.7-B).
//
// Stores the broker-issued (author_sub, author_email, key_id) tuple
// the daemon needs every time it signs an author claim. Once the
// user runs the one-time `/author/register` flow, this file persists
// across daemon restarts so subsequent saves sign automatically.
//
// File: ~/Library/Application Support/sh.workbooks.workbooksd/signing/
//       author_identity.json
//
// Schema:
//   {
//     "schema_version": 1,
//     "author_sub":     "workos|user_…",
//     "author_email":   "alice@acme.example",
//     "key_id":         "broker-issued opaque id",
//     "broker_url":     "https://broker.signal.ml",
//     "registered_at":  1730000000
//   }
//
// Bearer is NOT persisted — author registration produces a bearer
// that's used once for the broker POST and then dropped. If the
// pubkey ever needs to be re-registered (e.g., after a key reset),
// the user re-runs `/author/register` interactively. We're not
// trying to be a second session store; the broker is.
//
// Tracker: bd show core-1fi.8.7.1

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const SCHEMA_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
pub struct AuthorIdentity {
    pub schema_version: u32,
    pub author_sub: String,
    pub author_email: String,
    pub key_id: String,
    pub broker_url: String,
    pub registered_at: i64,
}

fn identity_path() -> PathBuf {
    crate::claim_sign::author_identity_path()
}

pub fn save(identity: &AuthorIdentity) -> Result<(), String> {
    let path = identity_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(identity)
        .map_err(|e| format!("serialize: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body.as_bytes())
        .map_err(|e| format!("write tmp: {e}"))?;
    // Tighten perms BEFORE rename — the file may briefly hold the
    // identity tuple before the umask catches up.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

pub fn load() -> Result<Option<AuthorIdentity>, String> {
    let path = identity_path();
    if !path.exists() {
        return Ok(None);
    }
    let body = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let identity: AuthorIdentity =
        serde_json::from_str(&body).map_err(|e| format!("parse: {e}"))?;
    if identity.schema_version != SCHEMA_VERSION {
        // Future schema bump: fail closed, force re-registration.
        // Don't auto-delete — preserves debuggability if a user
        // downgrades.
        return Err(format!(
            "author_identity.json schema_version {} unsupported (expected {SCHEMA_VERSION}); re-run /author/register",
            identity.schema_version
        ));
    }
    Ok(Some(identity))
}

pub fn current_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
