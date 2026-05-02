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
    http::StatusCode,
    response::{Html, IntoResponse, Redirect},
    routing::{get, post, put},
    Router,
};
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
        self.map.insert(token, Session { path, last_access: Instant::now() });
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
        Ok(html) => Html(html).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("read failed: {e}"))
            .into_response(),
    }
}

async fn save_workbook(
    State(state): State<AppState>,
    AxPath(token): AxPath<String>,
    body: Bytes,
) -> impl IntoResponse {
    let Some(path) = state.sessions.lock().await.touch(&token) else {
        return (StatusCode::NOT_FOUND, "unknown token").into_response();
    };
    if let Err(e) = atomic_write(&path, &body).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response();
    }
    eprintln!("[workbooksd] saved {} ({} bytes)", path.display(), body.len());
    (StatusCode::OK, "saved").into_response()
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
    axum::Json(req): axum::Json<SecretSetReq>,
) -> impl IntoResponse {
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
    if let Err(e) = entry.set_password(&req.value) {
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
    (StatusCode::OK, "ok").into_response()
}

#[derive(Deserialize)]
struct SecretDeleteReq {
    id: String,
}

async fn secret_delete_handler(
    State(state): State<AppState>,
    AxPath(token): AxPath<String>,
    axum::Json(req): axum::Json<SecretDeleteReq>,
) -> impl IntoResponse {
    let path = match path_for_token(&state, &token).await {
        Some(p) => p,
        None => return (StatusCode::NOT_FOUND, "unknown token").into_response(),
    };
    if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_account(&path, &req.id)) {
        // delete_credential returns NoEntry if it didn't exist; that's fine.
        let _ = entry.delete_credential();
    }
    let _ = upsert_secret_index(&path, |ids| ids.retain(|x| x != &req.id));
    (StatusCode::OK, "ok").into_response()
}

#[derive(Serialize)]
struct SecretListResp {
    ids: Vec<String>,
}

async fn secret_list_handler(
    State(state): State<AppState>,
    AxPath(token): AxPath<String>,
) -> impl IntoResponse {
    let path = match path_for_token(&state, &token).await {
        Some(p) => p,
        None => return (StatusCode::NOT_FOUND, "unknown token").into_response(),
    };
    let ids = read_secret_index(&path).unwrap_or_default();
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
    axum::Json(req): axum::Json<ProxyReq>,
) -> impl IntoResponse {
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
    // Phase 2 will validate the host against the workbook config's
    // declared allowlist. For now, accept any HTTPS host so we can
    // ship the secrets refactor without blocking on schema work.

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
        let value = match entry.get_password() {
            Ok(v) => v,
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
        let formatted = auth
            .format
            .as_deref()
            .unwrap_or("{value}")
            .replace("{value}", &value);
        builder = builder.header(auth.header_name.as_str(), formatted);
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
