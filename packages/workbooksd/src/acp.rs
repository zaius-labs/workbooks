// Agent Client Protocol relay — daemon spawns a local ACP adapter
// (Anthropic claude-agent-acp or OpenAI codex-acp shim) and pipes its
// JSON-RPC stdio to a browser-side WebSocket. The browser is the ACP
// client; the daemon is a transparent transport.
//
// Why daemon-side and not browser-side: browsers can't spawn
// subprocesses, can't read $HOME, can't pipe stdio. The user's
// SUBSCRIPTION auth (claude /login state in ~/.claude, ChatGPT
// session in ~/.codex/auth.json) lives in the home directory and
// the adapter shim reads it directly when it boots. We inherit env
// at spawn so the adapter sees those creds — the user's billing
// path is their own subscription, not ours.
//
// Newline-delimited JSON-RPC, one message per WS frame. The daemon
// doesn't parse the messages in Phase 1 — they pass through. Phase 2
// will intercept fs/* and terminal/* requests so disk + shell access
// stay jailed to the workbook's parent directory regardless of what
// the adapter or browser does.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path as AxPath, State,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use futures_util::{sink::SinkExt, stream::StreamExt};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::mpsc,
};

use crate::AppState;

/// Bash script installed into <scratch>/.bin/wb-fetch on adapter
/// spawn. The agent's Bash tool calls it directly; it builds a
/// JSON request and POSTs to /wb/<token>/proxy. Baked at compile
/// time so the daemon binary has no runtime dependency on the
/// install layout.
const WB_FETCH_SCRIPT: &str = include_str!("../static/wb-fetch.sh");

/// MCP server (Node 18+ ESM, no deps) installed alongside
/// wb-fetch. Exposes structured tools to MCP-aware hosts;
/// translates calls into HTTP requests against the same /proxy
/// endpoint wb-fetch uses, honoring the same permission gates.
const WB_MCP_SERVER: &str = include_str!("../static/wb-mcp-server.mjs");

/// Per-adapter installation status reported to the browser. The
/// browser uses this to render the "Manage → Agents" UI: which
/// providers are present, whether the user has logged in, and the
/// command that will be spawned when they connect.
#[derive(Clone, Debug, Serialize)]
pub struct AdapterStatus {
    /// Stable id used in the WebSocket URL (`/agent/<id>`).
    pub id: String,
    /// User-facing label.
    pub name: String,
    /// Underlying CLI is on PATH (e.g. `claude`, `codex`).
    pub cli_installed: bool,
    /// Version reported by `<cli> --version`.
    pub cli_version: Option<String>,
    /// User's auth dir exists. Heuristic — actual subscription
    /// validity is only confirmed once the adapter boots and tries
    /// to call the upstream API.
    pub auth_present: bool,
    /// `npx` available on PATH (needed to launch the adapter shim).
    pub npx_available: bool,
    /// What the daemon will run on connect.
    pub spawn_command: Vec<String>,
    /// Plain-English hint when something's missing.
    pub hint: Option<String>,
}

/// Probe the local machine for known ACP adapters.
pub fn detect_adapters() -> Vec<AdapterStatus> {
    let npx = which("npx");
    vec![
        detect_one(
            "claude",
            "Claude Code",
            "claude",
            home_subdir(".claude"),
            &["@agentclientprotocol/claude-agent-acp"],
            &npx,
        ),
        detect_one(
            "codex",
            "OpenAI Codex",
            "codex",
            home_subdir(".codex").map(|p| p.join("auth.json")),
            &["@zed-industries/codex-acp"],
            &npx,
        ),
    ]
}

fn home_subdir(name: &str) -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(name))
}

/// Build an enriched PATH for child processes. Same source list as
/// `which()` but joined into a colon-separated string suitable for
/// passing to Command::env("PATH", ...). Order: well-known dirs
/// first (so child node/git/etc. resolutions match what we used to
/// find the launcher), then whatever the daemon's own PATH had.
fn enriched_path() -> std::ffi::OsString {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut dirs: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/sbin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ];
    if let Some(h) = home.as_ref() {
        for sub in [
            ".local/bin",
            ".cargo/bin",
            ".bun/bin",
            ".deno/bin",
            ".npm-global/bin",
            ".volta/bin",
        ] {
            dirs.insert(0, h.join(sub));
        }
    }
    if let Some(existing) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&existing) {
            if !dirs.contains(&d) {
                dirs.push(d);
            }
        }
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

/// Locate a binary by name. We check `$PATH` first, then a list of
/// well-known per-user / package-manager bin dirs that LaunchAgent-
/// spawned processes don't get in their PATH by default.
///
/// Why we need this: macOS launchd starts services with a minimal
/// PATH (`/usr/bin:/bin:/usr/sbin:/sbin`). Tools installed via
/// Homebrew (`/opt/homebrew/bin`), `pip --user` / `npm i -g`
/// (`~/.local/bin`, `~/.npm-global/bin`), Bun (`~/.bun/bin`), or
/// the Anthropic / OpenAI installers (`~/.local/bin`) are all
/// invisible until we look for them.
fn which(bin: &str) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(bin);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut extra: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/sbin"),
    ];
    if let Some(h) = home.as_ref() {
        for sub in [
            ".local/bin",
            ".cargo/bin",
            ".bun/bin",
            ".deno/bin",
            ".npm-global/bin",
            ".volta/bin",
            ".nvm/versions/node/current/bin",
            ".fnm/current/bin",
        ] {
            extra.push(h.join(sub));
        }
    }
    for dir in extra {
        let candidate = dir.join(bin);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn detect_one(
    id: &str,
    name: &str,
    cli: &str,
    auth_path: Option<PathBuf>,
    npm_pkg: &[&str],
    npx: &Option<PathBuf>,
) -> AdapterStatus {
    let cli_path = which(cli);
    let cli_installed = cli_path.is_some();
    let cli_version = cli_path.as_ref().and_then(|p| {
        // Use the resolved absolute path directly; relying on PATH
        // here would re-trip the launchd-stripped-PATH problem.
        std::process::Command::new(p)
            .arg("--version")
            .output()
            .ok()
            .and_then(|out| {
                if out.status.success() {
                    String::from_utf8_lossy(&out.stdout)
                        .lines()
                        .next()
                        .map(str::to_string)
                } else {
                    None
                }
            })
    });
    let auth_present = auth_path.as_ref().map(|p| p.exists()).unwrap_or(false);
    let npx_available = npx.is_some();

    let mut spawn_command: Vec<String> = Vec::new();
    if let Some(npx_path) = npx.as_ref() {
        spawn_command.push(npx_path.display().to_string());
        // `--yes` skips the "OK to install?" prompt the first time
        // the package is fetched. After the first run npx caches it.
        spawn_command.push("--yes".to_string());
        for arg in npm_pkg {
            spawn_command.push((*arg).to_string());
        }
    }

    let hint = if !cli_installed {
        Some(format!(
            "{name} CLI not found on PATH. Install it first: \
             https://github.com/{}",
            if cli == "claude" {
                "anthropics/claude-code"
            } else {
                "openai/codex"
            },
        ))
    } else if !auth_present {
        Some(format!(
            "{name} CLI is installed but you're not signed in. \
             Run `{cli} /login` (or the relevant auth subcommand) so \
             the adapter can use your subscription.",
        ))
    } else if !npx_available {
        Some("`npx` not on PATH. Install Node.js so the adapter shim \
              (`@agentclientprotocol/claude-agent-acp` or \
              `@zed-industries/codex-acp`) can be launched."
            .to_string())
    } else {
        None
    };

    AdapterStatus {
        id: id.to_string(),
        name: name.to_string(),
        cli_installed,
        cli_version,
        auth_present,
        npx_available,
        spawn_command,
        hint,
    }
}

pub async fn list_handler() -> impl IntoResponse {
    (StatusCode::OK, axum::Json(detect_adapters())).into_response()
}

#[derive(Deserialize)]
pub struct SeedReq {
    /// Map of relative scratch-dir path → file content. Paths must
    /// be relative; absolute or `..`-traversing paths are rejected.
    /// Example: `{ "composition.html": "<html>…", "skills/fal-ai/SKILL.md": "..." }`
    pub files: HashMap<String, String>,
}

/// Seed the per-session scratch dir with the workbook's logical
/// files BEFORE the WebSocket upgrade triggers an adapter spawn.
/// The browser POSTs its current composition + skills here; the
/// daemon writes them to the scratch dir; when the adapter spawns,
/// `Read` / `Bash ls` find real files.
///
/// Why this exists: ACP's fs/* methods are client-side, but Claude
/// Code's bundled tools (Read, Write, Bash, Edit) hit the REAL
/// filesystem regardless. So a virtualFs in the browser SDK alone
/// isn't visible to the agent. Materializing the workbook's logical
/// files into scratch makes them visible to those native tools.
pub async fn seed_handler(
    State(state): State<crate::AppState>,
    AxPath(token): AxPath<String>,
    headers: HeaderMap,
    axum::Json(req): axum::Json<SeedReq>,
) -> impl IntoResponse {
    if let Err(resp) = crate::require_daemon_origin(&headers) {
        return resp;
    }
    if state.sessions.lock().await.touch(&token).is_none() {
        return (StatusCode::NOT_FOUND, "unknown token").into_response();
    }
    let scratch = session_scratch_dir(&token);
    if let Err(e) = tokio::fs::create_dir_all(&scratch).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("create scratch: {e}"),
        )
            .into_response();
    }
    for (rel, content) in req.files {
        // Defense-in-depth path validation — strip leading slashes,
        // refuse `..` traversal, refuse empty / disk-root paths.
        let clean = rel.trim_start_matches('/').to_string();
        if clean.is_empty() || clean.split('/').any(|seg| seg == ".." || seg.is_empty()) {
            return (
                StatusCode::BAD_REQUEST,
                format!("invalid scratch path: {rel:?}"),
            )
                .into_response();
        }
        let dest = scratch.join(&clean);
        if let Some(parent) = dest.parent() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("mkdir {}: {e}", parent.display()),
                )
                    .into_response();
            }
        }
        // Mark BEFORE the write so the watcher (which can fire on
        // the same notify thread before this future returns) sees
        // the marker and suppresses the echo event.
        state.sessions.lock().await.mark_seeded(&token, clean.clone());
        if let Err(e) = tokio::fs::write(&dest, content).await {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("write {}: {e}", dest.display()),
            )
                .into_response();
        }
    }
    (StatusCode::OK, "ok").into_response()
}

/// WebSocket upgrade handler. The URL path carries the adapter id
/// (e.g. `/wb/<token>/agent/claude`). On accept we spawn the adapter
/// shim, pipe its stdio bidirectionally to the WebSocket, and tear
/// down the subprocess on disconnect.
pub async fn ws_handler(
    State(state): State<AppState>,
    AxPath((token, adapter_id)): AxPath<(String, String)>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    // Resolve session BEFORE upgrading — refusing here gives the
    // browser a clean 404 instead of an opaque WS close.
    let path = match state.sessions.lock().await.touch(&token) {
        Some(p) => p,
        None => return (StatusCode::NOT_FOUND, "unknown token").into_response(),
    };

    // Permission gate: if the workbook DECLARED an `agents`
    // permission and the user hasn't approved it, refuse.
    // Workbooks that didn't declare anything pass through (legacy
    // behavior — daemon doesn't gate workbooks built before the
    // permissions feature).
    if !crate::check_permission(&state, &token, "agents").await {
        return (
            StatusCode::FORBIDDEN,
            "permission 'agents' is requested by this workbook but not approved. \
             Surface the permissions dialog and have the user approve before retrying.",
        )
            .into_response();
    }

    let adapter = match detect_adapters().into_iter().find(|a| a.id == adapter_id) {
        Some(a) => a,
        None => return (StatusCode::NOT_FOUND, "unknown adapter").into_response(),
    };
    if adapter.spawn_command.is_empty() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            adapter.hint.unwrap_or_else(|| {
                "adapter cannot be launched (npx not found or shim package missing)".to_string()
            }),
        )
            .into_response();
    }

    ws.on_upgrade(move |socket| run_relay(socket, path, token, adapter, state))
}

/// Per-session scratch directory.
///
/// The ACP adapter (claude-agent-acp / codex-acp) wraps a real CLI
/// that expects a real filesystem — real git, real bash, real
/// file I/O. Pointing it at the user's home dir or the workbook's
/// parent dir would let the agent reach beyond the workbook (and
/// give us no good story for syncing edits back into the
/// .html file).
///
/// Instead, every session gets its own scratch dir:
///
///   ~/Library/Caches/sh.workbooks.workbooksd/sessions/<token>/
///   ~/.cache/workbooksd/sessions/<token>/             (Linux)
///
/// Phase 1 (now): we just create the dir and use it as cwd. The
/// dir starts empty; the agent works in a clean sandbox. If the
/// user wants the agent to see the workbook's contents they
/// reference them by absolute path, or wait for Phase 2.
///
/// Phase 2 (planned): the daemon extracts the workbook's logical
/// files into the scratch dir on connect (composition.html, assets,
/// skills as real files) and watches the dir for changes — edits
/// flow back into the substrate WAL via the existing /save path,
/// so when the user hits ⌘S the workbook file on disk gets the
/// agent's work atomically.
fn session_scratch_dir(token: &str) -> PathBuf {
    let mut base: PathBuf = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    #[cfg(target_os = "macos")]
    {
        base.push("Library/Caches/sh.workbooks.workbooksd");
    }
    #[cfg(not(target_os = "macos"))]
    {
        base.push(".cache/workbooksd");
    }
    base.push("sessions");
    base.push(token);
    base
}

/// The actual pump. Three concurrent loops over the lifetime of the
/// connection:
///   - browser → adapter: WS message → child stdin (line-delimited)
///   - adapter → browser: child stdout line → WS Text frame
///   - adapter stderr → daemon eprintln (visible in workbooksd.log)
///
/// Termination: when the WS closes OR the child exits, we abort the
/// other tasks and clean up. tokio::select! is the right shape.
async fn run_relay(
    socket: WebSocket,
    workbook_path: PathBuf,
    token: String,
    adapter: AdapterStatus,
    state: AppState,
) {
    // Per-session scratch dir. Replaces the workbook's parent dir
    // as the agent's cwd so the agent stays in a daemon-controlled
    // sandbox instead of having free run of wherever the user
    // happens to keep their workbook files.
    let scratch_dir = session_scratch_dir(&token);
    if let Err(e) = tokio::fs::create_dir_all(&scratch_dir).await {
        let _ = close_with_reason(
            socket,
            &format!("scratch dir create failed: {e} ({})", scratch_dir.display()),
        )
        .await;
        return;
    }

    // Stash the workbook path next to the scratch dir as a hint —
    // Phase 2 will read this to know which file to sync edits back
    // into. For Phase 1 it's just a breadcrumb for debugging.
    let _ = tokio::fs::write(
        scratch_dir.join(".workbook-path"),
        workbook_path.display().to_string(),
    )
    .await;

    // Install the wb-fetch shim into <scratch>/.bin so the adapter's
    // Bash tool can shell out to it for daemon-mediated HTTPS. The
    // script itself is baked into the binary with include_str!; we
    // just write it to disk + chmod +x once per session. Contains
    // no secret material — it just speaks our /proxy wire protocol.
    let bin_dir = scratch_dir.join(".bin");
    if let Err(e) = tokio::fs::create_dir_all(&bin_dir).await {
        eprintln!("[acp/{}] mkdir {} failed: {e}", adapter.id, bin_dir.display());
    }
    let wb_fetch_path = bin_dir.join("wb-fetch");
    if let Err(e) = tokio::fs::write(&wb_fetch_path, WB_FETCH_SCRIPT).await {
        eprintln!("[acp/{}] write wb-fetch: {e}", adapter.id);
    }
    let wb_mcp_path = bin_dir.join("wb-mcp-server");
    if let Err(e) = tokio::fs::write(&wb_mcp_path, WB_MCP_SERVER).await {
        eprintln!("[acp/{}] write wb-mcp-server: {e}", adapter.id);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for p in [&wb_fetch_path, &wb_mcp_path] {
            if let Ok(meta) = tokio::fs::metadata(p).await {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                let _ = tokio::fs::set_permissions(p, perms).await;
            }
        }
    }

    eprintln!(
        "[acp/{}] spawning {:?} (cwd={})",
        adapter.id,
        adapter.spawn_command,
        scratch_dir.display(),
    );

    let mut cmd = Command::new(&adapter.spawn_command[0]);
    cmd.args(&adapter.spawn_command[1..])
        .current_dir(&scratch_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // CRITICAL: do NOT clear env. The adapter reads HOME, which is
    // where ~/.claude / ~/.codex live — the user's subscription auth.
    //
    // BUT: launchd-spawned daemons inherit a stripped PATH
    // (/usr/bin:/bin:/usr/sbin:/sbin), which is missing the dirs
    // the adapter shim itself needs (node from /opt/homebrew/bin or
    // ~/.local/bin, claude from wherever the installer dropped it,
    // git, etc.). Enrich PATH so the child process — and any
    // subprocesses IT spawns — can find what they need. Prepend
    // <scratch>/.bin so wb-fetch is callable by bare name.
    {
        let mut path = std::ffi::OsString::new();
        path.push(&bin_dir);
        path.push(":");
        path.push(enriched_path());
        cmd.env("PATH", path);
    }

    // Hand the child the bits it needs to talk back to the daemon
    // — the URL of the local listener and the session-bound token.
    // wb-fetch reads these to authenticate /proxy calls.
    cmd.env(
        "WORKBOOKS_DAEMON_URL",
        format!("http://127.0.0.1:{}", crate::bound_port()),
    );
    cmd.env("WORKBOOKS_TOKEN", &token);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = close_with_reason(socket, &format!("adapter spawn failed: {e}")).await;
            return;
        }
    };

    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let (ws_tx, mut ws_rx) = socket.split();
    let mut child_stdin = stdin;
    let mut stdout_lines = BufReader::new(stdout).lines();
    let mut stderr_lines = BufReader::new(stderr).lines();

    let adapter_id = adapter.id.clone();

    // Shared sender — the stdout pump and the watcher both push WS
    // frames. Wrap in Arc<Mutex> so both tasks can serialize sends.
    let ws_tx = std::sync::Arc::new(tokio::sync::Mutex::new(ws_tx));

    // File-watcher → WS pump. Notifies the browser whenever the
    // adapter / agent has touched a file in the scratch dir, so
    // the browser can mirror those changes back into the workbook
    // substrate (e.g. composition.html → composition.set).
    let watch_dir = scratch_dir.clone();
    let watch_ws_tx = ws_tx.clone();
    let watch_id = adapter_id.clone();
    let watch_state = state.clone();
    let watch_token = token.clone();
    let (watch_kill_tx, mut watch_kill_rx) = mpsc::channel::<()>(1);
    let watcher_task = tokio::spawn(async move {
        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<Event>();
        let mut watcher = match RecommendedWatcher::new(
            move |res: notify::Result<Event>| {
                if let Ok(ev) = res {
                    let _ = event_tx.send(ev);
                }
            },
            notify::Config::default(),
        ) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[acp/{watch_id}] watcher init failed: {e}");
                return;
            }
        };
        if let Err(e) = watcher.watch(&watch_dir, RecursiveMode::Recursive) {
            eprintln!(
                "[acp/{watch_id}] watch {} failed: {e}",
                watch_dir.display()
            );
            return;
        }

        // Coalesce bursts — many editors / agents do open-write-rename
        // sequences that fire 3-5 events for one logical save. We
        // collect all events in a 60ms window keyed by path, then
        // emit one WS notification per touched path with the latest
        // content.
        loop {
            tokio::select! {
                _ = watch_kill_rx.recv() => break,
                Some(first) = event_rx.recv() => {
                    let mut paths: std::collections::HashSet<PathBuf> =
                        first.paths.into_iter().collect();
                    if !is_payload_event(&first.kind) {
                        // open/access/etc — ignore
                        continue;
                    }
                    // Drain any other events in this window.
                    let deadline = tokio::time::Instant::now()
                        + std::time::Duration::from_millis(60);
                    loop {
                        let remaining = deadline
                            .checked_duration_since(tokio::time::Instant::now())
                            .unwrap_or_default();
                        if remaining.is_zero() { break; }
                        match tokio::time::timeout(remaining, event_rx.recv()).await {
                            Ok(Some(ev)) if is_payload_event(&ev.kind) => {
                                for p in ev.paths { paths.insert(p); }
                            }
                            _ => break,
                        }
                    }
                    for p in paths {
                        let rel = match p.strip_prefix(&watch_dir) {
                            Ok(r) => r.to_string_lossy().into_owned(),
                            Err(_) => continue,
                        };
                        if rel.starts_with(".") || rel.contains("/.") {
                            continue; // skip dotfiles + .git internals
                        }
                        // Echo suppression: if the daemon itself just
                        // wrote this path (via /agent/seed), don't
                        // round-trip the change back to the browser
                        // — it'd flicker the iframe player as state
                        // re-applies a value it just sent.
                        if watch_state
                            .sessions
                            .lock()
                            .await
                            .was_recently_seeded(&watch_token, &rel)
                        {
                            continue;
                        }
                        // Try UTF-8 first (the common case for agent
                        // edits to composition.html / skills md), fall
                        // back to a base64 binary frame otherwise. The
                        // browser side decides what to do with binary
                        // — colorwave routes them into the assets
                        // store; other workbooks may ignore.
                        let frame = match tokio::fs::read(&p).await {
                            Ok(bytes) => match std::str::from_utf8(&bytes) {
                                Ok(text) => serde_json::json!({
                                    "jsonrpc": "2.0",
                                    "method": "_relay/file-changed",
                                    "params": {
                                        "path": rel,
                                        "content": text,
                                        "binary": false,
                                    },
                                }),
                                Err(_) => {
                                    let b64 = crate::encode_base64(&bytes);
                                    let mime = mime_guess_from_ext(&rel);
                                    serde_json::json!({
                                        "jsonrpc": "2.0",
                                        "method": "_relay/file-changed",
                                        "params": {
                                            "path": rel,
                                            "content_b64": b64,
                                            "mime": mime,
                                            "size": bytes.len(),
                                            "binary": true,
                                        },
                                    })
                                }
                            },
                            Err(_) => continue,
                        };
                        let txt = match serde_json::to_string(&frame) {
                            Ok(s) => s,
                            Err(_) => continue,
                        };
                        let mut tx = watch_ws_tx.lock().await;
                        if tx.send(Message::Text(txt)).await.is_err() {
                            break;
                        }
                    }
                }
                else => break,
            }
        }
        // Drop watcher on exit.
        drop(watcher);
    });

    // Stderr drain — best-effort logging. Adapters use stderr for
    // free-form diagnostics; we surface it in the daemon log so a
    // user looking at `tail -f ~/Library/Logs/workbooksd.log` can
    // diagnose auth or model errors.
    let stderr_id = adapter_id.clone();
    let stderr_task = tokio::spawn(async move {
        while let Ok(Some(line)) = stderr_lines.next_line().await {
            eprintln!("[acp/{stderr_id}/stderr] {line}");
        }
    });

    // Browser → adapter pump.
    let in_id = adapter_id.clone();
    let inbound_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_rx.next().await {
            match msg {
                Message::Text(t) => {
                    // ACP framing: one JSON-RPC message per line, no
                    // embedded newlines. We trust the browser to
                    // send well-framed messages — but defensively
                    // strip any trailing newline so we don't double
                    // up.
                    let trimmed = t.trim_end_matches('\n');
                    if let Err(e) = child_stdin.write_all(trimmed.as_bytes()).await {
                        eprintln!("[acp/{in_id}] write to adapter stdin: {e}");
                        break;
                    }
                    if let Err(e) = child_stdin.write_all(b"\n").await {
                        eprintln!("[acp/{in_id}] write newline: {e}");
                        break;
                    }
                    let _ = child_stdin.flush().await;
                }
                Message::Close(_) => break,
                Message::Binary(_) | Message::Ping(_) | Message::Pong(_) => { /* ignore */ }
            }
        }
        // On WS close: drop child_stdin → adapter's stdin closes,
        // adapter sees EOF, exits.
    });

    // Adapter → browser pump.
    let out_id = adapter_id.clone();
    let out_ws_tx = ws_tx.clone();
    let outbound_task = tokio::spawn(async move {
        while let Ok(Some(line)) = stdout_lines.next_line().await {
            // Each line is a complete JSON-RPC message. Forward as
            // a single WS Text frame.
            let mut tx = out_ws_tx.lock().await;
            if tx.send(Message::Text(line)).await.is_err() {
                eprintln!("[acp/{out_id}] WS peer closed during send");
                break;
            }
        }
        // Try to send a clean WS close so the browser knows the
        // adapter exited gracefully.
        let mut tx = out_ws_tx.lock().await;
        let _ = tx.send(Message::Close(None)).await;
    });

    // Wait on whichever side finishes first. tokio::select! gives us
    // a clean handle on which path triggered shutdown.
    tokio::select! {
        _ = inbound_task => {
            eprintln!("[acp/{adapter_id}] browser disconnected; killing adapter");
        }
        _ = outbound_task => {
            eprintln!("[acp/{adapter_id}] adapter exited; closing WS");
        }
        status = child.wait() => {
            eprintln!("[acp/{adapter_id}] child exit: {:?}", status);
        }
    }

    let _ = child.kill().await;
    let _ = child.wait().await;
    stderr_task.abort();
    let _ = watch_kill_tx.send(()).await;
    watcher_task.abort();

    // Best-effort scratch cleanup. Phase 2 will instead sync the
    // dir's contents back into the workbook's substrate before
    // removing it; Phase 1 just deletes since the dir was empty
    // on entry and any edits are throwaway.
    let scratch = session_scratch_dir(&token);
    if let Err(e) = tokio::fs::remove_dir_all(&scratch).await {
        eprintln!(
            "[acp/{}] scratch cleanup failed for {}: {e}",
            adapter.id,
            scratch.display(),
        );
    }
}

/// Helper: close the WebSocket with a human-readable reason BEFORE
/// the upgrade has happened. Used when adapter spawn fails so the
/// browser sees a meaningful error instead of a blank close.
async fn close_with_reason(socket: WebSocket, reason: &str) -> Result<(), axum::Error> {
    let mut s = socket;
    let _ = s.send(Message::Text(format!(
        "{{\"jsonrpc\":\"2.0\",\"method\":\"_relay/error\",\"params\":{{\"message\":\"{}\"}}}}",
        reason.replace('"', "\\\"")
    ))).await;
    s.send(Message::Close(None)).await
}

/// Filter out noise events the agent's own runtime generates that
/// don't correspond to a logical "the file changed" — open/close
/// for read, attribute changes, etc. We only pass through events
/// where the file's content might have changed.
fn is_payload_event(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_),
    )
}

/// Map a file extension to a MIME hint for binary assets that the
/// agent dropped into the scratch dir. The browser uses this to
/// classify the asset (image / audio / video) and to set the right
/// Content-Type when embedding as a data URL. Unknown extensions
/// fall back to application/octet-stream — the asset will still
/// round-trip but the workbook may refuse to display it.
fn mime_guess_from_ext(rel_path: &str) -> &'static str {
    let lc = rel_path.to_ascii_lowercase();
    let ext = lc.rsplit('.').next().unwrap_or("");
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        _ => "application/octet-stream",
    }
}
