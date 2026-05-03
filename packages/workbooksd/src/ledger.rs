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
    /// Who saved this — "claude" / "codex" / "human" / "native" /
    /// "unknown". Surfaced in the manager so users see at a glance
    /// who last touched a workbook. Optional for backwards compat
    /// with pre-`agent` ledger files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
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
    agent: Option<&str>,
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
            agent: agent.map(str::to_string),
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

/// Compact summary used by the Workbooks Manager's index view.
/// Drops the full saves[] array (~1KB per save) for an O(1)-per-
/// workbook payload — the manager fetches this for its list, then
/// drills into for_workbook() when the user clicks through.
#[derive(Clone, Debug, Serialize)]
pub struct WorkbookSummary {
    pub workbook_id: String,
    pub first_seen: String,
    pub last_save: String,
    pub paths_seen: Vec<String>,
    pub save_count: usize,
    pub latest_path: Option<String>,
    pub latest_size: u64,
    pub latest_sha: String,
    pub latest_agent: Option<String>,
    /// Set when this workbook's first save sha matches a save in
    /// some other workbook that predates it — meaning whoever
    /// started this workbook started from a copy of that one.
    /// `None` for genuinely-fresh workbooks.
    pub forked_from: Option<ForkRef>,
    /// How many other workbooks were spawned from this one (i.e.
    /// how many workbooks have this workbook in their `forked_from`).
    pub fork_count: usize,
}

/// Compact ancestry pointer attached to a forked workbook.
#[derive(Clone, Debug, Serialize)]
pub struct ForkRef {
    pub parent_workbook_id: String,
    /// Timestamp of the parent's save whose content matched this
    /// workbook's first save — i.e. the moment of the fork.
    pub parent_save_ts: String,
    /// Latest path of the parent — lets the manager show
    /// "forked from foo.html" without an extra lookup.
    pub parent_path: Option<String>,
}

pub fn list_summaries() -> Vec<WorkbookSummary> {
    let mut f = load();

    // Auto-prune: drop any workbook whose paths_seen all resolve to
    // non-existent files. Test fixtures (every E2E test creates
    // entries in /tmp/, those tmp dirs vanish after the test process
    // exits) and one-shot temp workbooks leave the ledger littered
    // otherwise — the manager UI fills with cards for dead files.
    // We do this on the read path so the user never sees them, and
    // also persist the pruned ledger so future reads are fast and
    // cross-tool callers (the GET /ledger/<id> endpoint, the manager,
    // etc.) all see consistent state.
    //
    // Done in-place to avoid a redundant clone of the whole map.
    // We also prune saves[] within remaining entries — a workbook
    // saved many times across paths can have entries pointing at
    // gone-tmp paths even when at least one canonical path remains.
    let before = f.by_id.len();
    f.by_id.retain(|_, h| {
        h.paths_seen.retain(|p| std::path::Path::new(p).exists());
        h.saves.retain(|s| std::path::Path::new(&s.file_path).exists());
        !h.paths_seen.is_empty()
    });
    if f.by_id.len() != before {
        // Best-effort persist; if write fails the in-memory view is
        // still pruned for this call, and the next list_summaries()
        // will re-prune.
        let _ = store(&f);
    }

    // First pass: build a sha → [(workbook_id, save_ts)] index over
    // EVERY save in the ledger. This is the substrate fork-detection
    // runs over: when workbook B's first save sha matches workbook
    // A's third save sha, B was forked from A at A's third save.
    // O(total_saves), and total_saves is capped (10k workbooks ×
    // 2k saves max), so this is fine to run on every list call.
    let mut sha_index: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for h in f.by_id.values() {
        for s in &h.saves {
            sha_index
                .entry(s.file_sha256.clone())
                .or_default()
                .push((h.workbook_id.clone(), s.ts.clone()));
        }
    }

    // Second pass: for each workbook, look up its first save's sha
    // in the index. Any match in *another* workbook whose save
    // predates this workbook's first save is a candidate parent.
    // Pick the most recent qualifying parent save (latest ts ≤
    // ours) — that's the closest ancestor in time.
    let latest_path_by_id: HashMap<String, Option<String>> = f
        .by_id
        .iter()
        .map(|(k, h)| (k.clone(), h.saves.last().map(|s| s.file_path.clone())))
        .collect();

    let mut forked_from: HashMap<String, ForkRef> = HashMap::new();
    let mut fork_count: HashMap<String, usize> = HashMap::new();

    for h in f.by_id.values() {
        let Some(first) = h.saves.first() else { continue };
        let Some(matches) = sha_index.get(&first.file_sha256) else { continue };
        let parent = matches
            .iter()
            .filter(|(wid, ts)| wid != &h.workbook_id && ts.as_str() <= first.ts.as_str())
            .max_by(|a, b| a.1.cmp(&b.1));
        if let Some((pid, pts)) = parent {
            forked_from.insert(
                h.workbook_id.clone(),
                ForkRef {
                    parent_workbook_id: pid.clone(),
                    parent_save_ts: pts.clone(),
                    parent_path: latest_path_by_id.get(pid).cloned().flatten(),
                },
            );
            *fork_count.entry(pid.clone()).or_insert(0) += 1;
        }
    }

    let mut out: Vec<WorkbookSummary> = f
        .by_id
        .into_values()
        .map(|h| {
            let last = h.saves.last();
            let id = h.workbook_id.clone();
            WorkbookSummary {
                workbook_id: h.workbook_id,
                first_seen: h.first_seen,
                last_save: h.last_save,
                paths_seen: h.paths_seen,
                save_count: h.saves.len(),
                latest_path: last.map(|s| s.file_path.clone()),
                latest_size: last.map(|s| s.size).unwrap_or(0),
                latest_sha: last.map(|s| s.file_sha256.clone()).unwrap_or_default(),
                latest_agent: last.and_then(|s| s.agent.clone()),
                forked_from: forked_from.remove(&id),
                fork_count: fork_count.get(&id).copied().unwrap_or(0),
            }
        })
        .collect();
    // Most recently-touched first. Lexicographic on ISO 8601 = chrono.
    out.sort_by(|a, b| b.last_save.cmp(&a.last_save));
    out
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
