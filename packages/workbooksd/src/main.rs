// workbooksd — local background daemon that serves and saves
// .workbook.html files to the user's browser.
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
//     and (b) end in `.workbook.html` — defense-in-depth so a stray
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
const BIND_PORT: u16 = 47119;
const WORKBOOK_SUFFIX: &str = ".workbook.html";
const MAX_SESSIONS: usize = 1000;
const OPEN_BURST: f64 = 10.0;
const OPEN_REFILL_PER_MIN: f64 = 10.0;

// ── shared state ────────────────────────────────────────────────────

#[derive(Clone)]
struct AppState {
    sessions: Arc<Mutex<SessionStore>>,
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

struct SessionStore {
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
        });
        evicted
    }

    /// Look up a token's bound path and refresh its last_access stamp.
    /// Returns None if the token isn't known.
    fn touch(&mut self, token: &str) -> Option<PathBuf> {
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
}

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
        .with_state(state);

    let addr: SocketAddr = format!("{BIND_HOST}:{BIND_PORT}").parse().unwrap();
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[workbooksd] cannot bind {addr}: {e}");
            eprintln!("[workbooksd] is another instance already running?");
            std::process::exit(1);
        }
    };
    eprintln!("[workbooksd] listening on http://{addr}");
    axum::serve(listener, app).await.expect("serve");
}

// ── handlers ────────────────────────────────────────────────────────

async fn health() -> &'static str {
    "ok"
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
    let evicted = state.sessions.lock().await.insert(token.clone(), path);
    if let Some(old) = evicted {
        eprintln!("[workbooksd] sessions at cap; evicted oldest token {old}");
    }
    let url = format!("http://{BIND_HOST}:{BIND_PORT}/wb/{token}/");
    (StatusCode::OK, axum::Json(OpenResp { token, url })).into_response()
}

async fn redirect_to_slash(AxPath(token): AxPath<String>) -> Redirect {
    Redirect::permanent(&format!("/wb/{token}/"))
}

async fn serve_workbook(
    State(state): State<AppState>,
    AxPath(token): AxPath<String>,
) -> impl IntoResponse {
    let Some(path) = state.sessions.lock().await.touch(&token) else {
        return (StatusCode::NOT_FOUND, "unknown token").into_response();
    };
    match tokio::fs::read_to_string(&path).await {
        Ok(html) => {
            // Extract the per-secret domain policy from the workbook's
            // spec script and cache it on the session. /proxy will
            // enforce this for every outbound call. Best-effort: a
            // workbook without a spec / policy stays in legacy mode
            // (any HTTPS host) — Phase 3 may flip that to deny-by-default.
            let policy = parse_secrets_policy(&html);
            state.sessions.lock().await.set_policy(&token, policy);

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
            let mut resp = Html(html).into_response();
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
    if let Some(matched_id) = scan_for_known_secrets(&path, &body) {
        let msg = format!(
            "save refused: workbook content contains the value of secret '{matched_id}'. \
             Remove that string from the workbook before saving (or rotate the key in \
             File → Integrations).\n"
        );
        audit_log(&path, "save-refused-leak", Some(&matched_id), None);
        return (StatusCode::CONFLICT, msg).into_response();
    }

    if let Err(e) = atomic_write(&path, &body).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response();
    }
    eprintln!("[workbooksd] saved {} ({} bytes)", path.display(), body.len());
    audit_log(&path, "save", None, None);
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
fn require_daemon_origin(headers: &HeaderMap) -> Result<(), Response> {
    let expected = format!("http://{BIND_HOST}:{BIND_PORT}");
    match headers.get("origin").and_then(|v| v.to_str().ok()) {
        Some(o) if o == expected => Ok(()),
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
fn scan_for_known_secrets(path: &Path, body: &[u8]) -> Option<String> {
    let ids = read_secret_index(path).ok()?;
    for id in ids {
        if id == SECRET_INDEX_ID {
            continue;
        }
        let entry = match keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_account(path, &id)) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let value = match entry.get_password() {
            Ok(v) => SecretString::new(v.into()),
            Err(_) => continue,
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
    if let Some(home) = std::env::var_os("HOME") {
        let mut p = PathBuf::from(home);
        #[cfg(target_os = "macos")]
        {
            p.push("Library/Logs");
        }
        #[cfg(not(target_os = "macos"))]
        {
            p.push(".local/share/workbooksd");
        }
        p.push("workbooksd-audit.log");
        return p;
    }
    PathBuf::from("/tmp/workbooksd-audit.log")
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
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        return PathBuf::from(dir).join("workbooksd.lock");
    }
    if let Some(home) = std::env::var_os("HOME") {
        let mut p = PathBuf::from(home);
        #[cfg(target_os = "macos")]
        p.push("Library/Caches/sh.workbooks.workbooksd");
        #[cfg(not(target_os = "macos"))]
        p.push(".cache/workbooksd");
        return p.join("lock");
    }
    PathBuf::from("/tmp/workbooksd.lock")
}

#[cfg(unix)]
fn acquire_lockfile() -> Result<std::fs::File, String> {
    use std::io::{Read, Seek, Write};
    use std::os::unix::io::AsRawFd;

    let path = lockfile_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let mut f = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| format!("open lockfile {}: {e}", path.display()))?;

    let rc = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc != 0 {
        // Re-read to surface the existing pid if we can.
        let mut existing = String::new();
        let _ = f.read_to_string(&mut existing);
        let pid = existing.trim();
        return Err(format!(
            "another workbooksd is already running (lock: {}, pid: {})",
            path.display(),
            if pid.is_empty() { "?" } else { pid }
        ));
    }

    f.set_len(0).ok();
    f.seek(std::io::SeekFrom::Start(0)).ok();
    let _ = writeln!(f, "{}", std::process::id());
    f.flush().ok();
    Ok(f)
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
    // Lightweight hash — we don't need cryptographic strength here,
    // just collision-resistance across paths a single user has.
    // Using FxHash via std hasher (fnv-ish) is fine for that.
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn keychain_account(path: &Path, secret_id: &str) -> String {
    format!("{}:{}", path_fingerprint(path), secret_id)
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
    let path = match path_for_token(&state, &token).await {
        Some(p) => p,
        None => return (StatusCode::NOT_FOUND, "unknown token").into_response(),
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
    let entry = match keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_account(&path, &req.id)) {
        Ok(e) => e,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("keychain open: {e}"),
            )
                .into_response();
        }
    };
    if let Err(e) = entry.set_password(value.expose_secret()) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("keychain write: {e}"),
        )
            .into_response();
    }
    // Persist a per-path "known ids" index so /secret/list doesn't
    // need to enumerate the keychain (which is awkward + unreliable
    // across platforms). The index itself sits in the keychain too,
    // under a reserved id so it can't collide with a user secret.
    let _ = upsert_secret_index(&path, |ids| {
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
    let path = match path_for_token(&state, &token).await {
        Some(p) => p,
        None => return (StatusCode::NOT_FOUND, "unknown token").into_response(),
    };
    if req.id == SECRET_INDEX_ID {
        return (StatusCode::BAD_REQUEST, "reserved secret id").into_response();
    }
    if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_account(&path, &req.id)) {
        // delete_credential returns NoEntry if it didn't exist; that's fine.
        let _ = entry.delete_credential();
    }
    let _ = upsert_secret_index(&path, |ids| ids.retain(|x| x != &req.id));
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
    let path = match path_for_token(&state, &token).await {
        Some(p) => p,
        None => return (StatusCode::NOT_FOUND, "unknown token").into_response(),
    };
    if id == SECRET_INDEX_ID {
        return (StatusCode::BAD_REQUEST, "reserved secret id").into_response();
    }
    let entry = match keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_account(&path, &id)) {
        Ok(e) => e,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("keychain open: {e}"),
            )
                .into_response();
        }
    };
    let value = match entry.get_password() {
        Ok(v) => SecretString::new(v.into()),
        Err(keyring::Error::NoEntry) => {
            return (StatusCode::NOT_FOUND, "secret not set").into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("keychain read: {e}"),
            )
                .into_response();
        }
    };
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
    let path = match path_for_token(&state, &token).await {
        Some(p) => p,
        None => return (StatusCode::NOT_FOUND, "unknown token").into_response(),
    };
    // Filter out the reserved index id from the response — it's
    // an implementation detail, not a user-set secret.
    let ids: Vec<String> = read_secret_index(&path)
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

fn read_secret_index(path: &Path) -> Result<Vec<String>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_account(path, SECRET_INDEX_ID))
        .map_err(|e| format!("keychain open: {e}"))?;
    match entry.get_password() {
        Ok(s) => Ok(s.split(',').filter(|x| !x.is_empty()).map(String::from).collect()),
        Err(keyring::Error::NoEntry) => Ok(Vec::new()),
        Err(e) => Err(format!("keychain read: {e}")),
    }
}

fn upsert_secret_index(path: &Path, mutate: impl FnOnce(&mut Vec<String>)) -> Result<(), String> {
    let mut ids = read_secret_index(path).unwrap_or_default();
    mutate(&mut ids);
    ids.sort();
    ids.dedup();
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_account(path, SECRET_INDEX_ID))
        .map_err(|e| format!("keychain open: {e}"))?;
    entry
        .set_password(&ids.join(","))
        .map_err(|e| format!("keychain write: {e}"))
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
    let path = match path_for_token(&state, &token).await {
        Some(p) => p,
        None => return (StatusCode::NOT_FOUND, "unknown token").into_response(),
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
        let entry = match keyring::Entry::new(
            KEYCHAIN_SERVICE,
            &keychain_account(&path, &auth.secret_id),
        ) {
            Ok(e) => e,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("keychain open: {e}"),
                )
                    .into_response();
            }
        };
        // Wrap the keychain read in SecretString so the value can't
        // accidentally surface in a panic backtrace, eprintln, or
        // unintended Debug derive. Drop zeroizes the buffer.
        let value: SecretString = match entry.get_password() {
            Ok(v) => SecretString::new(v.into()),
            Err(keyring::Error::NoEntry) => {
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

    if let Some(body) = req.body {
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
fn encode_base64(bytes: &[u8]) -> String {
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

fn decode_base64(s: &str) -> Result<Vec<u8>, String> {
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

fn validate_workbook_path(raw: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(raw);
    let abs = p.canonicalize().map_err(|e| format!("canonicalize: {e}"))?;
    let name = abs
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "path has no file name".to_string())?;
    if !name.ends_with(WORKBOOK_SUFFIX) {
        return Err(format!("not a workbook (must end in {WORKBOOK_SUFFIX})"));
    }
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

fn http_get_health() -> Result<(), String> {
    use std::io::{Read, Write};
    let mut s = std::net::TcpStream::connect_timeout(
        &format!("{BIND_HOST}:{BIND_PORT}").parse().unwrap(),
        std::time::Duration::from_millis(300),
    )
    .map_err(|e| format!("connect: {e}"))?;
    s.set_read_timeout(Some(std::time::Duration::from_millis(500))).ok();
    let req = format!(
        "GET /health HTTP/1.0\r\nHost: {BIND_HOST}:{BIND_PORT}\r\nConnection: close\r\n\r\n"
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
    let mut s = std::net::TcpStream::connect_timeout(
        &format!("{BIND_HOST}:{BIND_PORT}").parse().unwrap(),
        std::time::Duration::from_secs(2),
    )
    .map_err(|e| format!("connect: {e}"))?;
    s.set_read_timeout(Some(std::time::Duration::from_secs(5))).ok();
    let req_head = format!(
        "POST {path} HTTP/1.0\r\nHost: {BIND_HOST}:{BIND_PORT}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
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
