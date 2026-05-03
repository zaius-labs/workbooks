// Workbooks (the consolidated Manager+daemon app).
//
// One app, two responsibilities:
//   1. Embed and supervise `workbooksd` as a sidecar — Tauri ships
//      the daemon binary inside the .app bundle and we spawn it on
//      first launch (detached so it survives Manager quitting,
//      keeping browser-served workbooks autosaving).
//   2. Provide the management UI — a Svelte webview the user opens
//      to see workbook history, fork lineage, edit-log timelines.
//
// The third responsibility — being the macOS document handler for
// .workbook.html and any HTML carrying wb-meta / wb-permissions —
// folds into the Tauri shell via RunEvent::Opened. This replaces
// the standalone `Workbooks.app` shell-script bundle that the
// .pkg used to install at /Applications.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Manager, RunEvent};

/// Where the daemon writes its discovery file. Mirrored from
/// workbooksd's main.rs — keep these two definitions in sync if the
/// daemon ever changes its on-disk locations. Linux fallback uses
/// XDG conventions.
fn runtime_json_path() -> PathBuf {
    let mut p: PathBuf = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    #[cfg(target_os = "macos")]
    {
        p.push("Library/Application Support/sh.workbooks.workbooksd");
    }
    #[cfg(not(target_os = "macos"))]
    {
        p.push(".local/share/workbooksd");
    }
    p.push("runtime.json");
    p
}

/// Read runtime.json, returning the live port if the file is fresh
/// AND the daemon at that port answers /health within ~250 ms.
/// Returns None for stale runtime.json files left behind by a
/// crashed daemon — the caller respawns in that case.
fn discover_live_port() -> Option<u16> {
    let body = std::fs::read_to_string(runtime_json_path()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    let port = v.get("port")?.as_u64()? as u16;
    // Probe /health to confirm the daemon is actually up; runtime.json
    // can persist after a crash since the file isn't deleted on exit.
    let url = format!("http://127.0.0.1:{port}/health");
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(250))
        .build();
    let resp = agent.get(&url).call().ok()?;
    if resp.status() == 200 {
        Some(port)
    } else {
        None
    }
}

/// Spawn the bundled workbooksd binary as a detached child. Detach
/// matters: a Tauri-managed sidecar dies when the GUI process exits,
/// but workbooksd is also serving the user's already-open browser
/// tabs (autosave + secret proxy). We want it to outlive the GUI.
///
/// Mechanism: setsid() in pre_exec puts the child in a fresh session
/// with no controlling tty + no parent-process group; combined with
/// stdio → /dev/null, the daemon survives Manager close cleanly.
/// (Same pattern workbooksd uses internally for `workbooksd open`'s
/// auto-spawn; see packages/workbooksd/src/main.rs:ensure_daemon_up.)
fn spawn_daemon_detached(daemon_bin: &PathBuf) -> Result<(), String> {
    use std::process::{Command, Stdio};

    let mut cmd = Command::new(daemon_bin);
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

    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("spawn workbooksd: {e}"))
}

/// Resolve the bundled sidecar binary path. Tauri's bundler copies
/// `binaries/workbooksd-<TARGET>` to `Contents/MacOS/workbooksd`
/// (sibling of the main GUI binary) at bundle time, NOT into
/// Contents/Resources/. In dev the unsuffixed file doesn't exist;
/// we fall back to the triple-suffixed copy under src-tauri/binaries
/// so `bun tauri dev` works.
fn resolve_sidecar_path(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Production: sibling of the running Tauri executable.
    let exe = std::env::current_exe()
        .map_err(|e| format!("current_exe: {e}"))?;
    if let Some(dir) = exe.parent() {
        let sibling = dir.join("workbooksd");
        if sibling.exists() {
            return Ok(sibling);
        }
    }

    // Dev fallback — Tauri only strips the triple on bundle build.
    let triple = std::env::consts::ARCH.to_string()
        + match std::env::consts::OS {
            "macos" => "-apple-darwin",
            "linux" => "-unknown-linux-gnu",
            "windows" => "-pc-windows-msvc.exe",
            other => return Err(format!("unsupported OS: {other}")),
        };
    // Walk up from the running Tauri exe (target/release/) to find
    // src-tauri/binaries/. Works for `bun tauri dev` and direct
    // `cargo run` from src-tauri/.
    let from_exe = exe
        .parent()
        .and_then(|p| p.parent()) // release/
        .and_then(|p| p.parent()) // target/
        .map(|p| p.join("binaries").join(format!("workbooksd-{triple}")))
        .filter(|p| p.exists());
    if let Some(p) = from_exe {
        return Ok(p);
    }
    let from_cwd = std::env::current_dir()
        .ok()
        .map(|d| d.join("src-tauri").join("binaries").join(format!("workbooksd-{triple}")))
        .filter(|p| p.exists());
    from_cwd.ok_or_else(|| "workbooksd sidecar not found in bundle or dev tree".to_string())
}

/// Bundle ID of the consolidated Workbooks app — kept in sync with
/// tauri.conf.json's identifier. Used as the handler bundle ID when
/// claiming the default for public.html.
const WORKBOOKS_BUNDLE_ID: &str = "sh.workbooks.launcher";

/// Marker file: presence means we already prompted the user (or set
/// successfully) to make Workbooks the default for public.html.
/// Lives next to runtime.json. Removed only by uninstall — re-install
/// won't re-prompt.
fn default_handler_marker() -> PathBuf {
    let mut p: PathBuf = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    #[cfg(target_os = "macos")]
    {
        p.push("Library/Application Support/sh.workbooks.workbooksd");
    }
    #[cfg(not(target_os = "macos"))]
    {
        p.push(".local/share/workbooksd");
    }
    p.push("default-handler-prompted");
    p
}

/// Ask macOS to make Workbooks the default app for public.html. Must
/// run in a GUI session — postinstall can't because macOS shows a
/// "Change All" confirmation dialog the user has to click. We invoke
/// the workbooksd subcommand we ship for exactly this purpose; it
/// links CoreServices and calls LSSetDefaultRoleHandlerForContentType.
///
/// Idempotent via a marker file: only attempted on the very first
/// launch after install. If the user dismisses the prompt, we don't
/// nag — they can run "Set as default" from the manager UI later.
#[cfg(target_os = "macos")]
fn maybe_claim_default_handler(daemon_bin: &PathBuf) {
    let marker = default_handler_marker();
    if marker.exists() {
        return;
    }
    let _ = std::process::Command::new(daemon_bin)
        .args(["set-default-handler", "public.html", WORKBOOKS_BUNDLE_ID])
        .spawn();
    // Touch the marker regardless of whether the user accepts the
    // prompt — repeated nags are worse than a missed default. Users
    // who declined can change it back later via Finder Get Info, and
    // we'll add a manager-UI control in a follow-up.
    if let Some(parent) = marker.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&marker, "");
}

/// Wait up to `total` for runtime.json to appear AND respond healthy.
/// Polled at 100 ms intervals — daemon startup is typically under
/// 500 ms once the binary is on disk.
fn wait_for_daemon(total: Duration) -> Option<u16> {
    let deadline = std::time::Instant::now() + total;
    while std::time::Instant::now() < deadline {
        if let Some(port) = discover_live_port() {
            return Some(port);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    None
}

/// Public Tauri command: hand the Svelte frontend the daemon's URL.
/// Front-end uses this to construct fetch() URLs for /ledger/*,
/// /open, etc. Returns None if the daemon isn't reachable.
#[tauri::command]
fn daemon_url() -> Option<String> {
    discover_live_port().map(|port| format!("http://127.0.0.1:{port}"))
}

#[derive(Debug, Deserialize, Serialize)]
struct OpenResp {
    #[allow(dead_code)]
    token: String,
    url: String,
}

/// True if `html` looks like a Workbook (has wb-meta or wb-permissions).
/// Mirror of workbooksd's `looks_like_workbook` — duplicated here so
/// the routing decision happens BEFORE the daemon HTTP round-trip
/// (and works even if the daemon's down). We only sniff the head of
/// the file (~16 KB) since the markers always live in <head>.
fn looks_like_workbook(head: &str) -> bool {
    head.contains(r#"<meta name="wb-permissions""#)
        || head.contains(r#"<script id="wb-meta""#)
        || head.contains(r#"<script type="application/json" id="wb-meta""#)
}

/// Read the user's "fallback browser" preference — the bundle ID of
/// whatever app should handle plain (non-workbook) HTML. Captured at
/// install time as the user's previous default for public.html. If
/// unset, we hand off to Safari, which is always present on macOS.
fn fallback_browser_bundle_id() -> String {
    let mut p: PathBuf = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    p.push("Library/Application Support/sh.workbooks.workbooksd/fallback-browser.txt");
    std::fs::read_to_string(&p)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "com.apple.Safari".to_string())
}

/// Hand a non-workbook HTML file off to the user's preferred browser.
/// `open -b <bundle-id> <file>` launches that app with the file —
/// equivalent to "Always Open With" without changing system defaults.
fn open_in_fallback(path: &str) {
    let bundle = fallback_browser_bundle_id();
    let _ = std::process::Command::new("open")
        .args(["-b", &bundle, path])
        .spawn();
}

/// Forward a Finder open event to the daemon's /open and shell-open
/// the resulting browser URL. Called from RunEvent::Opened on macOS.
///
/// Strategy:
///   1. Sniff the file: if it doesn't carry a workbook marker, hand
///      it straight to the user's fallback browser. Workbooks claims
///      public.html as the system default so we route ALL .html
///      opens; only those that ARE workbooks should land at the
///      daemon.
///   2. If it's a workbook, POST to /open and shell-open the result.
fn route_file_open(path: &str) -> Result<(), String> {
    use std::io::Read;

    // Sniff first ~16 KB. Workbook markers always live in <head>;
    // 16 KB is enough to clear typical inlined favicons/fonts that
    // pad early <head> content.
    let mut head_buf = vec![0u8; 16 * 1024];
    let mut f = std::fs::File::open(path)
        .map_err(|e| format!("read {path}: {e}"))?;
    let n = f.read(&mut head_buf).unwrap_or(0);
    head_buf.truncate(n);
    let head = String::from_utf8_lossy(&head_buf);

    if !looks_like_workbook(&head) {
        eprintln!("[manager] non-workbook HTML, forwarding to fallback browser: {path}");
        open_in_fallback(path);
        return Ok(());
    }

    // Workbook: forward to daemon for token + URL.
    let port = discover_live_port()
        .ok_or_else(|| "daemon not running".to_string())?;
    let url = format!("http://127.0.0.1:{port}/open");
    let body = serde_json::json!({ "path": path });
    let resp = ureq::post(&url)
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|e| format!("/open call failed: {e}"))?;
    let parsed: OpenResp = resp
        .into_json()
        .map_err(|e| format!("decode /open response: {e}"))?;

    // Hand the wb/<token>/ URL to the user's default browser. We
    // use the fallback bundle ID here too so the workbook lands in
    // the SAME browser the user prefers for plain HTML — not in
    // Workbooks itself (which has no rendering capability).
    let bundle = fallback_browser_bundle_id();
    let _ = std::process::Command::new("open")
        .args(["-b", &bundle, &parsed.url])
        .spawn();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![daemon_url])
        .setup(|app| {
            // Daemon lifecycle: spawn the bundled sidecar UNLESS one is
            // already running and healthy. Existing instances might be
            // a previous Manager run that detached its daemon, or the
            // legacy LaunchAgent-based install. Either way, we
            // attach rather than fight for the port.
            let sidecar = resolve_sidecar_path(&app.handle())
                .map_err(|e| format!("locate workbooksd sidecar: {e}"))?;
            if discover_live_port().is_none() {
                spawn_daemon_detached(&sidecar)
                    .map_err(|e| format!("spawn workbooksd: {e}"))?;
                if wait_for_daemon(Duration::from_secs(3)).is_none() {
                    eprintln!("[manager] warning: daemon didn't respond within 3s");
                }
            }
            // First-launch only: ask macOS to make Workbooks the
            // default for public.html. Triggers a system prompt the
            // user must accept; we run it here (in a GUI session)
            // because postinstall can't show that dialog.
            #[cfg(target_os = "macos")]
            maybe_claim_default_handler(&sidecar);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, event| {
        if let RunEvent::Opened { urls } = event {
            // macOS sends file:// URLs in the Apple-event "odoc" path.
            // Convert to local file path and forward to daemon.
            for url in urls {
                if url.scheme() == "file" {
                    if let Ok(path) = url.to_file_path() {
                        let path_str = path.to_string_lossy().into_owned();
                        if let Err(e) = route_file_open(&path_str) {
                            eprintln!("[manager] route_file_open({path_str}) failed: {e}");
                        }
                    }
                }
            }
        }
    });
}
