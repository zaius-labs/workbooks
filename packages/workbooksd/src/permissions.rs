// Per-workbook permissions — declared by the author in
// `workbook.config.mjs`'s `permissions` block, baked into the
// served HTML's `<meta name="wb-permissions">` tag, parsed by the
// daemon on serve, and gated on user approval before sensitive
// endpoints (initially: /agent/*) accept requests.
//
// Workbooks that don't declare permissions get a transparent-pass —
// the daemon doesn't gate anything. This keeps every workbook ever
// shipped before this feature working.
//
// Approvals are persisted in a small JSON file:
//
//   ~/Library/Application Support/sh.workbooks.workbooksd/approvals.json
//   ~/.local/share/workbooksd/approvals.json                    (Linux)
//
// Keyed by `path-fingerprint(workbook canonical path)` so a user can
// approve a workbook once and have the dialog stay dismissed across
// sessions. Moving the file = re-prompting; same logic the keychain
// uses for secrets.

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

/// All permission ids the schema knows about. Adding a new one means
/// updating cli/util/config.mjs's KNOWN set + adding handling here +
/// the dialog UI.
#[derive(Clone, Debug, Default)]
pub struct Permissions {
    /// Map of permission id → declared "why" string. Empty map means
    /// the workbook didn't declare permissions; daemon does NOT gate.
    pub by_id: HashMap<String, String>,
}

impl Permissions {
    pub fn is_declared(&self, id: &str) -> bool {
        self.by_id.contains_key(id)
    }
    pub fn ids(&self) -> Vec<String> {
        let mut v: Vec<String> = self.by_id.keys().cloned().collect();
        v.sort();
        v
    }
}

#[derive(Serialize)]
pub struct PermissionDecl {
    pub id: String,
    pub reason: String,
}

#[derive(Serialize)]
pub struct PermissionsList {
    /// Everything the workbook author declared.
    pub requested: Vec<PermissionDecl>,
    /// Subset the user has already approved (persisted across
    /// sessions).
    pub granted: Vec<String>,
    /// Convenience flag — true iff there are unresolved requests
    /// that should pop the dialog. (Equivalent to
    /// `requested.len() > granted.len()`.)
    pub needs_approval: bool,
}

#[derive(Deserialize)]
pub struct ApproveReq {
    /// Permission ids the user accepted. The daemon stores the
    /// intersection with the workbook's declared set — clients
    /// can't grant themselves anything that wasn't requested.
    pub ids: Vec<String>,
}

/// Parse `<meta name="wb-permissions" content="<base64-json>">` out
/// of the served HTML. JSON shape: `{ "<id>": { "reason": "..." } }`.
pub fn parse_from_html(html: &str) -> Permissions {
    let needle = r#"<meta name="wb-permissions" content="#;
    let Some(start) = html.find(needle) else {
        return Permissions::default();
    };
    let after = start + needle.len();
    let Some(quote) = html.as_bytes().get(after).copied() else {
        return Permissions::default();
    };
    if quote != b'"' && quote != b'\'' {
        return Permissions::default();
    }
    let value_start = after + 1;
    let Some(close) = html[value_start..].find(quote as char) else {
        return Permissions::default();
    };
    let b64 = &html[value_start..value_start + close];
    let bytes = match crate::decode_base64(b64) {
        Ok(b) => b,
        Err(_) => return Permissions::default(),
    };
    let Ok(json) = std::str::from_utf8(&bytes) else { return Permissions::default(); };
    let Ok(parsed): Result<HashMap<String, serde_json::Value>, _> = serde_json::from_str(json) else {
        return Permissions::default();
    };
    let mut by_id = HashMap::new();
    for (id, decl) in parsed {
        let reason = decl
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("(no reason provided)")
            .to_string();
        by_id.insert(id, reason);
    }
    Permissions { by_id }
}

/// Path-fingerprint the same way secrets do, so the approvals file
/// is keyed consistently across the codebase. We re-import the
/// helper from the secrets path via main.rs. To avoid coupling we
/// duplicate the tiny std-hash here — it's intentionally
/// non-cryptographic.
fn path_fingerprint(path: &Path) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn approvals_file() -> PathBuf {
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
    p.push("approvals.json");
    p
}

#[derive(Default, Serialize, Deserialize)]
struct ApprovalsFile {
    /// path-fingerprint → list of granted permission ids. Kept for
    /// back-compat with workbooks-without-wb-meta and for files
    /// that haven't yet had a first save (no workbook_id assigned).
    granted: HashMap<String, Vec<String>>,
    /// workbook_id → list of granted permission ids. The PRIMARY
    /// index for substrate workbooks. Survives macOS' "(1) (2)"
    /// rename pattern and any other path change — the user grants
    /// once, every copy on this machine inherits the approval.
    #[serde(default)]
    granted_by_id: HashMap<String, Vec<String>>,
}

fn load_approvals() -> ApprovalsFile {
    let path = approvals_file();
    let Ok(s) = std::fs::read_to_string(&path) else { return ApprovalsFile::default(); };
    serde_json::from_str(&s).unwrap_or_default()
}

fn store_approvals(a: &ApprovalsFile) -> Result<(), String> {
    let path = approvals_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(a)
        .map_err(|e| format!("encode approvals: {e}"))?;
    // Atomic write: tmp file + rename.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

/// Resolve grants for this workbook. When workbook_id is known
/// AND a workbook_id-keyed entry exists for it, that entry is
/// AUTHORITATIVE — path-keyed entries are ignored. This keeps
/// revocation semantics clean: revoking once on any copy clears
/// the grant for every copy, no orphan path-keyed leaks.
///
/// If id-keyed is not yet established (first-grant case, or
/// a workbook without wb-meta), fall back to path-keyed for
/// back-compat with 0.1.x sessions.
fn merged_granted(
    approvals: &ApprovalsFile,
    workbook_path: &Path,
    workbook_id: Option<&str>,
    declared: &std::collections::HashSet<&str>,
) -> Vec<String> {
    let mut out: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    if let Some(id) = workbook_id {
        if let Some(v) = approvals.granted_by_id.get(id) {
            for g in v {
                if declared.contains(g.as_str()) { out.insert(g.clone()); }
            }
            return out.into_iter().collect();   // id index wins, no fallback
        }
    }
    // Legacy path: pre-substrate workbook OR a workbook whose
    // first approval predates this fix. Reads the path-keyed
    // store; the next approve/revoke migrates it into id-keyed.
    let path_key = path_fingerprint(workbook_path);
    if let Some(v) = approvals.granted.get(&path_key) {
        for g in v {
            if declared.contains(g.as_str()) { out.insert(g.clone()); }
        }
    }
    out.into_iter().collect()
}

pub fn list_for(
    workbook_path: &Path,
    workbook_id: Option<&str>,
    perms: &Permissions,
) -> PermissionsList {
    let approvals = load_approvals();
    let declared: std::collections::HashSet<&str> =
        perms.by_id.keys().map(|s| s.as_str()).collect();
    let granted = merged_granted(&approvals, workbook_path, workbook_id, &declared);

    let mut requested: Vec<PermissionDecl> = perms
        .by_id
        .iter()
        .map(|(id, reason)| PermissionDecl {
            id: id.clone(),
            reason: reason.clone(),
        })
        .collect();
    requested.sort_by(|a, b| a.id.cmp(&b.id));

    let needs_approval = !requested.is_empty() && granted.len() < requested.len();
    PermissionsList { requested, granted, needs_approval }
}

pub fn approve(
    workbook_path: &Path,
    workbook_id: Option<&str>,
    perms: &Permissions,
    requested_ids: &[String],
) -> Result<PermissionsList, String> {
    let mut approvals = load_approvals();
    let declared: std::collections::HashSet<&str> =
        perms.by_id.keys().map(|s| s.as_str()).collect();
    // Filter to declared-only — clients can't grant themselves
    // permissions the workbook didn't ask for.
    let to_add: Vec<String> = requested_ids
        .iter()
        .filter(|id| declared.contains(id.as_str()))
        .cloned()
        .collect();

    // Write to the id-keyed index when workbook_id is known.
    // Otherwise (no wb-meta yet) fall back to path-keyed — the
    // first save will mint a workbook_id, and the next approve
    // after that will migrate to id-keyed semantics. UNION
    // semantic per index so per-row Allow buttons compose.
    if let Some(id) = workbook_id {
        let mut id_set: std::collections::BTreeSet<String> = approvals
            .granted_by_id
            .get(id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect();
        for g in &to_add { id_set.insert(g.clone()); }
        approvals.granted_by_id.insert(id.to_string(), id_set.into_iter().collect());
    } else {
        let path_key = path_fingerprint(workbook_path);
        let mut path_set: std::collections::BTreeSet<String> = approvals
            .granted
            .get(&path_key)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect();
        for g in &to_add { path_set.insert(g.clone()); }
        approvals.granted.insert(path_key, path_set.into_iter().collect());
    }

    store_approvals(&approvals)?;
    Ok(list_for(workbook_path, workbook_id, perms))
}

/// Remove the given ids from this workbook's granted lists. Hits
/// BOTH indexes — otherwise revoke at one path would leak inheritance
/// to other copies via the id index. Idempotent.
pub fn revoke(
    workbook_path: &Path,
    workbook_id: Option<&str>,
    perms: &Permissions,
    ids_to_revoke: &[String],
) -> Result<PermissionsList, String> {
    let mut approvals = load_approvals();
    let path_key = path_fingerprint(workbook_path);
    if let Some(granted) = approvals.granted.get_mut(&path_key) {
        granted.retain(|g| !ids_to_revoke.iter().any(|x| x == g));
    }
    if let Some(id) = workbook_id {
        if let Some(granted) = approvals.granted_by_id.get_mut(id) {
            granted.retain(|g| !ids_to_revoke.iter().any(|x| x == g));
        }
    }
    store_approvals(&approvals)?;
    Ok(list_for(workbook_path, workbook_id, perms))
}

/// Returns true if `id` is granted for this workbook (or if the
/// workbook didn't declare the permission, in which case the
/// daemon doesn't gate). Same authority order as `merged_granted`:
/// id-keyed wins when present, path-keyed is fallback for legacy.
pub fn is_allowed(
    id: &str,
    workbook_path: &Path,
    workbook_id: Option<&str>,
    perms: &Permissions,
) -> bool {
    if !perms.is_declared(id) {
        return true; // no declaration → no gate
    }
    let approvals = load_approvals();
    if let Some(wid) = workbook_id {
        if let Some(v) = approvals.granted_by_id.get(wid) {
            return v.iter().any(|s| s == id);
        }
    }
    let path_key = path_fingerprint(workbook_path);
    approvals
        .granted
        .get(&path_key)
        .map(|v| v.iter().any(|s| s == id))
        .unwrap_or(false)
}
