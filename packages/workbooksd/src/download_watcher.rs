//! Filesystem watcher that auto-stamps the OpenWith xattr on new
//! workbook files dropped into common locations.
//!
//! Why this exists: macOS Sequoia blocks programmatic claiming of
//! `public.html` as default, so the daemon can't simply route every
//! .html the user has. Instead we use the per-file
//! `com.apple.LaunchServices.OpenWith` xattr — but that has to be
//! present on the file before macOS will route it to Workbooks. The
//! daemon stamps the xattr on `/open` and `/save`, which covers
//! files the user has interacted with at least once. Fresh
//! downloads (HTTP doesn't preserve xattrs) need a manual
//! right-click → Open With → Workbooks the first time, OR this
//! watcher.
//!
//! Behaviour:
//!   - Watches ~/Downloads, ~/Desktop, ~/Documents (top level only)
//!   - On a new .html / .htm / .workbook.html arrival → reads first
//!     16 KB → if `<meta name="wb-permissions">` or
//!     `<script id="wb-meta">` is present → stamps xattr
//!   - Skips non-workbook HTML so we don't hijack saved web pages
//!   - Best-effort: errors are eprintln'd but never bubble up
//!
//! Cost: one notify::RecommendedWatcher (FSEvents on macOS) covering
//! 3 directories non-recursively. Negligible CPU/memory until events
//! fire.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::xattr_openwith;

/// Spawn the watcher on a background tokio task. Returns immediately;
/// the task lives for the daemon's lifetime.
pub fn spawn() {
    let dirs = watch_dirs();
    if dirs.is_empty() {
        eprintln!("[download_watcher] no home directory found, skipping");
        return;
    }
    tokio::task::spawn_blocking(move || {
        if let Err(e) = run(dirs) {
            eprintln!("[download_watcher] exited: {e}");
        }
    });
}

fn watch_dirs() -> Vec<PathBuf> {
    let home = match std::env::var_os("HOME") {
        Some(h) => PathBuf::from(h),
        None => return vec![],
    };
    let mut dirs = Vec::new();
    for sub in ["Downloads", "Desktop", "Documents"] {
        let p = home.join(sub);
        if p.is_dir() {
            dirs.push(p);
        }
    }
    dirs
}

fn run(dirs: Vec<PathBuf>) -> Result<(), String> {
    use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel();
    let mut watcher = RecommendedWatcher::new(
        move |res| {
            // notify hands us Result<Event>; forward only successes.
            if let Ok(ev) = res {
                let _ = tx.send(ev);
            }
        },
        notify::Config::default(),
    )
    .map_err(|e| format!("RecommendedWatcher::new: {e}"))?;

    for d in &dirs {
        // Non-recursive — we only care about files dropped directly
        // into Downloads / Desktop / Documents. Walking iCloud
        // Drive / project subfolders would explode the watch budget
        // and is rarely where downloads land.
        watcher
            .watch(d, RecursiveMode::NonRecursive)
            .map_err(|e| format!("watch {}: {e}", d.display()))?;
    }
    eprintln!(
        "[download_watcher] watching {} dir(s) for new workbook files",
        dirs.len()
    );

    // Coalesce events: a single download often fires Create + Modify
    // + Modify (Safari writes the .download stub, then renames, then
    // the final write completes). We track recent paths and only
    // process each ~once per second.
    let mut recent: std::collections::HashMap<PathBuf, std::time::Instant> =
        std::collections::HashMap::new();
    const COALESCE: Duration = Duration::from_secs(1);

    while let Ok(ev) = rx.recv() {
        match ev.kind {
            EventKind::Create(_) | EventKind::Modify(_) => {}
            _ => continue,
        }
        for p in ev.paths {
            if !is_html_path(&p) {
                continue;
            }
            // Coalesce — if we processed this file in the last
            // second, skip. Cheap GC: opportunistically drop entries
            // older than 60s during the lookup.
            let now = std::time::Instant::now();
            recent.retain(|_, t| now.duration_since(*t) < Duration::from_secs(60));
            if let Some(prev) = recent.get(&p) {
                if now.duration_since(*prev) < COALESCE {
                    continue;
                }
            }
            recent.insert(p.clone(), now);

            // Off-thread the stamp work so a flurry of events doesn't
            // block the receiver.
            let path = p.clone();
            tokio::task::spawn_blocking(move || try_stamp(&path));
        }
    }
    Ok(())
}

fn is_html_path(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let lower = e.to_ascii_lowercase();
            lower == "html" || lower == "htm"
        })
        .unwrap_or(false)
}

/// Open the file, sniff for workbook markers, stamp the xattr if it's
/// a workbook. Best-effort: any failure is logged and swallowed.
fn try_stamp(path: &Path) {
    use std::io::Read;

    // Skip if already stamped — we don't need to re-stamp on every
    // modify event of an already-routed file. The xattr name is
    // stable so a presence check is a fast getxattr().
    if has_open_with_xattr(path) {
        return;
    }

    let mut buf = vec![0u8; 16 * 1024];
    let n = match std::fs::File::open(path)
        .and_then(|mut f| Read::read(&mut f, &mut buf))
    {
        Ok(n) => n,
        Err(_) => return,
    };
    let head = String::from_utf8_lossy(&buf[..n]);
    if !looks_like_workbook(&head) {
        return;
    }
    match xattr_openwith::stamp(path) {
        Ok(()) => {
            eprintln!("[download_watcher] stamped {}", path.display());
        }
        Err(e) => {
            eprintln!("[download_watcher] stamp failed on {}: {e}", path.display());
        }
    }
}

/// Check for our xattr without reading its value. macOS getxattr with
/// a NULL value buffer returns the size; we just want presence.
#[cfg(target_os = "macos")]
fn has_open_with_xattr(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let cpath = match std::ffi::CString::new(path.as_os_str().as_bytes()) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let cname = std::ffi::CString::new("com.apple.LaunchServices.OpenWith").unwrap();
    // SAFETY: getxattr is a thread-safe POSIX call; we pass valid
    // CStrings + a NULL value buffer (length 0) which makes it return
    // the attribute's size if it exists, -1 with ENOATTR if not.
    let rc = unsafe {
        libc::getxattr(
            cpath.as_ptr(),
            cname.as_ptr(),
            std::ptr::null_mut(),
            0,
            0,
            0,
        )
    };
    rc >= 0
}

#[cfg(not(target_os = "macos"))]
fn has_open_with_xattr(_path: &Path) -> bool {
    false
}

/// Mirror of workbooksd's `looks_like_workbook` content-sniff. A copy
/// rather than an import because main.rs's looks_like_workbook is
/// inside the binary's main module and not pub-exposed to siblings.
/// Both check for the same two markers — keep these in sync if a new
/// workbook-identity meta tag ever lands.
fn looks_like_workbook(html: &str) -> bool {
    html.contains("<meta name=\"wb-permissions\"")
        || html.contains(r#"<script id="wb-meta""#)
        || html.contains(r#"<script type="application/json" id="wb-meta""#)
}
