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
    extract::{Path as AxPath, State},
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

    // Permissive CORS for /health only — file:// pages probing for the
    // daemon need it. Bound workbook routes live on a separate Router
    // with no CORS layer (same-origin from the browser's perspective).
    let health_router = Router::new()
        .route("/health", get(health))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        );

    let app = Router::new()
        .merge(health_router)
        .route("/open", post(open_handler))
        .route("/wb/:token", get(redirect_to_slash))
        .route("/wb/:token/", get(serve_workbook))
        .route("/wb/:token/save", put(save_workbook))
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
    #[cfg(target_os = "macos")]
    let cmd = ("open", vec![url]);
    #[cfg(target_os = "linux")]
    let cmd = ("xdg-open", vec![url]);
    #[cfg(target_os = "windows")]
    let cmd = ("cmd", vec!["/C", "start", "", url]);

    let _ = Command::new(cmd.0)
        .args(&cmd.1)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}
