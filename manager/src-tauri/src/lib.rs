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

/// Forward a Finder open event to the daemon's /open and shell-open
/// the resulting browser URL. Called from RunEvent::Opened on macOS.
fn route_file_open(path: &str) -> Result<(), String> {
    let port = discover_live_port()
        .ok_or_else(|| "daemon not running — this should be impossible after setup".to_string())?;
    let url = format!("http://127.0.0.1:{port}/open");
    let body = serde_json::json!({ "path": path });
    let resp = ureq::post(&url)
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|e| format!("/open call failed: {e}"))?;
    let parsed: OpenResp = resp
        .into_json()
        .map_err(|e| format!("decode /open response: {e}"))?;

    // Hand the wb/<token>/ URL to the user's default browser. Using
    // `open` on macOS (and the cross-platform shell open elsewhere)
    // means the workbook lands in whatever browser the user prefers
    // — Manager itself doesn't render workbooks.
    let _ = std::process::Command::new("open").arg(&parsed.url).spawn();
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
            if discover_live_port().is_none() {
                let bin = resolve_sidecar_path(&app.handle())
                    .map_err(|e| format!("locate workbooksd sidecar: {e}"))?;
                spawn_daemon_detached(&bin)
                    .map_err(|e| format!("spawn workbooksd: {e}"))?;
                // Block briefly so daemon_url returns successfully on
                // the first frontend call. 3 s is generous — typical
                // bind takes ~200 ms.
                if wait_for_daemon(Duration::from_secs(3)).is_none() {
                    eprintln!("[manager] warning: daemon didn't respond within 3s");
                }
            }
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
