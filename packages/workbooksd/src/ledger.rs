// Per-workbook save history, keyed by the substrate workbook_id.
//
// On every /save the daemon mediates, parse `<script id="wb-meta">`
// from the body to pull workbook_id, append a small entry to a
// persistent JSON file:
//
//   ~/Library/Application Support/sh.workbooks.workbooksd/ledger.json
//   ~/.local/share/workbooksd/ledger.json                    (Linux)
//
// Each entry: {ts, file_path, file_sha256, size}. Lightweight by
// design — richer attribution (agent provider, secret uses, network
// hosts) lands in the in-file edit log (`<script id="wb-edit-log">`)
// where it travels with the file. The daemon ledger is the
// per-MACHINE view.
//
// Two queries:
//   GET /wb/<token>/ledger             history for THIS workbook
//   GET /ledger/<workbook_id>          history for an explicit id
//                                      (localhost-only; no auth
//                                      gate beyond that — we trust
//                                      anyone on 127.0.0.1)
//
// Workbooks that haven't had a first save yet have no wb-meta and
// no ledger entries. Brand new file → first save creates the entry.
//
// Cross-save correlation falls out of this for free: copy a workbook
// to a new path, save, the entry under the same workbook_id grows
// `paths_seen` and the saves list keeps appending. Same workbook,
// many paths, one history.

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct LedgerEntry {
    /// ISO 8601 timestamp.
    pub ts: String,
    /// Absolute path the daemon wrote to. Useful for "you have 3
    /// copies of this workbook on disk."
    pub file_path: String,
    /// Content hash so the portal viewer (and humans) can spot
    /// "this is the same bytes I had last week."
    pub file_sha256: String,
    /// File size in bytes. Cheap to compute, useful in summaries.
    pub size: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct WorkbookHistory {
    pub workbook_id: String,
    pub first_seen: String,
    pub last_save: String,
    /// Deduplicated set of paths where this workbook has been
    /// saved on this machine. Order = first-seen.
    pub paths_seen: Vec<String>,
    pub saves: Vec<LedgerEntry>,
}

#[derive(Default, Deserialize, Serialize)]
struct LedgerFile {
    /// workbook_id → history. Capped at 10_000 workbooks per
    /// machine; oldest entries evicted by `last_save`.
    by_id: HashMap<String, WorkbookHistory>,
}

const MAX_WORKBOOKS: usize = 10_000;
/// Cap on saves retained per workbook. Older entries are pruned
/// FIFO — the head of the list is always the newest save. A single
/// workbook with daily edits for 5 years stays under 2000 entries,
/// well below the cap.
const MAX_SAVES_PER_WORKBOOK: usize = 2_000;

fn ledger_path() -> PathBuf {
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
    p.push("ledger.json");
    p
}

fn load() -> LedgerFile {
    let path = ledger_path();
    let Ok(s) = std::fs::read_to_string(&path) else { return LedgerFile::default(); };
    serde_json::from_str(&s).unwrap_or_default()
}

fn store(f: &LedgerFile) -> Result<(), String> {
    let path = ledger_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(f).map_err(|e| format!("encode: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

/// Extract workbook_id from a save body's `<script id="wb-meta">`
/// JSON. Returns None for fresh-build workbooks that haven't been
/// saved yet (no wb-meta) or malformed inputs.
pub fn workbook_id_from_save_body(body: &[u8]) -> Option<String> {
    // wb-meta is a small JSON inside a known script id. We don't
    // need a full HTML parser — find the id, find the closing tag.
    let html = std::str::from_utf8(body).ok()?;
    let needle = r#"<script id="wb-meta""#;
    let start = html.find(needle)?;
    let after_open = html[start..].find('>').map(|i| start + i + 1)?;
    let rel_close = html[after_open..].find("</script>")?;
    let json = &html[after_open..after_open + rel_close];
    let parsed: serde_json::Value = serde_json::from_str(json).ok()?;
    parsed
        .get("workbook_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Append a save record. Idempotent on duplicate sha256 (e.g. a
/// resave with no changes won't grow the saves list — we still
/// update last_save though, as a heartbeat).
pub fn record_save(
    workbook_id: &str,
    file_path: &Path,
    file_sha256: &str,
    size: u64,
) -> Result<(), String> {
    let mut f = load();
    let now = iso8601_now();
    let path_str = file_path.display().to_string();

    let history = f
        .by_id
        .entry(workbook_id.to_string())
        .or_insert_with(|| WorkbookHistory {
            workbook_id: workbook_id.to_string(),
            first_seen: now.clone(),
            last_save: now.clone(),
            paths_seen: vec![],
            saves: vec![],
        });
    history.last_save = now.clone();
    if !history.paths_seen.iter().any(|p| p == &path_str) {
        history.paths_seen.push(path_str.clone());
    }

    // Skip duplicate-content saves (same hash as the most recent
    // entry) so a save-without-changes doesn't bloat the ledger.
    let dup = history
        .saves
        .last()
        .map(|e| e.file_sha256 == file_sha256 && e.file_path == path_str)
        .unwrap_or(false);
    if !dup {
        history.saves.push(LedgerEntry {
            ts: now,
            file_path: path_str,
            file_sha256: file_sha256.to_string(),
            size,
        });
    }
    if history.saves.len() > MAX_SAVES_PER_WORKBOOK {
        let drop_n = history.saves.len() - MAX_SAVES_PER_WORKBOOK;
        history.saves.drain(0..drop_n);
    }

    // Cap total workbook count — evict oldest by last_save.
    if f.by_id.len() > MAX_WORKBOOKS {
        let mut entries: Vec<(String, String)> = f
            .by_id
            .iter()
            .map(|(k, v)| (k.clone(), v.last_save.clone()))
            .collect();
        entries.sort_by(|a, b| a.1.cmp(&b.1));
        let to_remove: Vec<String> = entries
            .into_iter()
            .take(f.by_id.len() - MAX_WORKBOOKS)
            .map(|(k, _)| k)
            .collect();
        for k in to_remove {
            f.by_id.remove(&k);
        }
    }

    store(&f)
}

pub fn for_workbook(workbook_id: &str) -> Option<WorkbookHistory> {
    let f = load();
    f.by_id.get(workbook_id).cloned()
}

fn iso8601_now() -> String {
    // Same formatter as audit_log uses in main.rs. Duplicated here
    // so the ledger module stays self-contained — both call sites
    // use it the same way and the format is stable across them.
    use std::time::SystemTime;
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
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
