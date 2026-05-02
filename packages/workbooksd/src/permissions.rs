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
    /// path-fingerprint → list of granted permission ids
    granted: HashMap<String, Vec<String>>,
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

pub fn list_for(workbook_path: &Path, perms: &Permissions) -> PermissionsList {
    let key = path_fingerprint(workbook_path);
    let approvals = load_approvals();
    let granted_all: Vec<String> = approvals.granted.get(&key).cloned().unwrap_or_default();

    let requested: Vec<PermissionDecl> = perms
        .by_id
        .iter()
        .map(|(id, reason)| PermissionDecl {
            id: id.clone(),
            reason: reason.clone(),
        })
        .collect();
    let mut requested = requested;
    requested.sort_by(|a, b| a.id.cmp(&b.id));

    // Filter granted to only what's still requested — if a workbook
    // shrank its declared set, we don't surface stale grants.
    let declared: std::collections::HashSet<&str> =
        perms.by_id.keys().map(|s| s.as_str()).collect();
    let granted: Vec<String> = granted_all
        .into_iter()
        .filter(|g| declared.contains(g.as_str()))
        .collect();

    let needs_approval = !requested.is_empty() && granted.len() < requested.len();
    PermissionsList { requested, granted, needs_approval }
}

pub fn approve(
    workbook_path: &Path,
    perms: &Permissions,
    requested_ids: &[String],
) -> Result<PermissionsList, String> {
    let key = path_fingerprint(workbook_path);
    let mut approvals = load_approvals();
    let declared: std::collections::HashSet<&str> =
        perms.by_id.keys().map(|s| s.as_str()).collect();
    // Only persist ids that the workbook actually declared. The
    // browser can't grant itself permissions the workbook didn't
    // ask for.
    let granted: Vec<String> = requested_ids
        .iter()
        .filter(|id| declared.contains(id.as_str()))
        .cloned()
        .collect();
    approvals.granted.insert(key, granted);
    store_approvals(&approvals)?;
    Ok(list_for(workbook_path, perms))
}

/// Returns true if `id` is granted for this workbook (or if the
/// workbook didn't declare the permission, in which case the
/// daemon doesn't gate). Used by enforcement points — e.g. /agent/*
/// calls `is_allowed("agents", path, &perms)?`.
pub fn is_allowed(id: &str, workbook_path: &Path, perms: &Permissions) -> bool {
    if !perms.is_declared(id) {
        return true; // no declaration → no gate
    }
    let key = path_fingerprint(workbook_path);
    let approvals = load_approvals();
    approvals
        .granted
        .get(&key)
        .map(|v| v.iter().any(|s| s == id))
        .unwrap_or(false)
}
