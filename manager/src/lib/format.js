// Pure formatting helpers — used by every component that wants to
// render a save / agent / time. Centralized so the wording is
// consistent everywhere ("Edited by Claude Code, 2 minutes ago"
// shouldn't have a different shape in the inspector vs. the
// graph row).

const AGENT_LABELS = {
  human:   "you",
  claude:  "Claude Code",
  codex:   "Codex",
  native:  "the built-in agent",
  unknown: "an unknown source",
};

/** Friendly agent name — sentence-case, the ID we audit-logged
 *  is shorthand for the model/CLI behind it. */
export function agentName(raw) {
  if (!raw) return AGENT_LABELS.unknown;
  return AGENT_LABELS[raw.toLowerCase()] ?? raw;
}

/** Short-form sidebar/row variant — lowercased one-word. */
export function agentShort(raw) {
  return (raw ?? "unknown").toLowerCase();
}

/** Compact relative time — `now`, `2m`, `3h`, `4d`, then the
 *  date. Used in tight UI like graph rows + sidebar. */
export function ago(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 30) return "now";
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(t).toLocaleDateString();
}

/** Long-form relative time — "2 minutes ago", "3 hours ago",
 *  used in the inspector where we have room. */
export function agoLong(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 30) return "just now";
  if (s < 60) return "less than a minute ago";
  if (s < 120) return "1 minute ago";
  if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
  if (s < 7200) return "1 hour ago";
  if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
  if (s < 86400 * 2) return "1 day ago";
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} days ago`;
  if (s < 86400 * 14) return "1 week ago";
  if (s < 86400 * 30) return `${Math.floor(s / 86400 / 7)} weeks ago`;
  return new Date(t).toLocaleDateString();
}

/** Human-readable byte counts for inspector-side details. */
export function fmtBytes(n) {
  if (typeof n !== "number") return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Signed delta — "+4.2 KB", "-1.1 KB", "no change". */
export function fmtDelta(curr, prev) {
  if (typeof curr !== "number" || typeof prev !== "number") return "";
  const d = curr - prev;
  if (d === 0) return "no change in size";
  const sign = d > 0 ? "+" : "−";
  const abs = Math.abs(d);
  if (abs < 1024) return `${sign}${abs} B`;
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KB`;
  return `${sign}${(abs / 1024 / 1024).toFixed(2)} MB`;
}

/** Time gap in human form — "20 seconds later", "3 hours later",
 *  "the next day". */
export function fmtGap(currIso, prevIso) {
  if (!currIso || !prevIso) return "";
  const dt = (Date.parse(currIso) - Date.parse(prevIso)) / 1000;
  if (Number.isNaN(dt) || dt <= 0) return "";
  if (dt < 30) return "moments later";
  if (dt < 60) return `${Math.floor(dt)} seconds later`;
  if (dt < 120) return "1 minute later";
  if (dt < 3600) return `${Math.floor(dt / 60)} minutes later`;
  if (dt < 7200) return "1 hour later";
  if (dt < 86400) return `${Math.floor(dt / 3600)} hours later`;
  if (dt < 86400 * 2) return "the next day";
  if (dt < 86400 * 30) return `${Math.floor(dt / 86400)} days later`;
  return `${Math.floor(dt / 86400 / 7)} weeks later`;
}

/** Replace /Users/<name>/ with ~/ for compactness. */
export function homeify(p) { return (p ?? "").replace(/^\/Users\/[^/]+/, "~"); }

/** File basename. */
export function basename(p) {
  if (!p) return "—";
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}
