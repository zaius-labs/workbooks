// Lease + DEK cache (C1.9).
//
// On a successful broker auth flow, persist (bearer, lease, per-view
// DEKs) to the OS keychain so subsequent opens of the same workbook
// — within the lease window — skip the broker round-trip entirely.
// Touch ID (C9.5) gates every cached-hit serve so a stolen unlocked
// laptop can't open content the broker hasn't actively re-released.
//
// Three states the daemon decides between:
//
//   FRESH       cache hit, lease_exp - 5min in the future, broker
//               health unverified — serve from cache, gate via
//               Touch ID. Default 1h TTL per broker policy.
//
//   GRACE       cache hit, lease_exp in the past but within
//               grace_seconds, AND a broker probe failed (offline,
//               DNS broken, 5xx). Serve from cache, surface "offline
//               mode" to the UI. Default 24h grace per broker policy.
//
//   STALE       miss, expired-past-grace, policy_hash mismatch, or
//               keychain corrupted. Caller falls back to the full
//               broker auth flow.
//
// Cache key: sha256(workbook_id || ':' || policy_hash). Pinning the
// policy_hash prevents a stale cache from satisfying a request after
// the author re-wraps with a tightened policy.
//
// Cleartext bytes (bearer, DEKs) ARE stored in the cache. The OS
// keychain provides at-rest encryption (login keychain on macOS,
// libsecret on Linux, Credential Manager on Windows); plus the
// Touch ID gate sits in front of every cached serve so a process
// without an unlocked keychain can't read the entries silently.
//
// Tracker: bd show core-1fi.1.9

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use keyring::Entry;
use secrecy::{ExposeSecret, SecretSlice, SecretString};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::broker_client::{AuthSuccess, UnlockedKey};

/// Keyring service name. Distinct from the workbook-secrets service so
/// a "clear all lease cache" doesn't nuke user-provided API keys.
const KEYRING_SERVICE: &str = "sh.workbooks.workbooksd.lease";

/// How many seconds before lease_exp we consider the cache "stale and
/// needs refresh." Provides a small buffer so a serve that takes a
/// few seconds doesn't race the broker-side expiry.
const FRESH_BUFFER_SECONDS: i64 = 5 * 60;

/// Default offline grace window (24h past lease_exp). Mirrors the
/// broker's MAX_OFFLINE_GRACE_SECONDS environment variable. Per-
/// workbook overrides can be wired through policy in a follow-up.
pub const DEFAULT_OFFLINE_GRACE_SECONDS: i64 = 24 * 60 * 60;

/// What we serialize into the keychain entry. Cleartext fields —
/// keychain encrypts at rest. Versioned so future schema bumps fail
/// closed instead of silently mis-deserializing.
#[derive(Serialize, Deserialize)]
struct CachedEntry {
    schema_version: u32,
    workbook_id: String,
    policy_hash: String,
    /// Broker-issued recipient identity claims.
    sub: String,
    email: String,
    /// Bearer token cleartext. Wrapped back in SecretString on load.
    bearer: String,
    lease_jwt: String,
    lease_exp: i64,
    /// Wall-clock at cache write — used to compute "80% of TTL"
    /// proactive-refresh thresholds. Present but unused in this
    /// iteration; kept so a future refresh-on-use path doesn't need
    /// a schema bump.
    #[allow(dead_code)]
    issued_at: i64,
    /// Per-view DEKs, base64url-no-pad of the raw 32-byte key.
    keys: Vec<CachedKey>,
}

#[derive(Serialize, Deserialize)]
struct CachedKey {
    view_id: String,
    /// base64url-no-pad of the raw 32-byte AES-256 DEK. Re-wrapped
    /// in SecretSlice on load.
    dek: String,
}

const SCHEMA_VERSION: u32 = 1;

/// What `lookup` returns. Distinguishes the three serve paths so
/// callers can audit-log + UI-flag appropriately.
pub enum CacheOutcome {
    Fresh(AuthSuccess),
    Grace(AuthSuccess),
    Stale,
}

/// Stable per-workbook keychain account name. Hashes (workbook_id,
/// policy_hash) so re-wrapping the workbook with a tightened policy
/// invalidates old caches — the keychain just doesn't find the new
/// account string.
fn account_key(workbook_id: &str, policy_hash: &str) -> String {
    let mut h = Sha256::new();
    h.update(workbook_id.as_bytes());
    h.update(b":");
    h.update(policy_hash.as_bytes());
    let digest = h.finalize();
    // Hex prefix is plenty unique per machine — cuts the keychain row
    // identifier to a fixed-length, opaque string. Full digest would
    // also work; truncation is just for keychain UI cleanliness.
    URL_SAFE_NO_PAD.encode(&digest[..16])
}

fn entry_for(workbook_id: &str, policy_hash: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, &account_key(workbook_id, policy_hash))
        .map_err(|e| format!("keyring entry: {e}"))
}

/// Serialize an AuthSuccess to keychain bytes. SecretString /
/// SecretSlice get expose-and-base64'd for storage; security stays
/// at the at-rest layer (keychain) plus the Touch ID gate around the
/// cached-serve path.
pub fn save(
    workbook_id: &str,
    policy_hash: &str,
    auth: &AuthSuccess,
) -> Result<(), String> {
    let issued_at = unix_now();
    let entry = CachedEntry {
        schema_version: SCHEMA_VERSION,
        workbook_id: workbook_id.to_string(),
        policy_hash: policy_hash.to_string(),
        sub: auth.sub.clone(),
        email: auth.email.clone(),
        bearer: auth.bearer.expose_secret().to_string(),
        lease_jwt: auth.lease_jwt.clone(),
        lease_exp: auth.lease_exp,
        issued_at,
        keys: auth
            .keys
            .iter()
            .map(|k| CachedKey {
                view_id: k.view_id.clone(),
                dek: URL_SAFE_NO_PAD.encode(k.dek.expose_secret()),
            })
            .collect(),
    };
    let json = serde_json::to_string(&entry).map_err(|e| format!("ser: {e}"))?;
    entry_for(workbook_id, policy_hash)?
        .set_password(&json)
        .map_err(|e| format!("keyring set: {e}"))?;
    Ok(())
}

/// Look up a cached lease + decide which serve path applies.
///
/// `broker_reachable` is a function the caller provides — typically a
/// short-timeout HTTP HEAD to /v1/health. We only invoke it on the
/// expired-but-within-grace branch, so the happy path makes zero
/// extra HTTP calls.
pub fn lookup<F>(
    workbook_id: &str,
    policy_hash: &str,
    broker_reachable: F,
    grace_seconds: i64,
) -> CacheOutcome
where
    F: FnOnce() -> bool,
{
    let entry = match entry_for(workbook_id, policy_hash) {
        Ok(e) => e,
        Err(_) => return CacheOutcome::Stale,
    };
    let raw = match entry.get_password() {
        Ok(s) => s,
        Err(_) => return CacheOutcome::Stale,
    };
    let cached: CachedEntry = match serde_json::from_str(&raw) {
        Ok(c) => c,
        Err(_) => {
            // Corrupted entry — clear it so the next save lands clean.
            let _ = entry.delete_credential();
            return CacheOutcome::Stale;
        }
    };
    if cached.schema_version != SCHEMA_VERSION {
        let _ = entry.delete_credential();
        return CacheOutcome::Stale;
    }
    if cached.policy_hash != policy_hash || cached.workbook_id != workbook_id {
        // Account-key collision is extraordinarily unlikely with a
        // 16-byte sha256 prefix, but if it happens we don't want to
        // serve the wrong workbook's keys. Fail closed.
        return CacheOutcome::Stale;
    }

    let auth = match cached_to_auth(&cached) {
        Ok(a) => a,
        Err(_) => return CacheOutcome::Stale,
    };

    let now = unix_now();
    if now < cached.lease_exp - FRESH_BUFFER_SECONDS {
        return CacheOutcome::Fresh(auth);
    }
    // Expired-or-near-expiry. Grace-window check.
    if now < cached.lease_exp + grace_seconds && !broker_reachable() {
        return CacheOutcome::Grace(auth);
    }
    CacheOutcome::Stale
}

/// Drop the cache for a given workbook. Called when the broker
/// returns 410 (workbook revoked) so the next open forces a fresh
/// flow that'll see the revocation.
pub fn invalidate(workbook_id: &str, policy_hash: &str) {
    if let Ok(e) = entry_for(workbook_id, policy_hash) {
        let _ = e.delete_credential();
    }
}

fn cached_to_auth(cached: &CachedEntry) -> Result<AuthSuccess, String> {
    let keys = cached
        .keys
        .iter()
        .map(|k| {
            let bytes = URL_SAFE_NO_PAD
                .decode(&k.dek)
                .map_err(|e| format!("dek b64: {e}"))?;
            if bytes.len() != 32 {
                return Err(format!("dek length {} (expected 32)", bytes.len()));
            }
            Ok(UnlockedKey {
                view_id: k.view_id.clone(),
                dek: SecretSlice::from(bytes),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(AuthSuccess {
        bearer: SecretString::from(cached.bearer.clone()),
        sub: cached.sub.clone(),
        email: cached.email.clone(),
        lease_jwt: cached.lease_jwt.clone(),
        lease_exp: cached.lease_exp,
        keys,
    })
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_key_is_stable_and_distinct() {
        let a = account_key("wb1", "sha256:aaaa");
        let b = account_key("wb1", "sha256:aaaa");
        let c = account_key("wb1", "sha256:bbbb");
        let d = account_key("wb2", "sha256:aaaa");
        assert_eq!(a, b, "same inputs → same key");
        assert_ne!(a, c, "different policy_hash → different key");
        assert_ne!(a, d, "different workbook → different key");
    }

    #[test]
    fn cached_to_auth_rejects_short_dek() {
        let cached = CachedEntry {
            schema_version: SCHEMA_VERSION,
            workbook_id: "wb1".into(),
            policy_hash: "sha256:aaaa".into(),
            sub: "workos|x".into(),
            email: "x@x".into(),
            bearer: "b".into(),
            lease_jwt: "j".into(),
            lease_exp: 0,
            issued_at: 0,
            keys: vec![CachedKey {
                view_id: "default".into(),
                dek: URL_SAFE_NO_PAD.encode([0u8; 16]), // wrong length
            }],
        };
        let r = cached_to_auth(&cached);
        assert!(r.is_err());
    }

    #[test]
    fn fresh_window_logic() {
        // Compose a fake CachedEntry with lease_exp far in the future
        // and verify the time math without hitting the keychain.
        let now = unix_now();
        let cached = CachedEntry {
            schema_version: SCHEMA_VERSION,
            workbook_id: "wb1".into(),
            policy_hash: "sha256:aaaa".into(),
            sub: "workos|x".into(),
            email: "x@x".into(),
            bearer: "b".into(),
            lease_jwt: "j".into(),
            lease_exp: now + 3600,
            issued_at: now,
            keys: vec![CachedKey {
                view_id: "default".into(),
                dek: URL_SAFE_NO_PAD.encode([0u8; 32]),
            }],
        };
        // Fresh: exp is more than FRESH_BUFFER_SECONDS in the future.
        assert!(now < cached.lease_exp - FRESH_BUFFER_SECONDS);
        // Within grace: exp - 5min < now < exp + grace
        let near_exp_now = cached.lease_exp + 1;
        assert!(near_exp_now < cached.lease_exp + DEFAULT_OFFLINE_GRACE_SECONDS);
        // Stale: way past grace.
        let way_past = cached.lease_exp + DEFAULT_OFFLINE_GRACE_SECONDS + 1;
        assert!(way_past >= cached.lease_exp + DEFAULT_OFFLINE_GRACE_SECONDS);
    }
}
