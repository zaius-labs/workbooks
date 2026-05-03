// On Windows, release builds opt out of the console subsystem so the
// daemon runs as a true background process (no black console window
// flashing at login or install). Debug builds keep the console so
// `cargo run` shows eprintln! / panic output for developers.
//
// macOS and Linux ignore this attribute (compile-time cfg gates it).
#![cfg_attr(all(target_os = "windows", not(debug_assertions)), windows_subsystem = "windows")]

// workbooksd — local background daemon that serves and saves
// .html files to the user's browser.
//
// Subcommands:
//   workbooksd                    run as daemon (long-running)
//   workbooksd open <path>        ask the running daemon to open <path>
//                                 in the user's default browser; spawns
//                                 the daemon if it isn't running
//
// HTTP routes (daemon mode):
//   GET  /health                  detection probe (CORS-permissive)
//   POST /open                    body: {"path":"..."} → {"token","url"}
//                                 binds an absolute, validated path to a
//                                 fresh token. Localhost-only.
//   GET  /wb/:token/              serve the bound file as text/html
//   PUT  /wb/:token/save          overwrite the bound file (atomic)
//
//   Secrets — workbook API keys never enter browser memory; the daemon
//   stores them in the OS keychain bound to the WORKBOOK FILE PATH
//   (not the session token), so secrets survive daemon restarts and
//   tab close + re-open. Lookup is gated on the token's bound path,
//   so token A can only ever read secrets for the path token A was
//   minted against — closes the cross-workbook key-theft hole.
//
//   POST /wb/:token/secret/set    body: {"id":"FAL_API_KEY","value":"..."}
//   POST /wb/:token/secret/delete body: {"id":"FAL_API_KEY"}
//   GET  /wb/:token/secret/list   → {"ids":["FAL_API_KEY",...]} (no values)
//
//   Outbound HTTPS proxy — caller asks the daemon to make a request,
//   naming a secret to splice into a header. Daemon performs the call,
//   returns the response. Browser code never sees the secret value.
//
//   POST /wb/:token/proxy         body: { url, method, headers, body,
//                                         auth: { headerName, secretId,
//                                                 format } }
//                                 → { status, headers, body }
//
// Security model:
//   - 127.0.0.1 only, port 47119
//   - Tokens are 16 random bytes (hex) via getrandom; lookup is O(1)
//   - Tokens bind a single canonicalized absolute path. PUT /wb/:token/save
//     can only ever overwrite that one path.
//   - Open candidates must (a) canonicalize successfully (file exists)
//     and (b) end in `.html` — defense-in-depth so a stray
//     /open call can't bind /etc/passwd.
//   - /health is the only route with permissive CORS, since file:// pages
//     probe it as a fallback. Bound /wb/* routes are same-origin
//     (browser loaded from http://127.0.0.1:47119) so they need no CORS.

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path as AxPath, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, post, put},
    Router,
};

mod acp;
mod author_identity;
mod author_route;
mod broker_client;
mod c2pa_sign;
mod claim_sign;
mod default_handler;
mod download_watcher;
mod edit_log;
mod envelope;
mod ledger;
mod lease_cache;
mod local_auth;
mod permissions;
mod spotlight_discover;
mod xattr_openwith;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};

const BIND_HOST: &str = "127.0.0.1";
/// Port chosen at startup. Bound to 127.0.0.1:0 to get an
/// OS-assigned ephemeral port; written to runtime.json so the
/// `workbooksd open` subcommand and the test harness can find
/// the running daemon. Predictable ports (the old 47119) made
/// targeted local-host attacks easier — a malicious page on
/// the same machine could pre-script /open POSTs against a
/// known address. Random ports widen the search space and pair
/// nicely with the require_daemon_origin same-port check.
pub(crate) static BOUND_PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();
/// Public accessor — panics if called before the listener bind
/// (which only happens in unit-test contexts that don't spin
/// the daemon at all).
pub(crate) fn bound_port() -> u16 {
    *BOUND_PORT.get().expect("daemon listener has not bound yet")
}
const MAX_SESSIONS: usize = 1000;
const OPEN_BURST: f64 = 10.0;
const OPEN_REFILL_PER_MIN: f64 = 10.0;

// ── shared state ────────────────────────────────────────────────────

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) sessions: Arc<Mutex<SessionStore>>,
    open_bucket: Arc<Mutex<TokenBucket>>,
}

impl Default for AppState {
    fn default() -> Self {
        let cap = std::env::var("WB_MAX_SESSIONS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(MAX_SESSIONS);
        let burst = std::env::var("WB_OPEN_BURST")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(OPEN_BURST);
        let refill_per_min = std::env::var("WB_OPEN_REFILL_PER_MIN")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(OPEN_REFILL_PER_MIN);
        Self {
            sessions: Arc::new(Mutex::new(SessionStore::new(cap))),
            open_bucket: Arc::new(Mutex::new(TokenBucket::new(
                burst,
                refill_per_min / 60.0,
            ))),
        }
    }
}

struct TokenBucket {
    capacity: f64,
    refill_per_sec: f64,
    tokens: f64,
    last_refill: Instant,
}

impl TokenBucket {
    fn new(capacity: f64, refill_per_sec: f64) -> Self {
        Self { capacity, refill_per_sec, tokens: capacity, last_refill: Instant::now() }
    }

    /// Try to take one token. On success returns Ok; on failure returns
    /// the Duration the caller should wait before retrying.
    fn try_acquire(&mut self) -> Result<(), Duration> {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        self.last_refill = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            Ok(())
        } else {
            let secs = (1.0 - self.tokens) / self.refill_per_sec;
            Err(Duration::from_secs_f64(secs))
        }
    }
}

pub(crate) struct SessionStore {
    cap: usize,
    map: HashMap<String, Session>,
}

struct Session {
    path: PathBuf,
    last_access: Instant,
    /// Per-secret domain allowlist parsed from the workbook's
    /// `<script id="workbook-spec">` JSON. Populated lazily on the
    /// first /proxy / /secret request — defaults to "no policy
    /// declared, allow any HTTPS host" so workbooks that haven't
    /// adopted the schema keep working. Once populated, /proxy
    /// enforces it: a secret listed here can only be sent to one
    /// of the named hosts. Hosts support `*.example.com` wildcards.
    secrets_policy: Option<SecretsPolicy>,
    /// Per-workbook permissions parsed from the served HTML's
    /// `<meta name="wb-permissions">` tag. Populated by
    /// serve_workbook; gates /agent/* and (future phases) /secret/*.
    permissions: Option<permissions::Permissions>,
    /// Substrate workbook_id, parsed once from the served file's
    /// `<script id="wb-meta">` block. Used as the ledger's primary
    /// key. None for fresh-build workbooks that haven't had a
    /// first save yet — they'll get an id assigned at first save
    /// and the daemon picks it up from the save body.
    workbook_id: Option<String>,
    /// Paths the daemon itself wrote to scratch (via /agent/seed),
    /// timestamped. The notify-rs watcher consults this to suppress
    /// echo events: when the browser pre-seeds composition.html
    /// before a prompt, the watcher would otherwise fire a
    /// `_relay/file-changed` for that write and the browser would
    /// re-set composition state to the value it just sent — a no-op
    /// in data terms but a visible flicker in the iframe player.
    /// Entries within `SEED_ECHO_WINDOW_MS` are skipped.
    recently_seeded: HashMap<String, Instant>,
    /// In-memory cleartext per unlocked view for sealed (studio-v1)
    /// workbooks. When non-empty, /wb/<token>/ serves the chosen
    /// view's bytes instead of reading from `path` — the file on
    /// disk is the encrypted envelope, and cleartext deliberately
    /// never lands on disk. Each value is held in `secrecy::SecretBox`
    /// so it's zeroized on drop and can't be formatted into a log
    /// line. C2 multi-view: a recipient with full + redacted policy
    /// gets both decrypted; the daemon serves whichever view the URL
    /// path selects (default = first alphabetical, or "default" if
    /// the workbook publishes one).
    cleartexts: HashMap<String, secrecy::SecretBox<Vec<u8>>>,
    /// Lease metadata returned by the broker — JWT (opaque to the
    /// daemon today, will be verified by future client code) and the
    /// epoch-second `exp`. Set together with `cleartext`. Surfaced
    /// to the page via /wb/<token>/sealed/whoami in C1.9 / C1.10.
    #[allow(dead_code)]
    lease_jwt: Option<String>,
    #[allow(dead_code)]
    lease_exp: Option<i64>,
    /// Identity claims from the broker exchange. Used for audit log
    /// lines and (later) for surfacing "signed in as …" in the UI.
    #[allow(dead_code)]
    sealed_identity_sub: Option<String>,
    #[allow(dead_code)]
    sealed_identity_email: Option<String>,
}

/// Map of secret-id → list of host patterns the daemon will splice
/// that secret into. `None` (no entry for an id) = no domain
/// restriction (legacy behavior). An entry with an empty domains
/// list = blocked entirely; the secret can still be set/listed but
/// /proxy refuses to use it. Encoded directly from
/// `manifest.secrets` in the workbook's spec script.
#[derive(Clone, Debug, Default)]
struct SecretsPolicy {
    by_id: HashMap<String, Vec<String>>,
}

impl SecretsPolicy {
    /// Returns true if `host` matches any of the patterns declared
    /// for `secret_id`. If the policy doesn't mention this id, the
    /// caller decides whether to allow (legacy) or refuse (strict).
    fn host_allowed_for(&self, secret_id: &str, host: &str) -> Option<bool> {
        let patterns = self.by_id.get(secret_id)?;
        if patterns.is_empty() {
            return Some(false);
        }
        Some(patterns.iter().any(|pat| host_matches(pat, host)))
    }
}

/// Glob-style host match. Rules: exact match for hostnames without
/// `*`. `*.example.com` matches any subdomain (one or more labels)
/// of example.com but NOT bare example.com. We use glob-match for
/// the wildcard cases to avoid hand-rolling label-boundary checks.
fn host_matches(pattern: &str, host: &str) -> bool {
    let pat = pattern.to_ascii_lowercase();
    let h = host.to_ascii_lowercase();
    if !pat.contains('*') {
        return pat == h;
    }
    // glob-match treats `*` as match-anything-including-dots, which
    // would let `*.fal.run` accidentally match `evil.fal.run.attacker`.
    // We anchor the match by requiring the bare suffix to match too.
    if let Some(suffix) = pat.strip_prefix("*.") {
        return h != suffix && h.ends_with(&format!(".{suffix}"));
    }
    glob_match::glob_match(&pat, &h)
}

impl SessionStore {
    fn new(cap: usize) -> Self {
        Self { cap, map: HashMap::new() }
    }

    /// Restore from a previous run's sessions.json (token → path
    /// pairs). Per-session ephemerals (secrets_policy, permissions,
    /// workbook_id, recently_seeded) intentionally start empty —
    /// they get re-populated on the next /wb/<token>/ GET. Sessions
    /// whose underlying file no longer exists are dropped silently.
    fn restore_from_disk(&mut self) -> usize {
        let path = sessions_state_path();
        let Ok(body) = std::fs::read_to_string(&path) else { return 0; };
        let mut count = 0;
        for line in body.lines() {
            let mut parts = line.splitn(2, '\t');
            let (token, file_path) = match (parts.next(), parts.next()) {
                (Some(t), Some(p)) if !t.is_empty() => (t, PathBuf::from(p)),
                _ => continue,
            };
            if !file_path.exists() { continue; }
            self.map.insert(token.to_string(), Session {
                path: file_path,
                last_access: Instant::now(),
                secrets_policy: None,
                permissions: None,
                workbook_id: None,
                recently_seeded: HashMap::new(),
                // Cleartext + lease are deliberately not persisted —
                // sealed-workbook auth state is process-lifetime only.
                // A daemon restart forces re-authentication; C1.9
                // (lease cache) will provide an offline grace window.
                cleartexts: HashMap::new(),
                lease_jwt: None,
                lease_exp: None,
                sealed_identity_sub: None,
                sealed_identity_email: None,
            });
            count += 1;
        }
        count
    }

    /// Persist (token, path) pairs to sessions.json. Called after
    /// every insert so a daemon restart finds the same tokens valid
    /// — kills the "unknown token" surprise on browser refresh.
    /// TSV format because tokens are 32-hex and paths are utf8 paths
    /// without tabs in any sane filesystem; JSON would need escaping.
    fn persist_to_disk(&self) -> Result<(), String> {
        let path = sessions_state_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let mut body = String::with_capacity(self.map.len() * 64);
        for (token, sess) in &self.map {
            body.push_str(token);
            body.push('\t');
            body.push_str(&sess.path.display().to_string());
            body.push('\n');
        }
        let tmp = path.with_extension("tsv.tmp");
        std::fs::write(&tmp, &body).map_err(|e| format!("write tmp: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
        Ok(())
    }

    /// Insert a fresh token. If we're at cap, evict the entry with the
    /// oldest last_access (touch-LRU). Returns the evicted token, if any,
    /// for logging.
    fn insert(&mut self, token: String, path: PathBuf) -> Option<String> {
        let evicted = if self.map.len() >= self.cap {
            self.map
                .iter()
                .min_by_key(|(_, s)| s.last_access)
                .map(|(k, _)| k.clone())
                .and_then(|k| {
                    self.map.remove(&k);
                    Some(k)
                })
        } else {
            None
        };
        self.map.insert(token, Session {
            path,
            last_access: Instant::now(),
            secrets_policy: None,
            permissions: None,
            workbook_id: None,
            recently_seeded: HashMap::new(),
            cleartexts: HashMap::new(),
            lease_jwt: None,
            lease_exp: None,
            sealed_identity_sub: None,
            sealed_identity_email: None,
        });
        if let Err(e) = self.persist_to_disk() {
            eprintln!("[workbooksd] sessions.tsv persist failed: {e}");
        }
        evicted
    }

    /// Insert a token bound to a sealed (studio-v1) workbook. The
    /// `cleartext` is the just-decrypted HTML body — held in memory
    /// for the life of the session and zeroized when the session is
    /// evicted or the daemon shuts down. `lease_jwt` / `lease_exp` /
    /// identity claims come straight from the broker exchange and
    /// are surfaced via the audit log.
    fn insert_sealed(
        &mut self,
        token: String,
        path: PathBuf,
        cleartexts: HashMap<String, secrecy::SecretBox<Vec<u8>>>,
        lease_jwt: String,
        lease_exp: i64,
        identity_sub: String,
        identity_email: String,
    ) -> Option<String> {
        let evicted = if self.map.len() >= self.cap {
            self.map
                .iter()
                .min_by_key(|(_, s)| s.last_access)
                .map(|(k, _)| k.clone())
                .and_then(|k| {
                    self.map.remove(&k);
                    Some(k)
                })
        } else {
            None
        };
        self.map.insert(token, Session {
            path,
            last_access: Instant::now(),
            secrets_policy: None,
            permissions: None,
            workbook_id: None,
            recently_seeded: HashMap::new(),
            cleartexts,
            lease_jwt: Some(lease_jwt),
            lease_exp: Some(lease_exp),
            sealed_identity_sub: Some(identity_sub),
            sealed_identity_email: Some(identity_email),
        });
        // Persist the (token, path) pair as usual. Cleartext + lease
        // are deliberately NOT persisted — they live in memory only.
        // After a daemon restart the token will resolve to the
        // encrypted file on disk; the browser fallback path in the
        // envelope HTML will re-trigger broker auth.
        if let Err(e) = self.persist_to_disk() {
            eprintln!("[workbooksd] sessions.tsv persist failed: {e}");
        }
        evicted
    }

    /// Look up the in-memory cleartext for a specific view of a sealed
    /// workbook token. Returns a fresh SecretBox holding a copy of the
    /// bytes — caller drops it when serve completes and the bytes are
    /// zeroized. None for plaintext workbooks or for view ids the
    /// recipient didn't unlock (caller falls back to disk read or
    /// returns an error).
    pub(crate) fn cleartext_for(
        &mut self,
        token: &str,
        view_id: &str,
    ) -> Option<secrecy::SecretBox<Vec<u8>>> {
        let s = self.map.get_mut(token)?;
        s.last_access = Instant::now();
        let stored = s.cleartexts.get(view_id)?;
        let copy: Vec<u8> = secrecy::ExposeSecret::expose_secret(stored).clone();
        Some(secrecy::SecretBox::new(Box::new(copy)))
    }

    /// Pick the default view to serve when no view id is in the URL.
    /// Priority: explicit "default" if unlocked, then alphabetically
    /// first unlocked view. Returns None when the session has no
    /// cleartexts (plaintext workbook → caller reads from disk).
    pub(crate) fn default_view_id(&mut self, token: &str) -> Option<String> {
        let s = self.map.get_mut(token)?;
        s.last_access = Instant::now();
        if s.cleartexts.contains_key("default") {
            return Some("default".to_string());
        }
        let mut keys: Vec<&String> = s.cleartexts.keys().collect();
        keys.sort();
        keys.first().map(|k| (*k).clone())
    }

    /// List all unlocked view ids for a token, sorted. Used by the
    /// view-picker UI when more than one view is unlocked.
    pub(crate) fn unlocked_views(&mut self, token: &str) -> Vec<String> {
        let Some(s) = self.map.get_mut(token) else {
            return Vec::new();
        };
        s.last_access = Instant::now();
        let mut keys: Vec<String> = s.cleartexts.keys().cloned().collect();
        keys.sort();
        keys
    }

    /// Look up a token's bound path and refresh its last_access stamp.
    /// Returns None if the token isn't known.
    pub(crate) fn touch(&mut self, token: &str) -> Option<PathBuf> {
        self.map.get_mut(token).map(|s| {
            s.last_access = Instant::now();
            s.path.clone()
        })
    }

    /// Look up the per-secret domain policy for this token's
    /// workbook. Returns None when no policy has been parsed yet
    /// (caller falls back to legacy "any HTTPS host allowed"
    /// behavior for that secret).
    fn policy_for(&mut self, token: &str) -> Option<SecretsPolicy> {
        self.map.get_mut(token).and_then(|s| {
            s.last_access = Instant::now();
            s.secrets_policy.clone()
        })
    }

    /// Cache the parsed policy on the session so the next /proxy
    /// hit doesn't re-read + re-parse the file.
    fn set_policy(&mut self, token: &str, policy: SecretsPolicy) {
        if let Some(s) = self.map.get_mut(token) {
            s.secrets_policy = Some(policy);
        }
    }

    /// Cache the parsed permissions block on the session so the
    /// /permissions endpoints don't re-read the file each call.
    pub(crate) fn set_permissions(&mut self, token: &str, perms: permissions::Permissions) {
        if let Some(s) = self.map.get_mut(token) {
            s.permissions = Some(perms);
        }
    }

    pub(crate) fn permissions_for(&mut self, token: &str) -> Option<permissions::Permissions> {
        self.map.get_mut(token).and_then(|s| {
            s.last_access = Instant::now();
            s.permissions.clone()
        })
    }

    pub(crate) fn workbook_id_for(&mut self, token: &str) -> Option<String> {
        self.map.get_mut(token).and_then(|s| {
            s.last_access = Instant::now();
            s.workbook_id.clone()
        })
    }

    pub(crate) fn set_workbook_id(&mut self, token: &str, id: String) {
        if let Some(s) = self.map.get_mut(token) {
            s.workbook_id = Some(id);
        }
    }

    /// Mark a relative scratch path as freshly written by the
    /// daemon (i.e. via /agent/seed). The watcher consults this
    /// inside its event-coalesce loop to skip echo notifications.
    pub(crate) fn mark_seeded(&mut self, token: &str, rel_path: String) {
        if let Some(s) = self.map.get_mut(token) {
            s.recently_seeded.insert(rel_path, Instant::now());
        }
    }

    /// Returns true if the relative path was seeded by the daemon
    /// in the last SEED_ECHO_WINDOW_MS milliseconds. The watcher
    /// uses this to drop echo events without firing the WS frame.
    /// Idempotently expires stale entries during the lookup.
    pub(crate) fn was_recently_seeded(&mut self, token: &str, rel_path: &str) -> bool {
        let Some(s) = self.map.get_mut(token) else { return false; };
        let now = Instant::now();
        // Lazy GC: drop entries older than the echo window so the
        // map doesn't grow unboundedly across long-lived sessions.
        s.recently_seeded.retain(|_, t| {
            now.duration_since(*t).as_millis() < SEED_ECHO_WINDOW_MS as u128
        });
        s.recently_seeded.contains_key(rel_path)
    }
}

/// How long the watcher suppresses echo events for paths the
/// daemon just wrote. Notify-rs on macOS coalesces with FSEvents
/// which can run 100-500ms behind the syscall, so we leave a
/// generous window. The agent's own writes still surface (it's a
/// child process, those go through a different cwd-relative path)
/// — only the daemon's own seed/wb-fetch installs are suppressed.
const SEED_ECHO_WINDOW_MS: u64 = 1000;

// ── entry point ─────────────────────────────────────────────────────

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        None => run_daemon(),
        Some("open") => match args.next() {
            Some(p) => match run_open(PathBuf::from(p)) {
                Ok(()) => {}
                Err(e) => {
                    eprintln!("workbooksd open: {e}");
                    std::process::exit(1);
                }
            },
            None => {
                eprintln!("usage: workbooksd open <path-to-workbook.html>");
                std::process::exit(2);
            }
        },
        Some("stamp") => {
            // workbooksd stamp <path>
            // Writes the com.apple.LaunchServices.OpenWith xattr so
            // the file always opens via Workbooks. Used by the .pkg
            // postinstall to bulk-stamp existing .html files
            // in the user's common locations. Best-effort: missing
            // file or write failure prints to stderr and exits non-zero,
            // but the caller (postinstall) ignores it.
            match args.next() {
                Some(p) => match xattr_openwith::stamp(std::path::Path::new(&p)) {
                    Ok(()) => {}
                    Err(e) => {
                        eprintln!("workbooksd stamp: {e}");
                        std::process::exit(1);
                    }
                },
                None => {
                    eprintln!("usage: workbooksd stamp <path>");
                    std::process::exit(2);
                }
            }
        }
        Some("stamp-if-workbook") => {
            // workbooksd stamp-if-workbook <path>
            // Read the head of <path>, content-sniff for workbook
            // markers (`<meta name="wb-permissions">` or
            // `<script id="wb-meta">`), and stamp the OpenWith xattr
            // if it matches. No-op (and exit 0) for non-workbook
            // files — this is the safe primitive the postinstall
            // uses to walk ~/Downloads/etc and route only the actual
            // workbooks, leaving regular HTML files alone. Returns
            // exit code 0 on hit, 0 on miss, 1 on read error.
            match args.next() {
                Some(p) => {
                    let path = std::path::Path::new(&p);
                    let mut buf = vec![0u8; 16 * 1024];
                    let n = match std::fs::File::open(path)
                        .and_then(|mut f| std::io::Read::read(&mut f, &mut buf))
                    {
                        Ok(n) => n,
                        Err(e) => {
                            eprintln!("workbooksd stamp-if-workbook: read {}: {e}", p);
                            std::process::exit(1);
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..n]);
                    if looks_like_workbook(&head) {
                        if let Err(e) = xattr_openwith::stamp(path) {
                            eprintln!("workbooksd stamp-if-workbook: {e}");
                            std::process::exit(1);
                        }
                        eprintln!("[workbooksd] stamped {p}");
                    }
                }
                None => {
                    eprintln!("usage: workbooksd stamp-if-workbook <path>");
                    std::process::exit(2);
                }
            }
        }
        Some("set-default-handler") => {
            // workbooksd set-default-handler <UTI> <BUNDLE_ID>
            // Used by the .pkg postinstall to make Workbooks the
            // default for public.html. See default_handler.rs.
            let uti = args.next();
            let bid = args.next();
            match (uti, bid) {
                (Some(u), Some(b)) => {
                    let rc = default_handler::set_default_handler(&u, &b);
                    if rc != 0 {
                        eprintln!("LSSetDefaultRoleHandlerForContentType returned {rc}");
                        std::process::exit(1);
                    }
                }
                _ => {
                    eprintln!("usage: workbooksd set-default-handler <UTI> <BUNDLE_ID>");
                    std::process::exit(2);
                }
            }
        }
        Some(other) => {
            eprintln!("unknown subcommand: {other}");
            std::process::exit(2);
        }
    }
}

// ── daemon mode ─────────────────────────────────────────────────────

fn run_daemon() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio");
    rt.block_on(daemon_main());
}

async fn daemon_main() {
    // Acquire the singleton lock before binding anything. We hold this
    // for the lifetime of the daemon — the OS releases it when our fd
    // closes (clean exit, crash, or kill). Belt-and-suspenders with
    // the port bind below; useful when something steals the port or
    // we ever fall back to a different one.
    #[cfg(unix)]
    let _lock = match acquire_lockfile() {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[workbooksd] {e}");
            std::process::exit(1);
        }
    };

    let state = AppState::default();

    // Restore the persisted session map BEFORE binding so the
    // first /wb/<token>/ GET after a restart finds its token.
    // The browser tab kept open across the restart now resolves
    // instead of 404'ing with "unknown token".
    {
        let restored = state.sessions.lock().await.restore_from_disk();
        if restored > 0 {
            eprintln!("[workbooksd] restored {restored} session(s) from sessions.tsv");
        }
    }

    // Permissive CORS for /health AND /open — both are public-facing
    // endpoints that file:// pages need to call. /health is the
    // presence probe; /open is what self-redirecting workbooks POST
    // to ("here's my disk path, give me a daemon URL"). Bound /wb/*
    // routes stay same-origin (page is loaded under the daemon's
    // origin already, no CORS needed).
    //
    // /open from any origin is fine: it only mints a token bound to
    // a path the caller already chose. It never leaks data — the
    // attack surface is "any local process or page can ask the
    // daemon to bind a path" which it could already do via curl.
    let public_router = Router::new()
        .route("/health", get(health))
        .route("/open", post(open_handler))
        .route("/icons/:id", get(icon_handler))
        // Ledger endpoints — read-only summaries used by the Tauri
        // Workbooks Manager (origin tauri://localhost on macOS).
        // Browser CORS would otherwise block the manager from
        // reading the JSON even though require_daemon_origin
        // accepts the request. The handlers themselves still gate
        // on require_daemon_origin for CSRF defense.
        .route("/ledger/list", get(ledger_list_handler))
        .route("/ledger/discover", get(ledger_discover_handler))
        .route("/ledger/:workbook_id", get(ledger_by_id_handler))
        // Author-claim signing (C8.7-A). CLI's `workbook seal --sign`
        // calls these to embed a signed claim into wrapStudio's
        // envelope so recipients see a verified-by-author badge.
        .route("/author/identity", get(author_route::get_identity))
        .route("/author/sign-claim", post(author_route::sign_claim))
        .route("/author/register", post(author_route::register))
        .route("/author/registration", get(author_route::get_registration))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        );

    // Real workbooks ship with the WASM runtime inlined → ~21 MB on disk
    // and growing. axum defaults body cap to 2 MB, which would fail every
    // real save with "length limit exceeded". Bump to 256 MB (matches the
    // sanity cap we used in the C polyglot for the same reason); anything
    // above that is suspect and worth bouncing.
    const SAVE_BODY_LIMIT: usize = 256 * 1024 * 1024;

    let app = Router::new()
        .merge(public_router)
        .route("/wb/:token", get(redirect_to_slash))
        .route("/wb/:token/", get(serve_workbook))
        .route(
            "/wb/:token/save",
            put(save_workbook).layer(DefaultBodyLimit::max(SAVE_BODY_LIMIT)),
        )
        .route("/wb/:token/secret/set", post(secret_set_handler))
        .route("/wb/:token/secret/delete", post(secret_delete_handler))
        .route("/wb/:token/secret/list", get(secret_list_handler))
        .route("/wb/:token/secret/preview/:id", get(secret_preview_handler))
        .route(
            "/wb/:token/proxy",
            post(proxy_handler).layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route("/wb/:token/agent/adapters", get(acp::list_handler))
        .route("/wb/:token/agent/:adapter", get(acp::ws_handler))
        .route(
            "/wb/:token/agent/seed",
            post(acp::seed_handler).layer(DefaultBodyLimit::max(32 * 1024 * 1024)),
        )
        .route("/wb/:token/permissions", get(permissions_list_handler))
        .route("/wb/:token/permissions/approve", post(permissions_approve_handler))
        .route("/wb/:token/permissions/revoke", post(permissions_revoke_handler))
        .route("/wb/:token/ledger", get(ledger_for_token_handler))
        .route("/wb/:token/related", get(related_for_token_handler))
        // /ledger/list and /ledger/:workbook_id moved to the
        // public_router so the Tauri Manager (origin
        // tauri://localhost) gets CORS headers from tower-http.
        .with_state(state);

    // Bind preference order:
    //   1. The previous run's port (from runtime.json) if it's
    //      still free. Keeps URLs in already-open browser tabs
    //      valid across daemon restarts — the tab's URL has the
    //      old port, persisted sessions have the old token, both
    //      now resolve.
    //   2. 127.0.0.1:0 — kernel-assigned ephemeral.
    // The previous port isn't observable to a malicious page
    // (it's filesystem state in ~/Library/Application Support),
    // so re-binding it doesn't reintroduce the predictability
    // issue .17 fixed. Only same-machine processes that can
    // already read runtime.json see it.
    let listener = {
        let mut bound: Option<tokio::net::TcpListener> = None;
        if let Some(prev) = read_runtime_port() {
            let prev_addr: SocketAddr = format!("{BIND_HOST}:{prev}").parse().unwrap();
            if let Ok(l) = tokio::net::TcpListener::bind(prev_addr).await {
                eprintln!("[workbooksd] reusing previous port {prev}");
                bound = Some(l);
            }
        }
        match bound {
            Some(l) => l,
            None => {
                let addr: SocketAddr = format!("{BIND_HOST}:0").parse().unwrap();
                match tokio::net::TcpListener::bind(addr).await {
                    Ok(l) => l,
                    Err(e) => {
                        eprintln!("[workbooksd] cannot bind {addr}: {e}");
                        eprintln!("[workbooksd] is another instance already running?");
                        std::process::exit(1);
                    }
                }
            }
        }
    };
    let bound = listener.local_addr().expect("bound listener has local_addr").port();
    BOUND_PORT.set(bound).expect("BOUND_PORT initialized once");
    if let Err(e) = write_runtime_json(bound) {
        // Non-fatal — the daemon still serves; the helper just
        // can't be discovered out-of-process. Log and proceed.
        eprintln!("[workbooksd] runtime.json write failed: {e}");
    }
    eprintln!("[workbooksd] listening on http://{BIND_HOST}:{bound}");

    // Spawn the downloads watcher AFTER bind so a watcher panic can't
    // prevent the daemon from accepting connections. Best-effort; if
    // it fails to spawn (no resolvable known-folders, FSEvents perm
    // denied, etc.) the daemon still serves — users just lose the
    // auto-stamp magic and have to right-click → Open With → Workbooks
    // the first time for fresh files.
    download_watcher::spawn();

    axum::serve(listener, app).await.expect("serve");
}

/// Write the runtime port + pid to a small JSON file so the
/// `workbooksd open` subcommand and external test harnesses can
/// discover the running daemon. Plays the role of a pid-file +
/// port advertisement; one of the few stable handshake surfaces
/// across daemon restarts. Atomic via tmp+rename.
fn write_runtime_json(port: u16) -> Result<(), String> {
    let dir = runtime_state_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let path = dir.join("runtime.json");
    let body = format!(
        r#"{{"port":{port},"pid":{pid},"host":"{BIND_HOST}"}}"#,
        pid = std::process::id(),
    );
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &body).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

/// Per-user state directory shared by every daemon-side file
/// (runtime.json, approvals.json, ledger.json, signing identity,
/// session log).
///
/// Resolved via `dirs::data_dir`, which honors each OS's convention:
///   macOS:   ~/Library/Application Support/sh.workbooks.workbooksd
///   Linux:   $XDG_DATA_HOME or ~/.local/share/workbooksd
///   Windows: %APPDATA%\workbooksd
///
/// Hardcoding `$HOME` here used to silently break the Windows daemon
/// because Windows doesn't set HOME — only USERPROFILE — so the path
/// fell through to /tmp and then runtime.json never landed where the
/// browser-side code looked. `dirs` reads the right OS-native source.
pub(crate) fn runtime_state_dir() -> PathBuf {
    let mut p = dirs::data_dir().unwrap_or_else(std::env::temp_dir);
    #[cfg(target_os = "macos")]
    { p.push("sh.workbooks.workbooksd"); }
    #[cfg(not(target_os = "macos"))]
    { p.push("workbooksd"); }
    p
}

/// Read the running daemon's port from runtime.json. Used by the
/// `workbooksd open <path>` subcommand and any out-of-process
/// caller that needs the live address. Returns None if the file
/// doesn't exist or doesn't parse — caller surfaces a friendly
/// "is the daemon running?" message.
pub(crate) fn read_runtime_port() -> Option<u16> {
    let path = runtime_state_dir().join("runtime.json");
    let body = std::fs::read_to_string(&path).ok()?;
    // Tiny ad-hoc parser — avoids pulling serde_json in for one
    // integer field. Format is `{"port":N,...}`.
    let after = body.split("\"port\":").nth(1)?;
    let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Path of the persisted session map. Token-keyed TSV (token \t
/// path \n) so a daemon restart can hand back the same URL the
/// browser tab is still showing — kills the "unknown token" error
/// on refresh after a launchd-restart / sleep-wake / log-out cycle.
fn sessions_state_path() -> PathBuf {
    runtime_state_dir().join("sessions.tsv")
}

/// Splice the related-banner script into the served HTML right
/// before `</body>`. Calls /wb/<token>/related at load time; if
/// the daemon reports we're not the latest copy of this workbook,
/// renders a fixed-position card in the top-right with "Stay"
/// and "Jump to latest" actions. CSP already permits inline
/// scripts (`script-src 'self' 'unsafe-inline'`), so no relax.
fn inject_related_banner(html: &str, token: &str) -> String {
    let snippet = format!(
        r#"<style>
.wb-related-banner {{
  position: fixed; top: 16px; right: 16px; z-index: 2147483647;
  max-width: 380px;
  padding: 12px 14px;
  border-radius: 10px;
  background: #fff; color: #0a0a0a;
  font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  box-shadow: 0 6px 24px rgba(0,0,0,.18), 0 1px 3px rgba(0,0,0,.08);
  border: 1px solid rgba(0,0,0,.08);
  display: flex; flex-direction: column; gap: 8px;
}}
@media (prefers-color-scheme: dark) {{
  .wb-related-banner {{ background: #141414; color: #f5f5f5; border-color: rgba(255,255,255,.08); }}
}}
.wb-related-banner .wb-related-title {{ font-weight: 600; font-size: 12px; letter-spacing: 0.02em; }}
.wb-related-banner .wb-related-meta  {{ font-size: 11px; opacity: 0.7; word-break: break-all; }}
.wb-related-banner .wb-related-actions {{ display: flex; gap: 8px; }}
.wb-related-banner button {{
  font: inherit; padding: 5px 10px; border-radius: 6px; cursor: pointer;
  border: 1px solid currentColor; background: transparent; color: inherit;
}}
.wb-related-banner button.primary {{ background: currentColor; color: #fff; }}
@media (prefers-color-scheme: dark) {{
  .wb-related-banner button.primary {{ color: #0a0a0a; }}
}}
</style>
<script>
(async () => {{
  try {{
    const r = await fetch("/wb/{token}/related", {{ cache: "no-store" }});
    if (!r.ok) return;
    const info = await r.json();
    if (!info || !info.behind || info.behind < 1) return;
    if (!info.latest_url) return;
    const dismissedKey = "wb-related-dismissed:" + (info.latest_sha || "");
    if (sessionStorage.getItem(dismissedKey)) return;
    const card = document.createElement("div");
    card.className = "wb-related-banner";
    const title = document.createElement("div");
    title.className = "wb-related-title";
    title.textContent =
      info.behind === 1
        ? "This copy is 1 save behind."
        : "This copy is " + info.behind + " saves behind.";
    const meta = document.createElement("div");
    meta.className = "wb-related-meta";
    const home = (s) => s.replace(/\/Users\/[^\/]+/, "~");
    meta.textContent = "Latest is at " + home(info.latest_path || "");
    const row = document.createElement("div");
    row.className = "wb-related-actions";
    const stay = document.createElement("button");
    stay.textContent = "Stay";
    stay.onclick = () => {{ sessionStorage.setItem(dismissedKey, "1"); card.remove(); }};
    const jump = document.createElement("button");
    jump.className = "primary";
    jump.textContent = "Jump to latest";
    jump.onclick = () => {{ window.location.href = info.latest_url; }};
    row.appendChild(stay); row.appendChild(jump);
    card.appendChild(title); card.appendChild(meta); card.appendChild(row);
    document.body.appendChild(card);
  }} catch {{ /* silent */ }}
}})();
</script>"#
    );
    if let Some(idx) = html.to_ascii_lowercase().rfind("</body>") {
        let mut out = String::with_capacity(html.len() + snippet.len());
        out.push_str(&html[..idx]);
        out.push_str(&snippet);
        out.push_str(&html[idx..]);
        out
    } else {
        format!("{html}{snippet}")
    }
}

/// Page shown when serve_workbook receives a token it doesn't
/// recognize even after the sessions.tsv restore. Most often hit
/// by an old bookmark to a previous machine's workbook URL; the
/// guidance is "open the file again from Finder."
const UNKNOWN_TOKEN_HTML: &str = r#"<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Session expired</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="darkreader-lock">
<style>
:root { color-scheme: light dark; --bg:#fff; --fg:#0a0a0a; --muted:#555; --line:#ececec; --code:#f5f5f5; }
@media (prefers-color-scheme: dark) { :root { --bg:#0a0a0a; --fg:#f5f5f5; --muted:#9a9a9a; --line:#1c1c1c; --code:#141414; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg);
       font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
       line-height:1.55; }
main { max-width:560px; margin:0 auto; padding:6rem 1.5rem; }
h1 { font-size:1.6rem; margin:0 0 0.6rem; letter-spacing:-0.01em; }
p  { color:var(--muted); margin:0 0 1rem; }
code { background:var(--code); padding:0.05rem 0.4rem; border-radius:4px;
       font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:0.92em; color:var(--fg); }
.meta { font-size:0.85rem; color:var(--muted); padding-top:1.5rem; border-top:1px solid var(--line); margin-top:2rem; }
</style></head>
<body><main>
<h1>This session has expired.</h1>
<p>The token in this URL doesn't match any open workbook on this machine.
That usually means the workbook was opened on a different computer, the
daemon's session storage was cleared, or you bookmarked a URL from a
previous run.</p>
<p>To open it again: find the <code>.html</code> file in Finder
and double-click it. The daemon will hand you a fresh URL.</p>
<p class="meta">workbooks daemon · <a href="https://workbooks.sh/" style="color:inherit">workbooks.sh</a></p>
</main></body></html>"#;

// ── handlers ────────────────────────────────────────────────────────

async fn health() -> &'static str {
    "ok"
}

// Icon serving — baked into the binary with include_str! so workbooks
// don't have to inline Claude / Codex / native marks in every shipped
// .html file. Pages reference them as
// `<img src="http://127.0.0.1:47119/icons/claude.svg">` (or the
// corresponding /icons/<id> path). Adds ~7 KB to the daemon binary
// total. Source SVGs in packages/workbooksd/static/icons/.
const ICON_CLAUDE: &str = include_str!("../static/icons/claude.svg");
const ICON_CODEX: &str = include_str!("../static/icons/codex.svg");
const ICON_NATIVE: &str = include_str!("../static/icons/native.svg");

async fn icon_handler(AxPath(id): AxPath<String>) -> impl IntoResponse {
    // Strip optional .svg extension so /icons/claude and
    // /icons/claude.svg both resolve.
    let key = id.trim_end_matches(".svg");
    let body = match key {
        "claude" => ICON_CLAUDE,
        "codex" => ICON_CODEX,
        "native" => ICON_NATIVE,
        _ => return (StatusCode::NOT_FOUND, "unknown icon").into_response(),
    };
    (
        StatusCode::OK,
        [
            ("content-type", "image/svg+xml"),
            // 1-day cache — icons are immutable per daemon version.
            ("cache-control", "public, max-age=86400, immutable"),
        ],
        body,
    )
        .into_response()
}

#[derive(Deserialize, Serialize)]
struct OpenReq {
    path: String,
}
#[derive(Deserialize, Serialize)]
struct OpenResp {
    token: String,
    url: String,
}

async fn open_handler(
    State(state): State<AppState>,
    axum::Json(req): axum::Json<OpenReq>,
) -> impl IntoResponse {
    if let Err(retry_after) = state.open_bucket.lock().await.try_acquire() {
        let secs = retry_after.as_secs().max(1).to_string();
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [("Retry-After", secs)],
            "rate limit; retry shortly\n",
        )
            .into_response();
    }
    let path = match validate_workbook_path(&req.path) {
        Ok(p) => p,
        Err(e) => return (StatusCode::BAD_REQUEST, e).into_response(),
    };
    let token = mint_token();

    // Peek the file to decide plaintext vs sealed. Cheap (a few KB
    // read for the meta tags) but bounded — we only care about the
    // header, not the whole payload, on the detection pass. We still
    // do a full read inside the sealed branch to parse + decrypt.
    let raw = match tokio::fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("read failed: {e}"),
            )
                .into_response();
        }
    };

    if envelope::looks_like_envelope(&raw) {
        match open_sealed(&state, token.clone(), path.clone(), raw).await {
            Ok(()) => {
                let url = format!("http://{BIND_HOST}:{}/wb/{token}/", bound_port());
                return (StatusCode::OK, axum::Json(OpenResp { token, url }))
                    .into_response();
            }
            Err(msg) => {
                return (StatusCode::BAD_GATEWAY, msg).into_response();
            }
        }
    }

    // Plaintext branch: sniff for a workbook marker to confirm this
    // HTML is actually a workbook. Filename used to gate this
    // (`.html`), but macOS Finder duplicates rename to
    // `foo.workbook (1).html` and lose the recognized suffix — so
    // we moved the gate from the name to the content.
    //
    // Two marker shapes are accepted:
    //   - `<script id="wb-meta">` — substrate workbooks built via
    //     packages/workbook-cli (the canonical pipeline).
    //   - `<meta name="wb-permissions">` — portable workbooks
    //     produced by app-specific build pipelines (e.g.
    //     apps/colorwave) that don't use the substrate plugin but
    //     do declare a permissions policy.
    if !looks_like_workbook(&raw) {
        return (
            StatusCode::BAD_REQUEST,
            "not a workbook (no wb-meta or wb-permissions marker \
             found — only HTML files produced by `wb build` or an \
             app workbook pipeline are supported)\n",
        )
            .into_response();
    }

    // macOS-only: stamp the file's OpenWith xattr so future double-clicks
    // route to Workbooks automatically — bypasses Apple's lock on
    // changing the public.html system default. Best-effort: write
    // failure is logged but doesn't block the open. See xattr_openwith.rs.
    if let Err(e) = xattr_openwith::stamp(&path) {
        eprintln!("[workbooksd] OpenWith stamp on {} failed: {e}", path.display());
    }

    let evicted = state.sessions.lock().await.insert(token.clone(), path);
    if let Some(old) = evicted {
        eprintln!("[workbooksd] sessions at cap; evicted oldest token {old}");
    }
    let url = format!("http://{BIND_HOST}:{}/wb/{token}/", bound_port());
    (StatusCode::OK, axum::Json(OpenResp { token, url })).into_response()
}

/// Quick synchronous broker reachability probe — used by the C1.9
/// lease cache to decide whether a within-grace cached lease should
/// serve. Three-second timeout via reqwest's blocking-via-runtime
/// trick: we're already inside an async fn but std::process::id()
/// patterns and the synchronous keyring API mean a sync probe is
/// simplest. Returns true on any 2xx/3xx, false on every error.
fn broker_health_probe_sync(broker_url: &str) -> bool {
    let url = format!("{}/v1/health", broker_url.trim_end_matches('/'));
    // Build a one-shot tokio runtime for the probe — 100ms cost is
    // dwarfed by the network roundtrip and avoids blocking the
    // outer async context's reactor.
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(_) => return false,
    };
    rt.block_on(async {
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()
        {
            Ok(c) => c,
            Err(_) => return false,
        };
        client
            .get(&url)
            .send()
            .await
            .map(|r| r.status().is_success() || r.status().is_redirection())
            .unwrap_or(false)
    })
}

/// Touch ID gate before a cached-lease open (C9.5 + C1.9). On
/// macOS: LocalAuthentication framework prompt with the workbook
/// name as the reason. Returns Err(human-readable) when denied or
/// cancelled — that string bubbles to the CLI / Studio shell.
///
/// On Linux + Windows the local_auth module returns Unsupported;
/// we fail-open in that case and just log. The threat model row
/// 15 fix is macOS-only this iteration; non-mac fixes are a
/// follow-up (polkit on Linux, Win Hello on Windows).
fn local_auth_gate_or_fail(workbook_id: &str) -> Result<(), String> {
    let reason = format!("Open sealed workbook {}", workbook_id);
    match local_auth::prompt(&reason) {
        Ok(local_auth::LocalAuthOutcome::Authorized) => Ok(()),
        Ok(local_auth::LocalAuthOutcome::Cancelled) => {
            Err("local auth cancelled — sealed open denied".to_string())
        }
        Ok(local_auth::LocalAuthOutcome::Unsupported) => {
            // Non-mac: fall through. Logged so an operator sees the
            // decision in tail logs. THREAT_MODEL row 15 is macOS-only
            // this iteration.
            eprintln!(
                "[workbooksd] local auth unsupported on this platform — cached lease served without prompt"
            );
            Ok(())
        }
        Err(e) => Err(format!("local auth error: {e:?}")),
    }
}

/// C1.8 sealed-workbook open path: parse the envelope, drive the
/// broker auth flow, decrypt the cleartext into memory, register a
/// session bound to the cleartext (NOT to the file path's contents).
///
/// All error returns produce a single human-readable string that
/// open_handler bubbles up as a 502 — the CLI's `workbook open` (and
/// the Studio shell-out) display it verbatim.
async fn open_sealed(
    state: &AppState,
    token: String,
    path: PathBuf,
    raw: String,
) -> Result<(), String> {
    let env = envelope::parse(&raw)
        .map_err(|e| format!("envelope parse failed: {e}"))?;

    // Dev override: if WORKBOOKSD_BROKER_OVERRIDE is set, use that
    // instead of the URL embedded in the envelope. Lets a local dev
    // broker serve a fixture sealed against staging/prod without
    // re-sealing the file. Production daemons should never set this.
    let broker_url = std::env::var("WORKBOOKSD_BROKER_OVERRIDE")
        .unwrap_or_else(|_| env.broker_url.clone());
    if broker_url != env.broker_url {
        eprintln!(
            "[workbooksd] broker override: envelope says {} but using {} (dev)",
            env.broker_url, broker_url,
        );
    }

    audit_log(&path, "broker-auth-begin", None, None);

    // C1.9 — try the cached lease first. Fresh hit → skip the broker
    // round-trip entirely. Grace hit → broker is unreachable but the
    // cached lease is within its offline grace window; serve from
    // cache and surface "offline" to the UI. Stale → fall through to
    // a full broker auth flow, then cache the result.
    //
    // Touch ID gate (C9.5) wraps every cached-hit serve. A stolen
    // unlocked laptop can't open content the broker hasn't actively
    // re-released without the user authenticating locally first.
    let cache_outcome = lease_cache::lookup(
        &env.workbook_id,
        &env.policy_hash,
        || {
            // Synchronous quick health probe. Three-second timeout so a
            // dead broker doesn't hang the open. We're already in the
            // expired-window branch; another second to confirm
            // reachability is acceptable UX-wise.
            broker_health_probe_sync(&broker_url)
        },
        lease_cache::DEFAULT_OFFLINE_GRACE_SECONDS,
    );

    let (auth, opened_via): (broker_client::AuthSuccess, &'static str) = match cache_outcome
    {
        lease_cache::CacheOutcome::Fresh(auth) => {
            local_auth_gate_or_fail(&env.workbook_id)?;
            audit_log(&path, "lease-cache-fresh", Some(&auth.sub), Some(&auth.email));
            (auth, "cache-fresh")
        }
        lease_cache::CacheOutcome::Grace(auth) => {
            local_auth_gate_or_fail(&env.workbook_id)?;
            audit_log(
                &path,
                "lease-cache-grace-offline",
                Some(&auth.sub),
                Some(&auth.email),
            );
            eprintln!(
                "[workbooksd] OFFLINE — serving from cached lease for {} (broker unreachable, within grace window)",
                env.workbook_id,
            );
            (auth, "cache-grace")
        }
        lease_cache::CacheOutcome::Stale => {
            let fresh = broker_client::run_flow(
                &broker_url,
                &env.workbook_id,
                &env.policy_hash,
                |url| {
                    spawn_browser(url);
                },
            )
            .await
            .map_err(|e| format!("broker auth: {e}"))?;
            // Persist the fresh lease for the next open. Failure to
            // cache is non-fatal — the workbook is already serveable.
            if let Err(e) = lease_cache::save(&env.workbook_id, &env.policy_hash, &fresh) {
                eprintln!(
                    "[workbooksd] lease cache save failed (non-fatal): {e}"
                );
            }
            (fresh, "broker-fresh")
        }
    };
    eprintln!("[workbooksd] open path: {opened_via}");

    // C2: iterate the unlocked view set. Broker returns one DEK per
    // view the recipient's policy allows. Decrypt each into its own
    // SecretBox; the daemon stores all of them and serves whichever
    // the URL path selects (default is the alphabetically-first
    // unlocked view, or "default" if it's in the set).
    if auth.keys.is_empty() {
        return Err("broker released zero view keys (policy denied all views)".to_string());
    }
    let mut cleartexts: HashMap<String, secrecy::SecretBox<Vec<u8>>> =
        HashMap::with_capacity(auth.keys.len());
    for key in &auth.keys {
        let cleartext = envelope::decrypt_view(&env, &key.view_id, &key.dek)
            .map_err(|e| format!("decrypt failed for view {}: {e}", key.view_id))?;
        cleartexts.insert(key.view_id.clone(), cleartext);
    }
    let unlocked_view_ids: Vec<&str> =
        cleartexts.keys().map(|s| s.as_str()).collect();

    audit_log(
        &path,
        "broker-auth-ok",
        Some(&auth.sub),
        Some(&auth.email),
    );
    eprintln!(
        "[workbooksd] sealed-open ok: {} view{} unlocked ({})",
        cleartexts.len(),
        if cleartexts.len() == 1 { "" } else { "s" },
        unlocked_view_ids.join(", "),
    );

    let evicted = state.sessions.lock().await.insert_sealed(
        token,
        path,
        cleartexts,
        auth.lease_jwt,
        auth.lease_exp,
        auth.sub,
        auth.email,
    );
    if let Some(old) = evicted {
        eprintln!("[workbooksd] sessions at cap; evicted oldest token {old}");
    }
    Ok(())
}

async fn redirect_to_slash(AxPath(token): AxPath<String>) -> Redirect {
    Redirect::permanent(&format!("/wb/{token}/"))
}

async fn serve_workbook(
    State(state): State<AppState>,
    AxPath(token): AxPath<String>,
) -> impl IntoResponse {
    let Some(path) = state.sessions.lock().await.touch(&token) else {
        // Browser-facing GET — render a friendly HTML page instead
        // of the bare "unknown token" string the API endpoints
        // return. This is hit when the user's tab is older than the
        // current sessions.tsv (file moved, daemon storage cleared,
        // or an unrelated workbook's URL pasted into the address
        // bar). Audit-log it so we can tell genuine staleness from
        // restart-recovery cases.
        audit_log(
            std::path::Path::new("(unknown)"),
            "serve-unknown-token",
            Some(&token),
            None,
        );
        return (
            StatusCode::NOT_FOUND,
            [("content-type", "text/html; charset=utf-8")],
            UNKNOWN_TOKEN_HTML,
        )
            .into_response();
    };

    // Sealed-workbook fast path: serve from in-memory cleartext when
    // it's there. The encrypted file on disk stays sealed. C2 multi-
    // view: pick the default view (or alphabetically-first unlocked).
    // /wb/<token>/<view_id>/ explicit selection lands in a follow-up;
    // for now any unlocked view of a multi-view workbook serves at
    // /wb/<token>/. We pull the SecretBox, copy the bytes into a
    // String for response building, and drop the SecretBox so the
    // inner copy zeroizes.
    let sealed_html = {
        let mut s = state.sessions.lock().await;
        match s.default_view_id(&token) {
            Some(view) => s.cleartext_for(&token, &view),
            None => None,
        }
    };
    let html_from_sealed = sealed_html.and_then(|sb| {
        let bytes: Vec<u8> = secrecy::ExposeSecret::expose_secret(&sb).clone();
        String::from_utf8(bytes).ok()
    });

    let html_result: Result<String, std::io::Error> = match html_from_sealed {
        Some(s) => Ok(s),
        None => tokio::fs::read_to_string(&path).await,
    };
    match html_result {
        Ok(html) => {
            // Extract the per-secret domain policy from the workbook's
            // spec script and cache it on the session. /proxy will
            // enforce this for every outbound call. Best-effort: a
            // workbook without a spec / policy stays in legacy mode
            // (any HTTPS host) — Phase 3 may flip that to deny-by-default.
            let policy = parse_secrets_policy(&html);
            let perms = permissions::parse_from_html(&html);
            // Pull workbook_id from wb-meta if present. Drives the
            // workbook_id-keyed permissions/secrets fallback so a
            // copy of the file (macOS rename to "(1)" or a manual
            // duplicate) inherits prior approvals + keychain entries.
            let workbook_id = ledger::workbook_id_from_save_body(html.as_bytes());
            {
                let mut s = state.sessions.lock().await;
                s.set_policy(&token, policy);
                s.set_permissions(&token, perms);
                if let Some(id) = workbook_id {
                    s.set_workbook_id(&token, id);
                }
            }

            audit_log(&path, "serve", None, None);

            // Content-Security-Policy: scoped to what a workbook
            // actually needs — same-origin connect (forces fetch
            // through wb-fetch / daemon proxy), inline scripts
            // allowed (workbooks are bundled into one file),
            // permissive img/media (data: URIs for inlined assets,
            // blob: for runtime), no third-party origins.
            //
            // `connect-src 'self'` is the load-bearing line: any
            // page-side fetch() to an external host is refused by
            // the browser. Combined with daemon-side domain
            // allowlist, the agent has exactly one path out.
            let csp = "\
                default-src 'self' data: blob:; \
                script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; \
                style-src 'self' 'unsafe-inline'; \
                font-src 'self' data:; \
                img-src 'self' data: blob: https:; \
                media-src 'self' data: blob:; \
                worker-src 'self' blob:; \
                frame-src 'self' data: blob:; \
                connect-src 'self'; \
                object-src 'none'; \
                base-uri 'self'; \
                form-action 'self'\
            ";
            // Inject the cross-copy banner script right before
            // </body>. It calls /wb/<token>/related at load time;
            // if the daemon reports we're not the latest copy of
            // this workbook (a duplicate still has prior content),
            // a small fixed-position card surfaces "Stay" and
            // "Jump to latest" actions. Position-fixed + pointer-
            // events scoped, no global CSS — should not collide
            // with workbook layout.
            let injected = inject_related_banner(&html, &token);
            let mut resp = Html(injected).into_response();
            resp.headers_mut()
                .insert("content-security-policy", csp.parse().unwrap());
            // X-Content-Type-Options stops content-type sniffing,
            // which would let an HTML response masquerade as JS.
            resp.headers_mut()
                .insert("x-content-type-options", "nosniff".parse().unwrap());
            // Referrer-Policy keeps the daemon URL (which contains
            // the session token) from leaking to any external host
            // a workbook image / link goes to.
            resp.headers_mut()
                .insert("referrer-policy", "no-referrer".parse().unwrap());
            resp
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("read failed: {e}"))
            .into_response(),
    }
}

async fn save_workbook(
    State(state): State<AppState>,
    AxPath(token): AxPath<String>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(resp) = require_daemon_origin(&headers) {
        return resp;
    }
    let Some(path) = state.sessions.lock().await.touch(&token) else {
        return (StatusCode::NOT_FOUND, "unknown token").into_response();
    };

    // varlock-inspired leak scan: before persisting the file, check
    // that none of THIS workbook's known secret values appear as a
    // substring in the body. Catches the "agent embedded my
    // FAL_API_KEY into composition.html" attack, which the
    // file-as-database substrate makes plausible — composition is
    // user-editable HTML, an LLM can output any string into it,
    // and shared workbook files are public artifacts.
    let session_workbook_id = state.sessions.lock().await.workbook_id_for(&token);
    if let Some(matched_id) = scan_for_known_secrets(&path, session_workbook_id.as_deref(), &body) {
        let msg = format!(
            "save refused: workbook content contains the value of secret '{matched_id}'. \
             Remove that string from the workbook before saving (or rotate the key in \
             File → Integrations).\n"
        );
        audit_log(&path, "save-refused-leak", Some(&matched_id), None);
        return (StatusCode::CONFLICT, msg).into_response();
    }

    // Append an entry to the in-file edit log (`<script id=
    // "wb-edit-log">`) BEFORE we hash + record. The log is part of
    // the file's authenticity story and should be reflected in the
    // sha256 we persist, otherwise the ledger and the file would
    // disagree about "this is the bytes I last saved." Daemon-side
    // rewrite means the page can't lie about which agent saved.
    let agent = edit_log::normalize_agent(
        headers.get("x-wb-agent").and_then(|v| v.to_str().ok()),
    );
    let final_body: Vec<u8> = if ledger::workbook_id_from_save_body(&body).is_some() {
        use sha2::{Digest, Sha256};
        // Hash the INCOMING body (sans new entry) and use that as the
        // entry's sha256_after — i.e. "this is the snapshot the
        // agent intended to commit." Stable across the rewrite.
        let pre_hash = hex::encode(Sha256::digest(&body));
        let entry = edit_log::Entry {
            ts: chrono_ish_iso8601(),
            agent: agent.clone(),
            sha256_after: pre_hash,
            size_after: body.len() as u64,
        };
        // Source the prior log from the on-disk file rather than
        // trusting whatever the page sent. Tamper-evident: a page
        // (or a pretend-page) can't drop entries it didn't author
        // by omitting the script block. Disk-read fail (first save
        // / missing file) → empty prior, normal first-save behavior.
        let prior = match tokio::fs::read(&path).await {
            Ok(disk) => edit_log::parse_existing(&disk),
            Err(_) => Vec::new(),
        };
        edit_log::rewrite_with_log(&body, prior, entry)
    } else {
        body.to_vec()
    };

    // Record in the per-machine ledger BEFORE the atomic_write so a
    // failed write is reflected in the audit trail (we can sweep
    // dangling entries if the failure rate ever shows up). Pull
    // workbook_id from the rewritten body's wb-meta; cache on the
    // session for subsequent /ledger queries.
    if let Some(id) = ledger::workbook_id_from_save_body(&final_body) {
        use sha2::{Digest, Sha256};
        let sha = hex::encode(Sha256::digest(&final_body));
        if let Err(e) = ledger::record_save(&id, &path, &sha, final_body.len() as u64, Some(&agent)) {
            eprintln!("[workbooksd] ledger record failed: {e}");
        }
        state.sessions.lock().await.set_workbook_id(&token, id);
    }

    if let Err(e) = atomic_write(&path, &final_body).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response();
    }
    eprintln!(
        "[workbooksd] saved {} ({} bytes, agent={})",
        path.display(),
        final_body.len(),
        agent,
    );
    audit_log(&path, "save", Some(&agent), None);

    // Stamp the OpenWith xattr so this file routes back to Workbooks
    // on its next double-click — even though atomic_write replaced the
    // inode (rename-over-tempfile pattern). Without re-stamping after
    // each write, the user's first save would erase the routing they
    // got from the postinstall bulk-stamp or from /open. Best-effort.
    if let Err(e) = xattr_openwith::stamp(&path) {
        eprintln!("[workbooksd] OpenWith stamp on {} failed: {e}", path.display());
    }

    // C2PA sidecar — opt-in via the `c2pa` permission. Runs AFTER
    // the atomic write so the sidecar's content_sha256 assertion
    // matches the bytes actually on disk. Failures here don't
    // refuse the save (the file is already written and the agent
    // shouldn't be punished for a signing problem); we audit-log
    // and move on. The user sees the sidecar appear next to the
    // file when it succeeds.
    if check_permission(&state, &token, "c2pa").await {
        if let Some(workbook_id) = ledger::workbook_id_from_save_body(&final_body) {
            let entries = edit_log::parse_existing(&final_body);
            let path_clone = path.clone();
            let body_clone = final_body.clone();
            // sign_sidecar does file IO + ed25519 work; offload to
            // blocking so we don't park the tokio runtime on it.
            let res = tokio::task::spawn_blocking(move || {
                c2pa_sign::sign_sidecar(&path_clone, &body_clone, &workbook_id, &entries)
            }).await;
            match res {
                Ok(Ok(sidecar)) => {
                    eprintln!("[workbooksd] c2pa sidecar → {}", sidecar.display());
                    audit_log(&path, "c2pa-sign", None, None);
                }
                Ok(Err(e)) => {
                    eprintln!("[workbooksd] c2pa sign failed: {e}");
                    audit_log(&path, "c2pa-sign-failed", Some(&e), None);
                }
                Err(e) => {
                    eprintln!("[workbooksd] c2pa sign panicked: {e}");
                }
            }
        }
    }

    (StatusCode::OK, "saved").into_response()
}

/// Refuse any /wb/<token>/* request that isn't from the daemon's
/// own origin. Defends against:
///   - Token leak via Referer (a workbook navigates the user to
///     evil.com; evil.com knows the token but Origin won't match).
///   - CSRF: a malicious site that somehow learned a token can't
///     forge save / secret / proxy requests.
/// Browsers always send Origin on POST/PUT/DELETE; for GET we get
/// it on cross-origin fetch but not on top-level navigation, which
/// is fine because /wb/<token>/ (the document load) is the entry
/// point, not the attack surface.
pub(crate) fn require_daemon_origin(headers: &HeaderMap) -> Result<(), Response> {
    let expected = format!("http://{BIND_HOST}:{}", bound_port());
    match headers.get("origin").and_then(|v| v.to_str().ok()) {
        Some(o) if o == expected => Ok(()),
        // Tauri webviews load from `tauri://localhost` (macOS) or
        // `https://tauri.localhost` (Windows). The Workbooks
        // Manager runs in one of those contexts and is a trusted
        // local app — same-machine binding (127.0.0.1) is the
        // primary boundary; this is the secondary CSRF check.
        Some(o) if o.starts_with("tauri://")
                || o.starts_with("https://tauri.localhost") => Ok(()),
        // No Origin = same-origin GET / programmatic fetch with
        // mode:"same-origin"; permissible.
        None => Ok(()),
        Some(other) => Err((
            StatusCode::FORBIDDEN,
            format!("origin {other:?} not allowed; expected {expected:?}"),
        )
            .into_response()),
    }
}

/// Parse the workbook's secrets policy from the served HTML. Two
/// sources, in priority order:
///
///   1. `<meta name="wb-secrets-policy" content="<base64-json>">` in
///      the outer shell — emitted by the cli AND hoisted out of the
///      compression sandwich by compress.mjs's extractHeadEssentials.
///      This is the canonical source for production builds (which
///      compress everything else).
///
///   2. `<script id="workbook-spec" type="application/json">{...}</script>`
///      with `manifest.secrets` — the dev-mode / uncompressed shape.
///      Falls back to this if no meta tag is found.
///
/// Returns an empty policy when neither source exists or both are
/// malformed; caller treats that as "legacy workbook, no policy
/// declared" and accepts any HTTPS host (transitional behavior;
/// future versions may flip to deny-by-default).
fn parse_secrets_policy(html: &str) -> SecretsPolicy {
    if let Some(p) = parse_policy_from_meta(html) {
        return p;
    }
    parse_policy_from_spec_script(html).unwrap_or_default()
}

fn parse_policy_from_meta(html: &str) -> Option<SecretsPolicy> {
    // Match either content="..." or content='...'. The meta tag is
    // small, attribute-safe, and (per compress.mjs) lives in the
    // outer shell where we can grep it without decompressing.
    let needle = r#"<meta name="wb-secrets-policy" content="#;
    let start = html.find(needle)?;
    let after = start + needle.len();
    let quote = html.as_bytes().get(after).copied()?;
    if quote != b'"' && quote != b'\'' {
        return None;
    }
    let value_start = after + 1;
    let close = html[value_start..].find(quote as char)?;
    let b64 = &html[value_start..value_start + close];
    let bytes = decode_base64(b64).ok()?;
    let json = std::str::from_utf8(&bytes).ok()?;
    let map: HashMap<String, serde_json::Value> = serde_json::from_str(json).ok()?;
    let by_id = map
        .into_iter()
        .map(|(id, decl)| {
            let domains = decl
                .get("domains")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            (id, domains)
        })
        .collect();
    Some(SecretsPolicy { by_id })
}

fn parse_policy_from_spec_script(html: &str) -> Option<SecretsPolicy> {
    let start = html.find(r#"<script id="workbook-spec""#)?;
    let after_open = html[start..].find('>').map(|i| start + i + 1)?;
    let rel_close = html[after_open..].find("</script>")?;
    let json = &html[after_open..after_open + rel_close];
    let parsed: serde_json::Value = serde_json::from_str(json).ok()?;
    let map = parsed
        .pointer("/manifest/secrets")
        .and_then(|v| v.as_object())?;
    let mut by_id = HashMap::new();
    for (id, decl) in map {
        let domains: Vec<String> = decl
            .get("domains")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        by_id.insert(id.clone(), domains);
    }
    Some(SecretsPolicy { by_id })
}

/// Scan `body` for any of THIS workbook's secret values. Returns
/// the offending secret id on hit, or None on miss. Cheap O(n*k)
/// substring search is fine for typical workbook sizes (≤ 50 MB)
/// and small key counts (≤ ~10 per workbook); upgrade to
/// Aho-Corasick if the cost ever shows up in profiles. We zeroize
/// the secret value buffers immediately after the scan via Drop on
/// SecretString.
fn scan_for_known_secrets(path: &Path, workbook_id: Option<&str>, body: &[u8]) -> Option<String> {
    let ids = read_secret_index(path, workbook_id).ok()?;
    for id in ids {
        if id == SECRET_INDEX_ID {
            continue;
        }
        let value = match keychain_get(path, workbook_id, &id) {
            Ok(Some(v)) => SecretString::new(v.into()),
            _ => continue,
        };
        // Skip absurdly short "secrets" that would false-positive
        // (e.g. a 4-char token would match too many strings).
        if value.expose_secret().len() < 8 {
            continue;
        }
        if memmem(body, value.expose_secret().as_bytes()) {
            return Some(id);
        }
        // Secret drops here, zeroizing.
    }
    None
}

/// Tiny memchr-based needle search. Avoids pulling memchr crate
/// just for this.
fn memmem(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    let last = haystack.len() - needle.len();
    for i in 0..=last {
        if &haystack[i..i + needle.len()] == needle {
            return true;
        }
    }
    false
}

/// Append a single line to ~/Library/Logs/workbooksd-audit.log
/// (or platform equivalent). One line per security-relevant action:
/// session bind, secret write, secret delete, proxy call, save
/// refused. Format: ISO8601 + path + action + optional secret-id +
/// optional host. Never includes secret values.
///
/// Best-effort: if the log dir is missing or unwritable, we eat the
/// error rather than fail the request. Fire-and-forget — no
/// awaiting from the request handler hot path.
fn audit_log(path: &Path, action: &str, secret_id: Option<&str>, host: Option<&str>) {
    let line = format!(
        "{} path={} action={} secret={} host={}\n",
        chrono_ish_iso8601(),
        shell_escape(&path.display().to_string()),
        action,
        secret_id.unwrap_or("-"),
        host.unwrap_or("-"),
    );
    let log_path = audit_log_path();
    std::thread::spawn(move || {
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            use std::io::Write;
            let _ = f.write_all(line.as_bytes());
        }
    });
}

fn audit_log_path() -> PathBuf {
    // Per-OS log location:
    //   macOS:   ~/Library/Logs/workbooksd-audit.log
    //   Linux:   share state dir (~/.local/share/workbooksd/...)
    //   Windows: %LOCALAPPDATA%\workbooksd\Logs\workbooksd-audit.log
    #[cfg(target_os = "macos")]
    {
        let mut p = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
        p.push("Library/Logs");
        p.push("workbooksd-audit.log");
        p
    }
    #[cfg(target_os = "linux")]
    { runtime_state_dir().join("workbooksd-audit.log") }
    #[cfg(target_os = "windows")]
    {
        let mut p = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
        p.push("workbooksd");
        p.push("Logs");
        p.push("workbooksd-audit.log");
        p
    }
}

/// chrono-free ISO8601 without subseconds — enough for an audit log.
fn chrono_ish_iso8601() -> String {
    use std::time::SystemTime;
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Convert UNIX seconds to UTC components without external deps.
    let days = (secs / 86400) as i64;
    let s = (secs % 86400) as u32;
    let (h, m, sec) = (s / 3600, (s % 3600) / 60, s % 60);
    let (y, mo, d) = ymd_from_days(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{sec:02}Z")
}

/// Days since 1970-01-01 → (year, month, day) in proleptic Gregorian.
/// Algorithm: Howard Hinnant's date library, public domain.
fn ymd_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i32) + (era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Quote a path for the audit log so a path with spaces / quotes
/// doesn't break field separation.
fn shell_escape(s: &str) -> String {
    if s.bytes().all(|b| b.is_ascii_alphanumeric() || b"/-_.".contains(&b)) {
        s.to_string()
    } else {
        format!("{:?}", s)
    }
}

// ── singleton lock file ─────────────────────────────────────────────

#[cfg(unix)]
fn lockfile_path() -> PathBuf {
    // Linux: prefer $XDG_RUNTIME_DIR (volatile per-user runtime dir) so
    // the lock disappears at logout and we don't carry stale lockfiles
    // across reboots.
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        return PathBuf::from(dir).join("workbooksd.lock");
    }
    // Otherwise the OS cache dir:
    //   macOS:   ~/Library/Caches/sh.workbooks.workbooksd/lock
    //   Linux:   ~/.cache/workbooksd/lock
    //   Windows: %LOCALAPPDATA%\workbooksd\lock
    let mut p = dirs::cache_dir().unwrap_or_else(std::env::temp_dir);
    #[cfg(target_os = "macos")]
    { p.push("sh.workbooks.workbooksd"); }
    #[cfg(not(target_os = "macos"))]
    { p.push("workbooksd"); }
    p.push("lock");
    p
}

#[cfg(unix)]
fn acquire_lockfile() -> Result<std::fs::File, String> {
    use std::io::{Read, Seek, Write};
    use std::os::unix::io::AsRawFd;

    let path = lockfile_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    // Two-pass acquire so launchd's respawn-on-crash actually works:
    //
    // Pass 1 — try flock. If it succeeds, we're golden.
    // Pass 2 — if flock failed, the lock could be:
    //   (a) genuinely held by another live workbooksd (good — bail)
    //   (b) inherited by a now-dead child of a prior workbooksd
    //       (bad — kernel keeps the lock alive on the inherited fd
    //       even after the original daemon died, so the LaunchAgent's
    //       respawn loop hits it forever and the daemon never recovers)
    //   (c) PID file content points at a process that no longer exists
    //       (bad — same scenario, just visible via the recorded PID)
    //
    // For (b) and (c) we walk through the on-disk PID, do a kill(0)
    // existence check, and if the recorded owner is dead we delete the
    // lockfile and retry. This breaks the stale-lock respawn loop that
    // killed the "daemon is forever" guarantee in 0.3.x.
    //
    // FD_CLOEXEC also prevents future occurrences: any child we spawn
    // (e.g. via `workbooksd open`'s self-respawn or the manager's
    // sidecar lifecycle) won't inherit the lock fd, so killing the
    // parent fully releases the lock.
    fn try_open_and_lock(path: &Path) -> std::io::Result<(std::fs::File, i32)> {
        let f = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        // FD_CLOEXEC — see comment above. SAFETY: fcntl with F_SETFD is
        // a thread-safe POSIX call; we pass a valid fd we just opened.
        unsafe {
            let flags = libc::fcntl(f.as_raw_fd(), libc::F_GETFD);
            if flags >= 0 {
                libc::fcntl(f.as_raw_fd(), libc::F_SETFD, flags | libc::FD_CLOEXEC);
            }
        }
        let rc = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        Ok((f, rc))
    }

    let (mut f, rc) = try_open_and_lock(&path).map_err(|e| {
        format!("open lockfile {}: {e}", path.display())
    })?;

    if rc == 0 {
        f.set_len(0).ok();
        f.seek(std::io::SeekFrom::Start(0)).ok();
        let _ = writeln!(f, "{}", std::process::id());
        f.flush().ok();
        return Ok(f);
    }

    // flock failed — read recorded PID and check if alive.
    let mut existing = String::new();
    let _ = f.read_to_string(&mut existing);
    let pid_str = existing.trim();
    let recorded_pid: Option<i32> = pid_str.parse().ok();

    let alive = match recorded_pid {
        Some(p) if p > 0 => {
            // kill(pid, 0) returns 0 if the process exists and we have
            // permission to signal it. ESRCH = process gone (stale lock).
            // Other errors (EPERM, etc.) we treat as alive — better to
            // refuse than to corrupt a real running daemon's session.
            let rc = unsafe { libc::kill(p, 0) };
            if rc == 0 {
                true
            } else {
                let err = std::io::Error::last_os_error();
                err.raw_os_error() != Some(libc::ESRCH)
            }
        }
        _ => false, // empty or malformed PID file → treat as stale
    };

    if alive {
        return Err(format!(
            "another workbooksd is already running (lock: {}, pid: {})",
            path.display(),
            if pid_str.is_empty() { "?" } else { pid_str }
        ));
    }

    // Stale lock — drop our (now redundant) handle, remove the file,
    // and retry the open+flock once. If THIS attempt also fails to
    // lock, something has raced us in to acquire it; treat as a real
    // contender and bail.
    drop(f);
    let _ = std::fs::remove_file(&path);
    eprintln!(
        "[workbooksd] cleared stale lock (recorded pid {} no longer exists)",
        if pid_str.is_empty() { "<empty>" } else { pid_str }
    );
    let (mut f2, rc2) = try_open_and_lock(&path).map_err(|e| {
        format!("reopen lockfile {}: {e}", path.display())
    })?;
    if rc2 != 0 {
        return Err(format!(
            "lost race acquiring lock {} after clearing stale entry",
            path.display()
        ));
    }
    f2.set_len(0).ok();
    f2.seek(std::io::SeekFrom::Start(0)).ok();
    let _ = writeln!(f2, "{}", std::process::id());
    f2.flush().ok();
    Ok(f2)
}

// ── permissions ──────────────────────────────────────────────────

async fn permissions_list_handler(
    State(state): State<AppState>,
    AxPath(token): AxPath<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(resp) = require_daemon_origin(&headers) {
        return resp;
    }
    let path = match path_for_token(&state, &token).await {
        Some(p) => p,
        None => return (StatusCode::NOT_FOUND, "unknown token").into_response(),
    };
    let (perms, wid) = {
        let mut s = state.sessions.lock().await;
        (s.permissions_for(&token).unwrap_or_default(), s.workbook_id_for(&token))
    };
    let listing = permissions::list_for(&path, wid.as_deref(), &perms);
    (StatusCode::OK, axum::Json(listing)).into_response()
}

async fn permissions_approve_handler(
    State(state): State<AppState>,
    AxPath(token): AxPath<String>,
    headers: HeaderMap,
    axum::Json(req): axum::Json<permissions::ApproveReq>,
) -> impl IntoResponse {
    if let Err(resp) = require_daemon_origin(&headers) {
        return resp;
    }
    let path = match path_for_token(&state, &token).await {
        Some(p) => p,
        None => return (StatusCode::NOT_FOUND, "unknown token").into_response(),
    };
    let (perms, wid) = {
        let mut s = state.sessions.lock().await;
        (s.permissions_for(&token).unwrap_or_default(), s.workbook_id_for(&token))
    };
    match permissions::approve(&path, wid.as_deref(), &perms, &req.ids) {
        Ok(listing) => {
            audit_log(&path, "permissions-approve", None, None);
            (StatusCode::OK, axum::Json(listing)).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

async fn permissions_revoke_handler(
    State(state): State<AppState>,
    AxPath(token): AxPath<String>,
    headers: HeaderMap,
    axum::Json(req): axum::Json<permissions::ApproveReq>,
) -> impl IntoResponse {
    if let Err(resp) = require_daemon_origin(&headers) {
        return resp;
    }
    let path = match path_for_token(&state, &token).await {
        Some(p) => p,
        None => return (StatusCode::NOT_FOUND, "unknown token").into_response(),
    };
    let (perms, wid) = {
        let mut s = state.sessions.lock().await;
        (s.permissions_for(&token).unwrap_or_default(), s.workbook_id_for(&token))
    };
    match permissions::revoke(&path, wid.as_deref(), &perms, &req.ids) {
        Ok(listing) => {
            audit_log(&path, "permissions-revoke", None, None);
            (StatusCode::OK, axum::Json(listing)).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// ── ledger ────────────────────────────────────────────────────────
//
// Two reads, both localhost-only (require_daemon_origin). The
// `/wb/:token/ledger` form is the typical one: the page that's
// open already has the token, ask the daemon "what's the history
// of THIS workbook." `/ledger/:workbook_id` is the portal/dev tool
// path — given an explicit id, dump its history. There's no cross-
// machine sync, no auth secret beyond the localhost binding; if
// you can hit 127.0.0.1:port you're already on the user's machine.

async fn ledger_for_token_handler(
    State(state): State<AppState>,
    AxPath(token): AxPath<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(resp) = require_daemon_origin(&headers) {
        return resp;
    }
    let path = match path_for_token(&state, &token).await {
        Some(p) => p,
        None => return (StatusCode::NOT_FOUND, "unknown token").into_response(),
    };
    // Prefer the cached id (set on the session at first save). Fall
    // back to parsing the file currently on disk so a freshly-opened
    // workbook can answer `/ledger` without waiting for a save.
    let mut id = state.sessions.lock().await.workbook_id_for(&token);
    if id.is_none() {
        if let Ok(bytes) = tokio::fs::read(&path).await {
            id = ledger::workbook_id_from_save_body(&bytes);
            if let Some(ref hit) = id {
                state.sessions.lock().await.set_workbook_id(&token, hit.clone());
            }
        }
    }
    let Some(id) = id else {
        return (StatusCode::OK, axum::Json(serde_json::json!({"history": null}))).into_response();
    };
    let history = ledger::for_workbook(&id);
    (StatusCode::OK, axum::Json(serde_json::json!({"history": history}))).into_response()
}

/// GET /ledger/list — every workbook the ledger knows about, with
/// thin summary fields suitable for an index/list view. Drops the
/// per-save details (use /ledger/<id> for the full history). Sorted
/// most-recently-saved first. Used by the Workbooks Manager's
/// home screen.
async fn ledger_list_handler(headers: HeaderMap) -> impl IntoResponse {
    if let Err(resp) = require_daemon_origin(&headers) {
        return resp;
    }
    let workbooks = ledger::list_summaries();
    (
        StatusCode::OK,
        axum::Json(serde_json::json!({ "workbooks": workbooks })),
    )
        .into_response()
}

/// Spotlight-backed full-disk discovery — lists EVERY workbook file
/// indexed by macOS's metadata server, regardless of whether the
/// daemon's ever served it. Lets the manager surface workbooks the
/// user has on disk but hasn't opened through Workbooks yet.
///
/// Output: { "workbooks": [{ path, size, modified, workbook_id, stamped }] }
/// Sorted modified-desc. Cached daemon-side for ~30 seconds so a
/// rapidly-refreshing manager doesn't fork mdfind 10x/sec.
///
/// macOS-only. Linux/Windows return an empty list (could fill via
/// Tracker / Windows Search Index in a follow-up).
async fn ledger_discover_handler(headers: HeaderMap) -> impl IntoResponse {
    if let Err(resp) = require_daemon_origin(&headers) {
        return resp;
    }
    // Run the (potentially seconds-long) mdfind on a blocking thread
    // so the axum runtime stays responsive.
    let workbooks = tokio::task::spawn_blocking(spotlight_discover::discover)
        .await
        .unwrap_or_default();
    (
        StatusCode::OK,
        axum::Json(serde_json::json!({ "workbooks": workbooks })),
    )
        .into_response()
}

async fn ledger_by_id_handler(
    AxPath(workbook_id): AxPath<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(resp) = require_daemon_origin(&headers) {
        return resp;
    }
    let history = ledger::for_workbook(&workbook_id);
    (StatusCode::OK, axum::Json(serde_json::json!({"history": history}))).into_response()
}

/// "Where is this workbook in its history?" — the data the in-page
/// banner uses to render "you're N saves behind, latest is at <path>"
/// when the user opens an out-of-date copy of a workbook (typically
/// via macOS' "(1) (2)" duplicate-naming).
///
/// Response shape (all fields optional, missing on the no-info case):
///   {
///     "current_path":    "/Users/.../foo (1).html",
///     "current_sha":     "<sha256 of file as it sits on disk>",
///     "behind":          2,                     // saves newer than current_sha
///     "latest_path":     "/Users/.../foo.html",
///     "latest_sha":      "<sha256>",
///     "latest_url":      "http://127.0.0.1:<port>/wb/<token>/",
///     "paths_seen":      [...]                  // every path this id has used
///   }
///
/// Conservative defaults — workbooks without wb-meta or with no
/// ledger history return `{"behind": 0}` and the banner stays
/// hidden.
async fn related_for_token_handler(
    State(state): State<AppState>,
    AxPath(token): AxPath<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(resp) = require_daemon_origin(&headers) {
        return resp;
    }
    let path = match path_for_token(&state, &token).await {
        Some(p) => p,
        None => return (StatusCode::NOT_FOUND, "unknown token").into_response(),
    };
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(_) => {
            return (StatusCode::OK, axum::Json(serde_json::json!({"behind": 0})))
                .into_response();
        }
    };

    // Resolve workbook_id — session cache first, fall back to a
    // wb-meta parse so a workbook that hasn't been saved yet still
    // gets nothing wrong instead of a stale ledger lookup.
    let mut wid = state.sessions.lock().await.workbook_id_for(&token);
    if wid.is_none() {
        wid = ledger::workbook_id_from_save_body(&bytes);
        if let Some(ref hit) = wid {
            state.sessions.lock().await.set_workbook_id(&token, hit.clone());
        }
    }
    let Some(wid) = wid else {
        return (StatusCode::OK, axum::Json(serde_json::json!({"behind": 0})))
            .into_response();
    };

    let Some(history) = ledger::for_workbook(&wid) else {
        return (StatusCode::OK, axum::Json(serde_json::json!({"behind": 0})))
            .into_response();
    };

    use sha2::{Digest, Sha256};
    let current_sha = hex::encode(Sha256::digest(&bytes));
    let saves = &history.saves;
    if saves.is_empty() {
        return (StatusCode::OK, axum::Json(serde_json::json!({"behind": 0})))
            .into_response();
    }
    // Find LAST occurrence of the current sha so we get the most
    // recent matching save when content has been written + reverted.
    let pos = saves
        .iter()
        .rposition(|e| e.file_sha256 == current_sha);
    let total = saves.len();
    let behind = match pos {
        Some(i) => total - i - 1,                 // saves after this one
        None => total,                            // never seen this content
    };
    let latest = saves.last().unwrap();           // saves non-empty per check above

    // Pre-mint a session URL for the latest path so the banner's
    // "Jump to latest" button is just window.location.href = ...
    // No-op if latest_path == current_path (same file).
    let mut latest_url: Option<String> = None;
    if latest.file_path != path.display().to_string()
        && std::path::Path::new(&latest.file_path).exists()
    {
        let new_token = mint_token();
        let evicted = state
            .sessions
            .lock()
            .await
            .insert(new_token.clone(), PathBuf::from(&latest.file_path));
        if let Some(old) = evicted {
            eprintln!("[workbooksd] sessions at cap; evicted {old} during /related premint");
        }
        latest_url = Some(format!(
            "http://{BIND_HOST}:{}/wb/{new_token}/",
            bound_port(),
        ));
    }

    (
        StatusCode::OK,
        axum::Json(serde_json::json!({
            "current_path": path.display().to_string(),
            "current_sha":  current_sha,
            "behind":       behind,
            "latest_path":  latest.file_path,
            "latest_sha":   latest.file_sha256,
            "latest_url":   latest_url,
            "paths_seen":   history.paths_seen,
        })),
    )
        .into_response()
}

/// Helper used by acp.rs: returns true if `id` is allowed for the
/// given session token. Looks up the session's bound path + parsed
/// permissions, calls into `permissions::is_allowed`.
pub(crate) async fn check_permission(state: &AppState, token: &str, id: &str) -> bool {
    let mut s = state.sessions.lock().await;
    let Some(perms) = s.permissions_for(token) else { return true; };
    let Some(path) = s.touch(token) else { return false; };
    let workbook_id = s.workbook_id_for(token);
    drop(s);
    permissions::is_allowed(id, &path, workbook_id.as_deref(), &perms)
}

/// HTTP handler shorthand: resolve `token` to a path AND verify
/// the workbook has been granted permission `id`. On success returns
/// the resolved path; on failure returns the 404/403 response the
/// handler should bubble up unchanged. Centralizes the deny audit
/// log so every gated endpoint reports refusals consistently.
async fn require_perm(state: &AppState, token: &str, id: &str) -> Result<PathBuf, Response> {
    let path = path_for_token(state, token).await
        .ok_or_else(|| (StatusCode::NOT_FOUND, "unknown token").into_response())?;
    if !check_permission(state, token, id).await {
        audit_log(&path, "permission-denied", Some(id), None);
        return Err((
            StatusCode::FORBIDDEN,
            format!(
                "this workbook hasn't been granted '{id}' permission. \
                 Approve it in the permissions dialog before retrying.\n"
            ),
        )
            .into_response());
    }
    Ok(path)
}

// ── secrets (OS keychain) ──────────────────────────────────────────
//
// Keys are stored as `(service, account)` in the platform keychain.
// Service is fixed; account encodes WHICH workbook + WHICH secret:
//
//   service = "sh.workbooks.workbooksd"
//   account = "<short hash of canonical workbook path>:<secret-id>"
//
// Hashing the path keeps the account string short, ASCII, and stable
// across daemon restarts — but means the secret is bound to the file
// at that path. Move the file → secrets are abandoned (still in the
// keychain under the old hash; user can clear via Keychain Access).
// We accept that for v1; a "rebind on path change" UX is a polish
// follow-up. The CRITICAL property: a token minted for path P can
// only access secrets stored under hash(P), so a malicious workbook
// at path Q can never read P's keys via /secret/list or /proxy.

const KEYCHAIN_SERVICE: &str = "sh.workbooks.workbooksd";

fn path_fingerprint(path: &Path) -> String {
    // Must be deterministic across daemon restarts: the keychain
    // account name is `<fingerprint>:<secret_id>`, so a fingerprint
    // that drifts between runs orphans every stored secret on every
    // LaunchAgent respawn. Earlier versions used DefaultHasher,
    // which is seeded with per-process random keys (Rust's HashDoS
    // mitigation) and so was NOT deterministic — every restart
    // produced fresh hashes and silently abandoned the user's
    // keychain entries.
    //
    // SHA-256 truncated to 16 hex chars matches the prior format
    // width while being content-deterministic. We use sha2 already
    // pulled in for the ledger; the truncation costs us collision
    // resistance vs. the full digest, but for the ~thousands of
    // paths a single user has it's negligible.
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(path.to_string_lossy().as_bytes());
    let full = format!("{:x}", h.finalize());
    full.chars().take(16).collect()
}

/// Path-keyed keychain account name. Used for back-compat reads
/// of pre-0.1.4 entries and as the fallback when no workbook_id
/// is known yet (brand-new workbook before its first save).
fn keychain_account(path: &Path, secret_id: &str) -> String {
    format!("{}:{}", path_fingerprint(path), secret_id)
}

/// workbook_id-keyed keychain account name. The PRIMARY identity
/// for substrate workbooks — survives renames, duplicates, and
/// any other path change. A user setting an API key on
/// `myworkbook.html` makes it instantly available on
/// `myworkbook (1).html` (the macOS-rename copy) since
/// both files have the same wb-meta workbook_id.
fn keychain_account_by_id(workbook_id: &str, secret_id: &str) -> String {
    // "wb:" prefix distinguishes id-keyed from path-keyed accounts
    // in `security dump-keychain` output and makes the format
    // self-documenting.
    format!("wb:{workbook_id}:{secret_id}")
}

/// Resolve a keychain account preferring id-keying when a
/// workbook_id is known, falling back to path-keying. Returns the
/// account name to use for READING — for WRITING, we write to BOTH
/// (id-keyed for future copies + path-keyed for back-compat readers).
fn keychain_read_account(path: &Path, workbook_id: Option<&str>, secret_id: &str) -> String {
    workbook_id
        .map(|id| keychain_account_by_id(id, secret_id))
        .unwrap_or_else(|| keychain_account(path, secret_id))
}

/// Read a secret value preferring id-keyed; fall back to path-keyed
/// (legacy entries from pre-0.1.4 sessions). Either succeeds first
/// wins. NoEntry → None.
fn keychain_get(
    path: &Path,
    workbook_id: Option<&str>,
    secret_id: &str,
) -> Result<Option<String>, keyring::Error> {
    if let Some(id) = workbook_id {
        let e = keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_account_by_id(id, secret_id))?;
        match e.get_password() {
            Ok(v) => return Ok(Some(v)),
            Err(keyring::Error::NoEntry) => {}
            Err(other) => return Err(other),
        }
    }
    let e = keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_account(path, secret_id))?;
    match e.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(other) => Err(other),
    }
}

/// Write a secret value to BOTH indexes when workbook_id is known
/// (so future copies inherit) — to path-keyed only otherwise (the
/// brand-new-workbook case where wb-meta hasn't been minted yet).
fn keychain_set(
    path: &Path,
    workbook_id: Option<&str>,
    secret_id: &str,
    value: &str,
) -> Result<(), keyring::Error> {
    let path_entry = keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_account(path, secret_id))?;
    path_entry.set_password(value)?;
    if let Some(id) = workbook_id {
        let id_entry = keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_account_by_id(id, secret_id))?;
        id_entry.set_password(value)?;
    }
    Ok(())
}

/// Delete from both indexes. NoEntry on either side is fine.
fn keychain_delete(
    path: &Path,
    workbook_id: Option<&str>,
    secret_id: &str,
) -> Result<(), keyring::Error> {
    if let Ok(e) = keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_account(path, secret_id)) {
        let _ = e.delete_credential();
    }
    if let Some(id) = workbook_id {
        if let Ok(e) = keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_account_by_id(id, secret_id)) {
            let _ = e.delete_credential();
        }
    }
    Ok(())
}

/// Resolve the path bound to `token`, or 404 / 403. Refreshes
/// last_access on the session as a side effect (touch-LRU).
async fn path_for_token(state: &AppState, token: &str) -> Option<PathBuf> {
    state.sessions.lock().await.touch(token)
}

#[derive(Deserialize)]
struct SecretSetReq {
    id: String,
    value: String,
}

async fn secret_set_handler(
    State(state): State<AppState>,
    AxPath(token): AxPath<String>,
    headers: HeaderMap,
    axum::Json(req): axum::Json<SecretSetReq>,
) -> impl IntoResponse {
    if let Err(resp) = require_daemon_origin(&headers) {
        return resp;
    }
    let path = match require_perm(&state, &token, "secrets").await {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    if req.id.is_empty() || req.id.len() > 64 || !req.id.chars().all(is_secret_id_char) {
        return (
            StatusCode::BAD_REQUEST,
            "secret id must be 1-64 chars in [A-Za-z0-9_-]",
        )
            .into_response();
    }
    if req.id == SECRET_INDEX_ID {
        // The reserved index slot — refuse so a /secret/set can't
        // corrupt the per-path id list.
        return (StatusCode::BAD_REQUEST, "reserved secret id").into_response();
    }
    // Wrap incoming value in SecretString so it can't accidentally
    // appear in panic backtraces or eprintln debug paths.
    let value = SecretString::new(req.value.into());
    let workbook_id = state.sessions.lock().await.workbook_id_for(&token);
    if let Err(e) = keychain_set(&path, workbook_id.as_deref(), &req.id, value.expose_secret()) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("keychain write: {e}"),
        )
            .into_response();
    }
    // Persist the "known ids" index. Writes to BOTH path-keyed and
    // (when workbook_id is known) id-keyed entries so /secret/list
    // surfaces the same set of ids on every copy of this workbook.
    let _ = upsert_secret_index(&path, workbook_id.as_deref(), |ids| {
        if !ids.iter().any(|x| x == &req.id) {
            ids.push(req.id.clone());
        }
    });
    audit_log(&path, "secret-set", Some(&req.id), None);
    (StatusCode::OK, "ok").into_response()
}

#[derive(Deserialize)]
struct SecretDeleteReq {
    id: String,
}

async fn secret_delete_handler(
    State(state): State<AppState>,
    AxPath(token): AxPath<String>,
    headers: HeaderMap,
    axum::Json(req): axum::Json<SecretDeleteReq>,
) -> impl IntoResponse {
    if let Err(resp) = require_daemon_origin(&headers) {
        return resp;
    }
    let path = match require_perm(&state, &token, "secrets").await {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    if req.id == SECRET_INDEX_ID {
        return (StatusCode::BAD_REQUEST, "reserved secret id").into_response();
    }
    let workbook_id = state.sessions.lock().await.workbook_id_for(&token);
    let _ = keychain_delete(&path, workbook_id.as_deref(), &req.id);
    let _ = upsert_secret_index(&path, workbook_id.as_deref(), |ids| ids.retain(|x| x != &req.id));
    audit_log(&path, "secret-delete", Some(&req.id), None);
    (StatusCode::OK, "ok").into_response()
}

#[derive(Serialize)]
struct SecretListResp {
    ids: Vec<String>,
}

#[derive(Serialize)]
struct SecretPreviewResp {
    masked: String,
}

/// Daemon-side reveal: return a redacted preview ("fa••••xyzy") so
/// the UI can show "this key is set" with enough fingerprint to
/// confirm WHICH key without exposing the full value to browser
/// memory. Strategy:
///   - len < 8: return all bullets, no fingerprint (too short to
///     reveal any chars safely).
///   - len 8–11: first 1 + bullets + last 2.
///   - len ≥ 12: first 2 + bullets + last 4.
fn mask_preview(value: &SecretString) -> String {
    let v = value.expose_secret();
    let n = v.chars().count();
    if n < 8 {
        return "•".repeat(n.max(4));
    }
    let chars: Vec<char> = v.chars().collect();
    if n < 12 {
        let prefix: String = chars.iter().take(1).collect();
        let suffix: String = chars.iter().skip(n - 2).collect();
        return format!("{prefix}••••••{suffix}");
    }
    let prefix: String = chars.iter().take(2).collect();
    let suffix: String = chars.iter().skip(n - 4).collect();
    format!("{prefix}••••••••{suffix}")
}

async fn secret_preview_handler(
    State(state): State<AppState>,
    AxPath((token, id)): AxPath<(String, String)>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(resp) = require_daemon_origin(&headers) {
        return resp;
    }
    let path = match require_perm(&state, &token, "secrets").await {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    if id == SECRET_INDEX_ID {
        return (StatusCode::BAD_REQUEST, "reserved secret id").into_response();
    }
    let workbook_id = state.sessions.lock().await.workbook_id_for(&token);
    let raw = match keychain_get(&path, workbook_id.as_deref(), &id) {
        Ok(Some(v)) => v,
        Ok(None) => return (StatusCode::NOT_FOUND, "secret not set").into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("keychain read: {e}")).into_response(),
    };
    let value = SecretString::new(raw.into());
    let masked = mask_preview(&value);
    // value drops here, zeroizing.
    audit_log(&path, "secret-preview", Some(&id), None);
    (StatusCode::OK, axum::Json(SecretPreviewResp { masked })).into_response()
}

async fn secret_list_handler(
    State(state): State<AppState>,
    AxPath(token): AxPath<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(resp) = require_daemon_origin(&headers) {
        return resp;
    }
    let path = match require_perm(&state, &token, "secrets").await {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    // Filter out the reserved index id from the response — it's
    // an implementation detail, not a user-set secret.
    let workbook_id = state.sessions.lock().await.workbook_id_for(&token);
    let ids: Vec<String> = read_secret_index(&path, workbook_id.as_deref())
        .unwrap_or_default()
        .into_iter()
        .filter(|x| x != SECRET_INDEX_ID)
        .collect();
    (StatusCode::OK, axum::Json(SecretListResp { ids })).into_response()
}

fn is_secret_id_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

const SECRET_INDEX_ID: &str = "__index";

/// Read the union of secret IDs known for this workbook —
/// id-keyed entries first (the modern primary), path-keyed
/// added in for back-compat with pre-0.1.4 sessions. Either
/// source contributes; UI-side dedupe collapses overlap.
fn read_secret_index(path: &Path, workbook_id: Option<&str>) -> Result<Vec<String>, String> {
    use std::collections::BTreeSet;
    let mut out: BTreeSet<String> = BTreeSet::new();

    // Path-keyed.
    let path_entry = keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_account(path, SECRET_INDEX_ID))
        .map_err(|e| format!("keychain open (path): {e}"))?;
    match path_entry.get_password() {
        Ok(s) => for x in s.split(',') { if !x.is_empty() { out.insert(x.to_string()); } },
        Err(keyring::Error::NoEntry) => {},
        Err(e) => return Err(format!("keychain read (path): {e}")),
    }

    // Id-keyed (modern primary).
    if let Some(id) = workbook_id {
        let id_entry = keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_account_by_id(id, SECRET_INDEX_ID))
            .map_err(|e| format!("keychain open (id): {e}"))?;
        match id_entry.get_password() {
            Ok(s) => for x in s.split(',') { if !x.is_empty() { out.insert(x.to_string()); } },
            Err(keyring::Error::NoEntry) => {},
            Err(e) => return Err(format!("keychain read (id): {e}")),
        }
    }

    Ok(out.into_iter().collect())
}

/// Update the secret-id index. Writes to BOTH path-keyed and
/// (when workbook_id is known) id-keyed entries — the latter
/// makes the index inheritable across renames/duplicates.
fn upsert_secret_index(
    path: &Path,
    workbook_id: Option<&str>,
    mutate: impl FnOnce(&mut Vec<String>),
) -> Result<(), String> {
    let mut ids = read_secret_index(path, workbook_id).unwrap_or_default();
    mutate(&mut ids);
    ids.sort();
    ids.dedup();
    let joined = ids.join(",");

    // Path-keyed write (back-compat readers + the no-workbook_id case).
    let path_entry = keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_account(path, SECRET_INDEX_ID))
        .map_err(|e| format!("keychain open (path): {e}"))?;
    path_entry
        .set_password(&joined)
        .map_err(|e| format!("keychain write (path): {e}"))?;

    // Id-keyed write (modern primary; inherited across copies).
    if let Some(id) = workbook_id {
        let id_entry = keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_account_by_id(id, SECRET_INDEX_ID))
            .map_err(|e| format!("keychain open (id): {e}"))?;
        id_entry
            .set_password(&joined)
            .map_err(|e| format!("keychain write (id): {e}"))?;
    }
    Ok(())
}

// ── outbound HTTPS proxy ───────────────────────────────────────────
//
// Browser code POSTs `{url, method, headers, body, auth}`. The
// daemon resolves `auth.secretId` against the bound workbook's
// keychain entries and splices the value into a header per
// `auth.format`. The page never sees the secret. For binary
// responses, body is base64-encoded; the response also reports
// the upstream content-type so the caller can decode appropriately.

#[derive(Deserialize)]
struct ProxyReq {
    url: String,
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body: Option<String>,
    /// If body is base64 (binary upload), set true.
    #[serde(default)]
    body_b64: bool,
    #[serde(default)]
    auth: Option<ProxyAuth>,
    /// Optional multipart/form-data body. When present, `body` and
    /// `body_b64` are ignored — the daemon builds a real multipart
    /// payload via reqwest::multipart::Form and sets the
    /// Content-Type with the right boundary automatically. Used by
    /// flows that upload audio (ElevenLabs voice clone) or images
    /// (fal.ai img2img) — those APIs reject JSON bodies.
    #[serde(default)]
    multipart: Option<Vec<MultipartPart>>,
}

#[derive(Deserialize)]
struct MultipartPart {
    /// Form field name. Required.
    name: String,
    /// Text value. Mutually exclusive with `content_b64`. Either one
    /// must be set per part.
    #[serde(default)]
    value: Option<String>,
    /// Filename for file parts (e.g. "audio.wav"). When present the
    /// part is sent with a Content-Disposition: form-data; filename=...
    #[serde(default)]
    filename: Option<String>,
    /// Per-part Content-Type, e.g. "audio/wav". Defaults to
    /// "application/octet-stream" for file parts, "text/plain"
    /// otherwise.
    #[serde(default)]
    content_type: Option<String>,
    /// Base64-encoded part body. Set instead of `value` for binary
    /// payloads.
    #[serde(default)]
    content_b64: Option<String>,
}

#[derive(Deserialize)]
struct ProxyAuth {
    /// Header name to inject, e.g. "Authorization" or "xi-api-key".
    #[serde(rename = "headerName")]
    header_name: String,
    /// Which secret id (in keychain) to resolve.
    #[serde(rename = "secretId")]
    secret_id: String,
    /// Optional template — `{value}` is replaced with the secret.
    /// Defaults to "{value}" if absent.
    #[serde(default)]
    format: Option<String>,
}

fn default_method() -> String {
    "GET".to_string()
}

#[derive(Serialize)]
struct ProxyResp {
    status: u16,
    headers: HashMap<String, String>,
    /// Response body, base64 when `body_b64` is true (binary), else
    /// utf8 string.
    body: String,
    body_b64: bool,
}

async fn proxy_handler(
    State(state): State<AppState>,
    AxPath(token): AxPath<String>,
    headers: HeaderMap,
    axum::Json(req): axum::Json<ProxyReq>,
) -> impl IntoResponse {
    if let Err(resp) = require_daemon_origin(&headers) {
        return resp;
    }
    let path = match require_perm(&state, &token, "network").await {
        Ok(p) => p,
        Err(resp) => return resp,
    };

    // Only HTTPS — refuse plaintext + custom schemes outright.
    let parsed = match reqwest::Url::parse(&req.url) {
        Ok(u) => u,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("bad url: {e}")).into_response(),
    };
    if parsed.scheme() != "https" {
        return (StatusCode::BAD_REQUEST, "only https:// urls allowed").into_response();
    }
    let upstream_host = match parsed.host_str() {
        Some(h) => h.to_string(),
        None => return (StatusCode::BAD_REQUEST, "url has no host").into_response(),
    };

    // Domain allowlist enforcement. The session's policy was parsed
    // from the workbook's spec script when it was served. If the
    // policy declares this secret_id, the upstream host MUST match
    // one of the patterns. If the policy doesn't mention the id,
    // legacy fallback: any HTTPS host (will tighten in a future
    // release once every workbook has migrated to declared policies).
    if let Some(auth) = &req.auth {
        let policy = state.sessions.lock().await.policy_for(&token);
        if let Some(p) = policy.as_ref() {
            if let Some(allowed) = p.host_allowed_for(&auth.secret_id, &upstream_host) {
                if !allowed {
                    audit_log(
                        &path,
                        "proxy-refused-domain",
                        Some(&auth.secret_id),
                        Some(&upstream_host),
                    );
                    return (
                        StatusCode::FORBIDDEN,
                        format!(
                            "secret '{}' is not allowed to be sent to {} (per workbook config)",
                            auth.secret_id, upstream_host,
                        ),
                    )
                        .into_response();
                }
            }
        }
    }

    let method = match reqwest::Method::from_bytes(req.method.as_bytes()) {
        Ok(m) => m,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid http method").into_response(),
    };

    let client = match reqwest::Client::builder()
        .user_agent(concat!("workbooksd/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(120))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("http client init: {e}"),
            )
                .into_response();
        }
    };

    let mut builder = client.request(method, parsed);

    for (k, v) in &req.headers {
        // Block headers that could let the caller spoof the secret
        // injection. The `auth` block is the only sanctioned path.
        if matches_auth_header_name(k, req.auth.as_ref()) {
            continue;
        }
        builder = builder.header(k.as_str(), v.as_str());
    }

    if let Some(auth) = &req.auth {
        // Resolve the secret value via id-keyed → path-keyed
        // fallback so duplicates of this workbook (macOS-rename
        // copies) inherit keys without re-entry.
        let proxy_workbook_id = state.sessions.lock().await.workbook_id_for(&token);
        let value: SecretString = match keychain_get(&path, proxy_workbook_id.as_deref(), &auth.secret_id) {
            Ok(Some(v)) => SecretString::new(v.into()),
            Ok(None) => {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("secret '{}' not set for this workbook", auth.secret_id),
                )
                    .into_response();
            }
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("keychain read: {e}"),
                )
                    .into_response();
            }
        };
        let formatted: SecretString = auth
            .format
            .as_deref()
            .unwrap_or("{value}")
            .replace("{value}", value.expose_secret())
            .into();
        // Move into the request builder; the SecretString in
        // `formatted` drops at the end of this scope and zeroizes.
        builder = builder.header(auth.header_name.as_str(), formatted.expose_secret());
        audit_log(&path, "proxy", Some(&auth.secret_id), Some(&upstream_host));
    } else {
        // Unauth'd proxy call — still log so audit trail is complete.
        audit_log(&path, "proxy-noauth", None, Some(&upstream_host));
    }

    // Body construction. Multipart wins if present (file uploads to
    // fal.ai img2img / ElevenLabs voice clone). Then body_b64.
    // Then plain body. The three are mutually exclusive — caller
    // shouldn't set more than one but we honor the priority above
    // without erroring if they do.
    if let Some(parts) = req.multipart {
        let mut form = reqwest::multipart::Form::new();
        for part in parts {
            let mut p = if let Some(b64) = part.content_b64 {
                let bytes = match decode_base64(&b64) {
                    Ok(b) => b,
                    Err(e) => {
                        return (
                            StatusCode::BAD_REQUEST,
                            format!("multipart part {:?} content_b64: {e}", part.name),
                        )
                            .into_response();
                    }
                };
                reqwest::multipart::Part::bytes(bytes)
            } else if let Some(v) = part.value {
                reqwest::multipart::Part::text(v)
            } else {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("multipart part {:?} needs `value` or `content_b64`", part.name),
                )
                    .into_response();
            };
            if let Some(name) = part.filename {
                p = p.file_name(name);
            }
            if let Some(ct) = part.content_type {
                match p.mime_str(&ct) {
                    Ok(np) => p = np,
                    Err(e) => {
                        return (
                            StatusCode::BAD_REQUEST,
                            format!("multipart part {:?} content_type {ct:?}: {e}", part.name),
                        )
                            .into_response();
                    }
                }
            }
            form = form.part(part.name, p);
        }
        builder = builder.multipart(form);
    } else if let Some(body) = req.body {
        if req.body_b64 {
            match decode_base64(&body) {
                Ok(bytes) => builder = builder.body(bytes),
                Err(e) => {
                    return (StatusCode::BAD_REQUEST, format!("body_b64: {e}")).into_response();
                }
            }
        } else {
            builder = builder.body(body);
        }
    }

    let resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, format!("upstream: {e}")).into_response();
        }
    };

    let status = resp.status().as_u16();
    let mut hdrs = HashMap::new();
    for (k, v) in resp.headers() {
        if let Ok(s) = v.to_str() {
            hdrs.insert(k.as_str().to_string(), s.to_string());
        }
    }
    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, format!("upstream body: {e}")).into_response();
        }
    };
    // Decide encoding by content-type, with base64 as the safe default
    // for anything that isn't obviously text. JSON, plain text, html,
    // xml ride as utf8; everything else ships as base64.
    let ct = hdrs
        .get("content-type")
        .map(String::as_str)
        .unwrap_or("application/octet-stream");
    let is_text = ct.starts_with("text/")
        || ct.starts_with("application/json")
        || ct.starts_with("application/xml")
        || ct.starts_with("application/javascript")
        || ct.starts_with("application/x-ndjson");
    let (body, body_b64) = if is_text {
        match std::str::from_utf8(&bytes) {
            Ok(s) => (s.to_string(), false),
            Err(_) => (encode_base64(&bytes), true),
        }
    } else {
        (encode_base64(&bytes), true)
    };

    (
        StatusCode::OK,
        axum::Json(ProxyResp {
            status,
            headers: hdrs,
            body,
            body_b64,
        }),
    )
        .into_response()
}

fn matches_auth_header_name(h: &str, auth: Option<&ProxyAuth>) -> bool {
    auth.map(|a| a.header_name.eq_ignore_ascii_case(h)).unwrap_or(false)
}

// Tiny base64 encode/decode — reqwest doesn't expose one and pulling
// `base64` for these two call sites is overkill.
pub(crate) fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | (bytes[i + 2] as u32);
        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 6) & 63) as usize] as char);
        out.push(ALPHABET[(n & 63) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}

pub(crate) fn decode_base64(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u8, String> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("invalid base64 char {:?}", c as char)),
        }
    }
    let trimmed: Vec<u8> = s.bytes().filter(|&c| c != b'\n' && c != b'\r').collect();
    let len = trimmed.len();
    if len % 4 != 0 {
        return Err("base64 length must be multiple of 4".to_string());
    }
    let mut out = Vec::with_capacity(len / 4 * 3);
    let mut i = 0;
    while i < len {
        let pad = (trimmed[i + 2] == b'=') as usize + (trimmed[i + 3] == b'=') as usize;
        let v0 = val(trimmed[i])?;
        let v1 = val(trimmed[i + 1])?;
        let v2 = if trimmed[i + 2] == b'=' { 0 } else { val(trimmed[i + 2])? };
        let v3 = if trimmed[i + 3] == b'=' { 0 } else { val(trimmed[i + 3])? };
        let n = ((v0 as u32) << 18) | ((v1 as u32) << 12) | ((v2 as u32) << 6) | (v3 as u32);
        out.push((n >> 16) as u8);
        if pad < 2 { out.push((n >> 8) as u8); }
        if pad < 1 { out.push(n as u8); }
        i += 4;
    }
    Ok(out)
}

// ── path / token plumbing ───────────────────────────────────────────

/// Return true if `html` carries a recognizable workbook marker.
/// Used by the /open handler to gate untrusted HTML — see the
/// caller for the rationale on why content beats filename.
///
/// Accepts both substrate-pipeline workbooks (`<script id="wb-meta">`)
/// and app-pipeline workbooks (`<meta name="wb-permissions">`).
/// Cheap byte search; the .html files we care about are bounded
/// at ~25 MB and the markers live in `<head>`, so a full scan is
/// fine.
fn looks_like_workbook(html: &str) -> bool {
    // Order checked = order most likely to hit early in <head>.
    html.contains("<meta name=\"wb-permissions\"")
        || html.contains(r#"<script id="wb-meta""#)
        || html.contains(r#"<script type="application/json" id="wb-meta""#)
}

fn validate_workbook_path(raw: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(raw);
    let abs = p.canonicalize().map_err(|e| format!("canonicalize: {e}"))?;
    let name = abs
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "path has no file name".to_string())?;
    // Defense-in-depth: must be HTML by extension. The real
    // "is this a workbook?" decision happens in open_handler by
    // sniffing wb-meta from the content — that way macOS-renamed
    // duplicates like `foo.workbook (1).html` (which lose the
    // `.html` suffix during Finder duplication) still
    // open. Brand-new files coming out of `wb build` get wb-meta
    // injected by the substrate plugin, so the content check is
    // the canonical truth.
    // We deliberately do NOT gate on file extension. As of 0.3.1
    // workbooks are identified by content (`<meta name="wb-permissions">`
    // or `<script id="wb-meta">`), not by name. The .html
    // convention is being retired — files should just be `.html`,
    // because:
    //   - macOS Finder breaks the compound extension on duplicate
    //     ("foo.html" → "foo.workbook (1).html")
    //   - the per-file OpenWith xattr we stamp on /open and /save
    //     is what actually routes; the extension is irrelevant
    //   - dropping the convention removes a class of "looks weird in
    //     Finder" / Get Info Kind bugs
    //
    // Defense-in-depth still happens: open_handler reads the file
    // and rejects with 400 if no workbook marker is present, so a
    // stray /open POST can't make the daemon serve arbitrary files
    // — the content gate, not the name gate, is canonical.
    //
    // We do still require the path to point at an actual file (not
    // a directory or symlink to /dev/null), via the canonicalize()
    // call above plus the file_name() check.
    let _ = name; // kept for the file_name() validation above
    Ok(abs)
}

fn mint_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("os entropy");
    let mut s = String::with_capacity(32);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

async fn atomic_write(path: &Path, body: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("html.tmp");
    tokio::fs::write(&tmp, body)
        .await
        .map_err(|e| format!("write tmp: {e}"))?;
    if let Err(e) = tokio::fs::rename(&tmp, path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!("rename: {e}"));
    }
    Ok(())
}

// ── open subcommand (sync HTTP client over loopback) ────────────────

fn run_open(raw_path: PathBuf) -> Result<(), String> {
    let abs = raw_path
        .canonicalize()
        .map_err(|e| format!("canonicalize {}: {e}", raw_path.display()))?;
    if !ensure_daemon_up()? {
        return Err("could not start or reach daemon".into());
    }
    let path_str = abs.to_string_lossy().into_owned();
    let body = serde_json::to_string(&serde_json::json!({ "path": path_str }))
        .map_err(|e| format!("encode open req: {e}"))?;
    let resp_body = http_post_loopback("/open", "application/json", body.as_bytes())?;
    let resp: OpenResp = serde_json::from_str(&resp_body)
        .map_err(|e| format!("decode open resp: {e} (body: {resp_body})"))?;
    eprintln!("[workbooksd open] token={} url={}", resp.token, resp.url);
    spawn_browser(&resp.url);
    Ok(())
}

fn ensure_daemon_up() -> Result<bool, String> {
    if http_get_health().is_ok() {
        return Ok(true);
    }
    // Daemon isn't responding — spawn ourselves as one. We detach the
    // child from the launching terminal's session so closing that
    // terminal can't SIGHUP it. setsid() in pre_exec puts the child in a
    // fresh session with no controlling tty; combined with stdio →
    // /dev/null, the daemon survives shell exit cleanly.
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let mut cmd = Command::new(&exe);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    cmd.spawn().map_err(|e| format!("spawn daemon: {e}"))?;
    // Poll for up to ~3s.
    for _ in 0..30 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if http_get_health().is_ok() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Look up the running daemon's port via runtime.json. Returns
/// a friendly error if the file is missing or stale — the
/// caller (`workbooksd open <path>` etc.) re-checks after spawn.
fn discover_running_port() -> Result<u16, String> {
    read_runtime_port()
        .ok_or_else(|| "no runtime.json — daemon not running".to_string())
}

fn http_get_health() -> Result<(), String> {
    use std::io::{Read, Write};
    let port = discover_running_port()?;
    let mut s = std::net::TcpStream::connect_timeout(
        &format!("{BIND_HOST}:{port}").parse().unwrap(),
        std::time::Duration::from_millis(300),
    )
    .map_err(|e| format!("connect: {e}"))?;
    s.set_read_timeout(Some(std::time::Duration::from_millis(500))).ok();
    let req = format!(
        "GET /health HTTP/1.0\r\nHost: {BIND_HOST}:{port}\r\nConnection: close\r\n\r\n"
    );
    s.write_all(req.as_bytes()).map_err(|e| format!("write: {e}"))?;
    let mut resp = String::new();
    s.read_to_string(&mut resp).map_err(|e| format!("read: {e}"))?;
    if resp.starts_with("HTTP/1.0 200") || resp.starts_with("HTTP/1.1 200") {
        Ok(())
    } else {
        Err(format!("unexpected: {}", resp.lines().next().unwrap_or("")))
    }
}

fn http_post_loopback(path: &str, content_type: &str, body: &[u8]) -> Result<String, String> {
    use std::io::{Read, Write};
    let port = discover_running_port()?;
    let mut s = std::net::TcpStream::connect_timeout(
        &format!("{BIND_HOST}:{port}").parse().unwrap(),
        std::time::Duration::from_secs(2),
    )
    .map_err(|e| format!("connect: {e}"))?;
    s.set_read_timeout(Some(std::time::Duration::from_secs(5))).ok();
    let req_head = format!(
        "POST {path} HTTP/1.0\r\nHost: {BIND_HOST}:{port}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    s.write_all(req_head.as_bytes()).map_err(|e| format!("write head: {e}"))?;
    s.write_all(body).map_err(|e| format!("write body: {e}"))?;
    let mut resp = Vec::new();
    s.read_to_end(&mut resp).map_err(|e| format!("read: {e}"))?;
    let resp = String::from_utf8_lossy(&resp).into_owned();

    // Surface non-2xx with the response body verbatim so the user sees the
    // daemon's actual error (e.g. "not a workbook (must end in ...)").
    let status_line = resp.lines().next().unwrap_or("");
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);

    let split = resp
        .find("\r\n\r\n")
        .ok_or_else(|| "malformed response (no header terminator)".to_string())?;
    let body = resp[split + 4..].to_string();

    if !(200..300).contains(&status) {
        return Err(format!("daemon returned {status}: {}", body.trim()));
    }
    Ok(body)
}

fn spawn_browser(url: &str) {
    if std::env::var_os("WB_NO_BROWSER").is_some() {
        eprintln!("[workbooksd open] WB_NO_BROWSER set; not launching browser");
        return;
    }

    // WB_BROWSER pins a specific browser regardless of the system
    // default. Useful when (a) the OS default is stale or wrong,
    // (b) you want workbooks to open in a different browser than
    // the system default for everything else.
    //
    // Value formats:
    //   macOS:   app name or bundle id ("Comet", "Google Chrome",
    //            "Firefox", "ai.perplexity.comet"). Forwarded as
    //            `open -a <value> <url>`.
    //   Linux:   absolute path to a browser binary, or a name on
    //            $PATH ("firefox", "google-chrome"). Used directly.
    //   Windows: absolute path to a browser executable. Replaces
    //            the default `start` invocation.
    let browser_override = std::env::var("WB_BROWSER").ok();

    #[cfg(target_os = "macos")]
    let cmd: (&str, Vec<&str>) = match browser_override.as_deref() {
        Some(app) if !app.is_empty() => ("open", vec!["-a", app, url]),
        _ => ("open", vec![url]),
    };
    #[cfg(target_os = "linux")]
    let cmd: (&str, Vec<&str>) = match browser_override.as_deref() {
        Some(bin) if !bin.is_empty() => (bin, vec![url]),
        _ => ("xdg-open", vec![url]),
    };
    #[cfg(target_os = "windows")]
    let cmd: (&str, Vec<&str>) = match browser_override.as_deref() {
        Some(bin) if !bin.is_empty() => (bin, vec![url]),
        _ => ("cmd", vec!["/C", "start", "", url]),
    };

    let _ = Command::new(cmd.0)
        .args(&cmd.1)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}
