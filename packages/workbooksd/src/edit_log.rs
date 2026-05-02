// In-file edit log — `<script id="wb-edit-log" type="application/json">`.
//
// The companion to the per-machine ledger (ledger.rs). Where the
// ledger lives in `~/Library/Application Support/...` and is the
// view of "what's happened to this workbook ON THIS MACHINE", the
// edit log is INSIDE the .workbook.html file and TRAVELS WITH IT.
// Send a workbook to a coworker, the log goes too — they can see
// "saved 14 times, last 6 by claude, before that codex, before that
// human." No CAI/PKI required for v1; per-machine ed25519 signatures
// land later in core-5ah.10 to make entries non-repudiable.
//
// Design choices:
//   • Block lives right after <script id="wb-meta">. If wb-meta is
//     absent, we skip the log too — without a workbook_id, the file
//     isn't a substrate workbook and the log has nowhere to belong.
//   • JSON, not CBOR/JOSE, because the file is already HTML and a
//     human can read the array with View Source.
//   • Capped at the last 500 entries (FIFO). At 500 saves a workbook
//     gets ~75 KB of log overhead — negligible vs the 21 MB runtime.
//   • Daemon writes; the page never has to. A page that authored
//     itself can't be trusted to truthfully record its own actions.
//
// Entry shape (kept small on purpose):
//   { ts, agent, sha256_after, size_after }
// where `agent` is "human" | "claude" | "codex" | "native" |
// "unknown". The daemon picks `agent` from an `x-wb-agent` header
// the SDK sets per save; missing/unrecognized falls back to
// "unknown" rather than failing.

use serde::{Deserialize, Serialize};

const MAX_ENTRIES: usize = 500;
const TAG_OPEN: &str = r#"<script id="wb-edit-log" type="application/json">"#;
const TAG_CLOSE: &str = "</script>";
const META_TAG_OPEN_NEEDLE: &str = r#"<script id="wb-meta""#;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Entry {
    pub ts: String,
    pub agent: String,
    pub sha256_after: String,
    pub size_after: u64,
}

/// Normalize whatever the SDK sent into our small enum-as-string
/// surface. Anything we don't recognize becomes "unknown" so a
/// malicious page can't smuggle a hand-crafted "agent": value into
/// the log.
pub fn normalize_agent(raw: Option<&str>) -> String {
    match raw.unwrap_or("").trim() {
        "human" => "human".into(),
        "claude" => "claude".into(),
        "codex" => "codex".into(),
        "native" => "native".into(),
        _ => "unknown".into(),
    }
}

/// Parse the existing log, if any, from a save body. Missing /
/// malformed both return Vec::new(); we never refuse a save just
/// because the log can't be parsed (data preservation > log purity).
pub fn parse_existing(body: &[u8]) -> Vec<Entry> {
    let html = match std::str::from_utf8(body) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let Some(start) = html.find(TAG_OPEN) else { return Vec::new(); };
    let after_open = start + TAG_OPEN.len();
    let Some(rel_close) = html[after_open..].find(TAG_CLOSE) else { return Vec::new(); };
    let json = &html[after_open..after_open + rel_close];
    serde_json::from_str(json).unwrap_or_default()
}

/// Serialize the log array as HTML-safe JSON (escapes `<` so a
/// pathological `</script>` substring inside any string value can't
/// terminate the script block early). The escaping is the standard
/// "JSON in HTML" trick: `<` survives JSON.parse and renders
/// the same character.
fn encode_html_safe(entries: &[Entry]) -> String {
    let raw = serde_json::to_string(entries).unwrap_or_else(|_| "[]".into());
    raw.replace('<', "\\u003c")
}

/// Build the rewritten body using a CALLER-PROVIDED prior log.
/// Daemon passes the log it parsed from the on-disk file (last
/// persisted version) so the log is tamper-evident: a page can't
/// drop entries by simply omitting the script block from its save
/// body. Same HTML otherwise, with the log either replaced or
/// inserted right after `<script id="wb-meta">`. If wb-meta is
/// missing, the body is returned unchanged.
pub fn rewrite_with_log(body: &[u8], prior: Vec<Entry>, new_entry: Entry) -> Vec<u8> {
    rewrite_internal(body, prior, new_entry)
}

/// Convenience wrapper for tests / tools that don't have a separate
/// prior source — parses prior entries from `body` itself. Production
/// daemon code should use `rewrite_with_log`.
pub fn rewrite_with_appended(body: &[u8], new_entry: Entry) -> Vec<u8> {
    let prior = parse_existing(body);
    rewrite_internal(body, prior, new_entry)
}

fn rewrite_internal(body: &[u8], mut entries: Vec<Entry>, new_entry: Entry) -> Vec<u8> {
    let html = match std::str::from_utf8(body) {
        Ok(s) => s,
        // Binary body — bail; daemon will atomic_write the original.
        // (No real workbook is non-UTF8, but defend anyway.)
        Err(_) => return body.to_vec(),
    };

    // No wb-meta → not a substrate workbook → don't add a log.
    if !html.contains(META_TAG_OPEN_NEEDLE) {
        return body.to_vec();
    }

    entries.push(new_entry);
    if entries.len() > MAX_ENTRIES {
        let drop_n = entries.len() - MAX_ENTRIES;
        entries.drain(0..drop_n);
    }
    let json = encode_html_safe(&entries);
    let new_block = format!("{TAG_OPEN}{json}{TAG_CLOSE}");

    // Replace existing block in place if present.
    if let Some(start) = html.find(TAG_OPEN) {
        let after_open = start + TAG_OPEN.len();
        if let Some(rel_close) = html[after_open..].find(TAG_CLOSE) {
            let end = after_open + rel_close + TAG_CLOSE.len();
            let mut out = String::with_capacity(html.len() + new_block.len());
            out.push_str(&html[..start]);
            out.push_str(&new_block);
            out.push_str(&html[end..]);
            return out.into_bytes();
        }
    }

    // No prior block — insert right after `</script>` of wb-meta.
    // Find the `<script id="wb-meta"` open tag, then the FIRST
    // `</script>` after it.
    let Some(meta_open) = html.find(META_TAG_OPEN_NEEDLE) else {
        return body.to_vec();
    };
    let Some(meta_close_rel) = html[meta_open..].find("</script>") else {
        return body.to_vec();
    };
    let insert_at = meta_open + meta_close_rel + "</script>".len();

    let mut out = String::with_capacity(html.len() + new_block.len() + 1);
    out.push_str(&html[..insert_at]);
    out.push('\n');
    out.push_str(&new_block);
    out.push_str(&html[insert_at..]);
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(ts: &str, agent: &str, sha: &str) -> Entry {
        Entry {
            ts: ts.into(),
            agent: agent.into(),
            sha256_after: sha.into(),
            size_after: 0,
        }
    }

    const META: &str = r#"<script id="wb-meta" type="application/json">{"workbook_id":"x","compaction_seq":0,"snapshot_cid_by_target":{}}</script>"#;

    #[test]
    fn inserts_after_meta_when_absent() {
        let body = format!("<!doctype html><html><head>{META}</head><body></body></html>");
        let out = rewrite_with_appended(body.as_bytes(), entry("t1", "claude", "abc"));
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains(r#"<script id="wb-edit-log" type="application/json">"#));
        let parsed = parse_existing(s.as_bytes());
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].agent, "claude");
    }

    #[test]
    fn appends_to_existing_block() {
        let body = format!("<!doctype html><html><head>{META}</head><body></body></html>");
        let one = rewrite_with_appended(body.as_bytes(), entry("t1", "human", "a"));
        let two = rewrite_with_appended(&one, entry("t2", "claude", "b"));
        let parsed = parse_existing(&two);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].agent, "human");
        assert_eq!(parsed[1].agent, "claude");
    }

    #[test]
    fn skips_when_no_meta() {
        let body = b"<!doctype html><html><body>plain</body></html>";
        let out = rewrite_with_appended(body, entry("t1", "human", "a"));
        assert_eq!(out, body);
    }

    #[test]
    fn caps_at_max_entries() {
        let body = format!("<!doctype html><html><head>{META}</head><body></body></html>");
        let mut bytes = body.into_bytes();
        for i in 0..(MAX_ENTRIES + 5) {
            bytes = rewrite_with_appended(&bytes, entry(&format!("t{i}"), "native", "x"));
        }
        let parsed = parse_existing(&bytes);
        assert_eq!(parsed.len(), MAX_ENTRIES);
        // Oldest entries should have been dropped — first remaining ts is "t5".
        assert_eq!(parsed[0].ts, "t5");
    }

    #[test]
    fn escapes_close_script_in_values() {
        let body = format!("<!doctype html><html><head>{META}</head><body></body></html>");
        // sha containing the hostile substring; an unescaped serializer
        // would let this terminate the <script> block.
        let out = rewrite_with_appended(body.as_bytes(), entry("t1", "human", "</script>"));
        let s = String::from_utf8(out).unwrap();
        assert!(!s.contains(r#""</script>""#));
        assert!(s.contains(r#"</script>"#));
        let parsed = parse_existing(s.as_bytes());
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].sha256_after, "</script>");
    }
}
