// Inspect page — parses a .html (and optionally a .c2pa
// sidecar) entirely client-side and renders the workbook's identity
// + edit log + signature info. Nothing is uploaded; the user can
// verify by opening Network tab. Pure vanilla JS, no build step,
// no deps.

const dz = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const browseBtn = document.getElementById("browse-btn");
const report = document.getElementById("report");

const kv = {
  id: document.getElementById("kv-id"),
  file: document.getElementById("kv-file"),
  size: document.getElementById("kv-size"),
  sha: document.getElementById("kv-sha"),
};
const timelineEl = document.getElementById("timeline");
const logMeta = document.getElementById("log-meta");
const c2paMeta = document.getElementById("c2pa-meta");
const c2paDetail = document.getElementById("c2pa-detail");

[
  ["dragenter", true],
  ["dragover",  true],
  ["dragleave", false],
  ["drop",      false],
].forEach(([ev, hi]) => {
  dz.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    dz.classList.toggle("drag-over", hi);
  });
});
dz.addEventListener("drop", (e) => handleFiles(e.dataTransfer?.files ?? []));
browseBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => handleFiles(e.target.files ?? []));

async function handleFiles(fileList) {
  const files = Array.from(fileList ?? []);
  if (files.length === 0) return;

  const htmlFiles = files.filter((f) => !f.name.endsWith(".c2pa"));
  const c2pa = files.find((f) => f.name.endsWith(".c2pa"));

  clearError();

  if (htmlFiles.length === 0) {
    showError("No .html in the drop. Add the HTML file too — the .c2pa sidecar alone doesn't carry the edit log.");
    return;
  }

  // Parse every dropped HTML file. We then group by workbook_id —
  // multiple drops with the same id are treated as DIVERGENT COPIES
  // of the same workbook (e.g. user duplicated the file, edited
  // both, wants to see what diverged). Identical sha256_after =
  // identical save (dedupe); different sha after a common ancestor
  // = a fork point we surface in the timeline.
  const parsedAll = [];
  for (const f of htmlFiles) {
    let bytes;
    try { bytes = new Uint8Array(await f.arrayBuffer()); }
    catch (e) {
      showError(`Couldn't read ${f.name}: ${e?.message ?? e}`);
      return;
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const parsed = parseWorkbook(text);
    parsed.fileName = f.name;
    parsed.fileSize = f.size;
    parsed.fileSha = await sha256Hex(bytes);
    parsedAll.push(parsed);
  }

  // Group by workbook_id. Files without one form their own
  // singleton groups (each one rendered alone).
  const groups = new Map();
  for (const p of parsedAll) {
    const key = p.workbook_id ?? `__no-id__${p.fileName}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  report.hidden = false;

  // V1: render the FIRST group's identity in the kv card; the
  // timeline below shows the merged view. Multi-group drops show
  // a stacked list — each group as its own report-section.
  // (We're showing one card per dropped pair today; this could
  // grow into multi-card layout in a follow-up.)
  const primaryGroup = [...groups.values()][0];
  const primary = primaryGroup[0];

  kv.file.textContent = primaryGroup.length > 1
    ? `${primaryGroup.length} files (merged)`
    : primary.fileName;
  kv.size.textContent = primaryGroup.length > 1
    ? `${formatBytes(primaryGroup.reduce((n, p) => n + p.fileSize, 0))} across ${primaryGroup.length}`
    : formatBytes(primary.fileSize);
  kv.sha.textContent = primaryGroup.length > 1
    ? `${primaryGroup.length} distinct content hashes`
    : primary.fileSha;
  kv.id.textContent = primary.workbook_id ?? "(no wb-meta — file may predate the substrate)";

  renderTimeline(mergeEntries(primaryGroup));

  if (c2pa) {
    await renderC2pa(c2pa);
  } else {
    c2paMeta.hidden = false;
    c2paDetail.hidden = true;
    c2paMeta.textContent = "No .c2pa sidecar dropped — drop one alongside the workbook to see the signature.";
  }

  report.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Merge edit-log entries across multiple files of the same
 *  workbook_id. Dedupe by (ts, sha256_after) — identical content
 *  saved at the same instant is a single logical save (e.g. seen
 *  by both copies because we copied the file post-save). Sort by
 *  ts (lexicographic on ISO 8601 = chronological). Tag each entry
 *  with which file(s) it appeared in so the UI can highlight
 *  fork points (same ts, different sha = a divergence). */
function mergeEntries(group) {
  if (group.length === 1) return group[0].entries;
  const seen = new Map(); // key = ts + "|" + sha → entry-with-sources
  for (const file of group) {
    for (const e of file.entries ?? []) {
      const key = `${e.ts}|${e.sha256_after}`;
      if (!seen.has(key)) {
        seen.set(key, { ...e, _sources: new Set([file.fileName]) });
      } else {
        seen.get(key)._sources.add(file.fileName);
      }
    }
  }
  return [...seen.values()].sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
}

function parseWorkbook(text) {
  const out = { workbook_id: null, entries: [] };

  const metaMatch = text.match(/<script id="wb-meta"[^>]*>([\s\S]*?)<\/script>/);
  if (metaMatch) {
    try {
      const meta = JSON.parse(metaMatch[1]);
      if (typeof meta?.workbook_id === "string") out.workbook_id = meta.workbook_id;
    } catch {}
  }

  const logMatch = text.match(/<script id="wb-edit-log"[^>]*>([\s\S]*?)<\/script>/);
  if (logMatch) {
    try {
      // Daemon HTML-escapes < as < so any value containing
      // </script> can't terminate the block early. JSON.parse
      // round-trips the escape correctly (it sees the unicode
      // escape and produces the literal char).
      const arr = JSON.parse(logMatch[1]);
      if (Array.isArray(arr)) out.entries = arr;
    } catch {}
  }

  return out;
}

function renderTimeline(entries) {
  timelineEl.innerHTML = "";
  if (!entries || entries.length === 0) {
    logMeta.textContent = "This workbook has no edit log yet — the in-file `<script id=\"wb-edit-log\">` block lands on the first daemon-mediated save.";
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = "(no entries)";
    timelineEl.appendChild(empty);
    return;
  }

  // Detect fork points: two entries share a `ts` but have
  // different sha256_after. That means at the same instant the
  // workbook diverged (e.g. user edited two copies after a
  // common ancestor, then dropped both on this page). Fork rows
  // get a marker.
  const forkTimestamps = new Set();
  const byTs = new Map();
  for (const e of entries) {
    const arr = byTs.get(e.ts) ?? [];
    arr.push(e);
    byTs.set(e.ts, arr);
  }
  for (const [ts, arr] of byTs) {
    const shas = new Set(arr.map((e) => e.sha256_after));
    if (shas.size > 1) forkTimestamps.add(ts);
  }

  const totalSources = new Set();
  for (const e of entries) for (const s of e._sources ?? []) totalSources.add(s);
  const merged = totalSources.size > 1;
  logMeta.textContent = merged
    ? `${entries.length} save${entries.length === 1 ? "" : "s"} merged across ${totalSources.size} files — newest first` +
      (forkTimestamps.size > 0 ? `, ${forkTimestamps.size} fork point${forkTimestamps.size === 1 ? "" : "s"}.` : ".")
    : `${entries.length} save${entries.length === 1 ? "" : "s"} — newest first.`;

  for (const e of [...entries].reverse()) {
    const row = document.createElement("li");
    row.className = "timeline-row";
    if (forkTimestamps.has(e.ts)) row.classList.add("timeline-fork");

    const ts  = document.createElement("span"); ts.textContent = (e.ts ?? "").replace("T", " ").replace("Z", "");
    const tag = document.createElement("span");
    const agent = (e.agent ?? "unknown").toLowerCase();
    tag.className = `agent-tag agent-${agent}`;
    tag.textContent = agent;
    const sha = document.createElement("span"); sha.className = "timeline-sha";
    sha.textContent = (e.sha256_after ?? "").slice(0, 12) || "—";
    const size = document.createElement("span"); size.className = "timeline-size";
    size.textContent = typeof e.size_after === "number" ? formatBytes(e.size_after) : "";
    row.append(ts, tag, sha, size);

    // Source attribution: only show when merging > 1 file. A row
    // present in some-but-not-all sources is a divergent edit;
    // show its origin filename(s) so the user can tell which copy
    // it came from.
    if (merged && e._sources && e._sources.size < totalSources.size) {
      const src = document.createElement("div");
      src.className = "timeline-source";
      src.textContent = `from: ${[...e._sources].join(", ")}`;
      // Span the full row width below the main grid line.
      src.style.gridColumn = "1 / -1";
      row.appendChild(src);
    }

    timelineEl.appendChild(row);
  }
}

async function renderC2pa(file) {
  c2paMeta.hidden = true;
  c2paDetail.hidden = false;
  document.getElementById("c2pa-size").textContent = formatBytes(file.size);
  let buf;
  try { buf = new Uint8Array(await file.arrayBuffer()); } catch { return; }

  // JUMBF magic bytes — the C2PA manifest store wraps everything
  // in a JUMBF box hierarchy, top box of which is "jumb". The
  // bytes "jumb" appear at offset 4-8 of a JUMBF stream.
  const ascii = new TextDecoder("ascii").decode(buf.slice(0, 64));
  const hasJumbMagic = ascii.includes("jumb");
  document.getElementById("c2pa-magic").textContent =
    hasJumbMagic ? "✓ jumb (recognized JUMBF box)" : "(not detected — file may not be a c2pa manifest)";

  // Signer + alg detection. The cert is embedded in the manifest
  // as DER (binary OID-prefixed), so the literal "CN=" never
  // appears — but the CommonName VALUE ("workbooks-daemon") does
  // survive as bare bytes preceded by the length-prefix byte 0x10.
  // Scan the file for that string. When found we know the daemon
  // signed it (and therefore Ed25519); other signers fall through.
  const fullAscii = new TextDecoder("latin1").decode(buf);
  const isWorkbooks = fullAscii.includes("workbooks-daemon");
  document.getElementById("c2pa-alg").textContent =
    isWorkbooks ? "Ed25519 (workbooksd default)" : "(unknown — install c2patool to inspect)";
  document.getElementById("c2pa-signer").textContent =
    isWorkbooks ? "CN=workbooks-daemon (per-machine)" : "(non-workbooks signer — could be PKI-issued)";
}

async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function showError(msg) {
  let el = document.querySelector(".parse-error");
  if (!el) {
    el = document.createElement("div");
    el.className = "parse-error";
    report.parentNode.insertBefore(el, report);
  }
  el.textContent = msg;
  report.hidden = true;
}
function clearError() {
  const el = document.querySelector(".parse-error");
  if (el) el.remove();
}
