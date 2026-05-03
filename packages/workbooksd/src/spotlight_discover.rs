//! Spotlight-backed workbook discovery — finds every workbook file
//! anywhere Spotlight has indexed, regardless of whether the daemon
//! has ever served it. Complements the ledger (which only has files
//! the daemon's touched) so the manager UI can show "all your
//! workbooks" not "all the workbooks you've opened in Workbooks".
//!
//! How it works:
//!   1. `mdfind 'kMDItemContentType == "public.html"'` returns every
//!      indexed .html file. Spotlight excludes ~/Library/, OS caches,
//!      mounted network drives, etc. by default — exactly the set of
//!      "user files" we want.
//!   2. For each result, read first ~16 KB → content-sniff for
//!      `<meta name="wb-permissions">` or `<script id="wb-meta">`.
//!   3. Emit a `DiscoveredWorkbook` for each match.
//!
//! Why not a custom Spotlight importer (`.mdimporter` bundle)? It
//! would let us query `kMDItemKind == "Workbook"` directly and skip
//! the content-sniff loop, but requires shipping a separate signed
//! .mdimporter, registering with `mdimport -r`, and a bigger
//! installer story. The mdfind+sniff approach is good enough for
//! v0 — typical user has <1000 .html files, sniff is ~1ms each,
//! whole discovery completes in well under a second.
//!
//! Result is cached for ~30 seconds — Spotlight is fast but
//! repeated full scans on every manager refresh would be wasteful.

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Serialize)]
pub struct DiscoveredWorkbook {
    pub path: String,
    pub size: u64,
    /// Modification time as ISO 8601, or empty if stat failed.
    pub modified: String,
    /// Workbook id parsed from `<script id="wb-meta">`'s JSON body
    /// when present. Empty for colorwave-style workbooks that use
    /// only `<meta name="wb-permissions">`.
    pub workbook_id: String,
    /// Has the OpenWith xattr already been stamped? Lets the manager
    /// distinguish "double-click works" from "needs first-open via
    /// Workbooks to seed the routing."
    pub stamped: bool,
}

#[derive(Default)]
struct Cache {
    last: Option<Instant>,
    entries: Vec<DiscoveredWorkbook>,
}

static CACHE: Mutex<Cache> = Mutex::new(Cache {
    last: None,
    entries: Vec::new(),
});
const CACHE_TTL: Duration = Duration::from_secs(30);

/// Discover every workbook on disk. Returns a (possibly cached) list
/// sorted by modified-desc (most recent first).
pub fn discover() -> Vec<DiscoveredWorkbook> {
    {
        let cache = CACHE.lock().unwrap();
        if let Some(t) = cache.last {
            if t.elapsed() < CACHE_TTL {
                return cache.entries.clone();
            }
        }
    }

    let mut entries = scan_disk();
    entries.sort_by(|a, b| b.modified.cmp(&a.modified));

    let mut cache = CACHE.lock().unwrap();
    cache.last = Some(Instant::now());
    cache.entries = entries.clone();
    entries
}

#[cfg(target_os = "macos")]
fn scan_disk() -> Vec<DiscoveredWorkbook> {
    use std::process::Command;

    // Run mdfind for HTML files. Limit -name patterns aren't supported
    // for content-type queries, so we filter by content sniff after.
    // The query covers .html, .htm — public.html is the canonical UTI.
    let output = match Command::new("mdfind")
        .arg("kMDItemContentType == 'public.html'")
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[spotlight] mdfind failed: {e}");
            return vec![];
        }
    };
    if !output.status.success() {
        eprintln!(
            "[spotlight] mdfind exit {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        return vec![];
    }

    let mut out = Vec::new();
    for line in output.stdout.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let path_str = match std::str::from_utf8(line) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let path = PathBuf::from(path_str);
        if let Some(entry) = inspect(&path) {
            out.push(entry);
        }
    }
    out
}

#[cfg(not(target_os = "macos"))]
fn scan_disk() -> Vec<DiscoveredWorkbook> {
    // Linux/Windows: TODO — Tracker (Linux) or Windows Search Index
    // could fill this niche. For v0 we just return an empty list and
    // rely on the per-directory watcher.
    vec![]
}

/// Read the head of the file, content-sniff. Returns None for
/// non-workbooks or unreadable files.
fn inspect(path: &std::path::Path) -> Option<DiscoveredWorkbook> {
    use std::io::Read;

    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }

    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 16 * 1024];
    let n = f.read(&mut buf).ok()?;
    let head = std::str::from_utf8(&buf[..n]).ok()?;

    if !looks_like_workbook(head) {
        return None;
    }

    let workbook_id = crate::ledger::workbook_id_from_save_body(&buf[..n]).unwrap_or_default();
    let modified = meta
        .modified()
        .ok()
        .map(iso8601)
        .unwrap_or_default();
    let stamped = has_open_with_xattr(path);

    Some(DiscoveredWorkbook {
        path: path.to_string_lossy().into_owned(),
        size: meta.len(),
        modified,
        workbook_id,
        stamped,
    })
}

fn looks_like_workbook(html: &str) -> bool {
    html.contains("<meta name=\"wb-permissions\"")
        || html.contains(r#"<script id="wb-meta""#)
        || html.contains(r#"<script type="application/json" id="wb-meta""#)
}

#[cfg(target_os = "macos")]
fn has_open_with_xattr(path: &std::path::Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let cpath = match std::ffi::CString::new(path.as_os_str().as_bytes()) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let cname = std::ffi::CString::new("com.apple.LaunchServices.OpenWith").unwrap();
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
fn has_open_with_xattr(_path: &std::path::Path) -> bool {
    false
}

fn iso8601(t: std::time::SystemTime) -> String {
    let secs = t
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86400) as i64;
    let s = (secs % 86400) as u32;
    let (h, m, sec) = (s / 3600, (s % 3600) / 60, s % 60);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i32) + (era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if mo <= 2 { y + 1 } else { y };
    format!("{year:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{sec:02}Z")
}
