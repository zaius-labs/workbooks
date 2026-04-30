// Project export — packages the running workbook into a portable
// .zip suitable for re-opening on another machine.
//
// What lands in the zip
// ---------------------
//   <slug>.workbook.html     ← the FULL self-contained build with
//                              all wasm + runtime + skills inlined,
//                              edited to embed the user's current
//                              composition + asset registry as
//                              <wb-data> blocks.
//   assets/<sha256>.<ext>    ← media large enough that base64 in the
//                              HTML costs more than a sidecar file
//                              (default: anything > 100 KB).
//   manifest.json            ← format metadata (id ↔ asset hash
//                              mapping). Emitted by the packager for
//                              tooling. See core-mt6 successor bead
//                              re. making this optional.
//
// Why fetch the source instead of cloning document.documentElement
// ----------------------------------------------------------------
// document.documentElement.cloneNode(true) gives a snapshot of the
// LIVE rendered DOM — the SPA's mounted Svelte tree, the iframe's
// running playback state, etc. That snapshot doesn't match the
// portable build's structure. Fetching location.href returns the
// SOURCE HTML the browser loaded — the actual <slug>.workbook.html
// with its inlined wasm, bindgen, runtime bundle, and workbook spec
// blocks. We mutate that doc to inject current state, then package.

import { downloadWorkbookZip } from "@work.books/runtime/packageWorkbook";
import { composition } from "./composition.svelte.js";
import { assets } from "./assets.svelte.js";
import { snapshotForEmbed } from "./historyBackend.svelte.js";

function slug(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "hyperframes";
}

function detectSlugFromManifest() {
  if (typeof document === "undefined") return null;
  const el = document.getElementById("workbook-spec");
  if (!el) return null;
  try { return JSON.parse(el.textContent || "{}")?.manifest?.slug ?? null; }
  catch { return null; }
}

/** Read the source HTML the browser loaded.
 *
 *  1. First try `fetch(location.href)` — fast path, works for http
 *     and https. Returns the exact bytes the server delivered.
 *  2. If that fails (Chrome blocks file:// → file:// fetch with a
 *     CORS error; this is the common case for a downloaded
 *     .workbook.html opened via double-click), fall back to
 *     serialising the live DOM. The inlined `<script id="wasm-b64">`,
 *     `<script id="bindgen-src">`, `<script id="runtime-bundle-src">`,
 *     and `<script id="workbook-spec">` blocks are inert
 *     type="text/plain" elements that the browser parses but does
 *     NOT execute, so their full content is present in the DOM and
 *     survives outerHTML serialisation byte-for-byte.
 *
 *  Before serialising we empty `<div id="app">` so a clean Svelte
 *  mount happens on re-open — without that we'd ship the user's
 *  current rendered tree, which would either re-mount over the top
 *  or hydrate against a stale shape. */
async function fetchSourceHtml() {
  try {
    const res = await fetch(location.href, { cache: "no-store" });
    if (res.ok) return await res.text();
  } catch {
    // file:// origin blocked, network unreachable, etc. — fall through.
  }
  return serializeLiveDocument();
}

function serializeLiveDocument() {
  const cloned = document.documentElement.cloneNode(true);
  // Reset the SPA mount point so Svelte renders fresh on re-open.
  const app = cloned.querySelector("#app");
  if (app) app.innerHTML = "";
  // Drop any prior export-state wb-workbook block — injectStateInto
  // will rebuild it cleanly. Without this, repeated exports would
  // accumulate duplicate <wb-workbook data-export-state> nodes.
  for (const el of cloned.querySelectorAll("wb-workbook[data-export-state]")) {
    el.remove();
  }
  return "<!DOCTYPE html>\n" + cloned.outerHTML;
}

/** True when the loaded HTML is a fully self-contained build —
 *  identifies inlined wasm + runtime tags. Refuse export when this
 *  isn't true (running via `workbook dev`, etc.). */
function isPortableBuild(html) {
  return html.includes('id="wasm-b64"')
      && html.includes('id="runtime-bundle-src"');
}

/** Compute SHA-256 hex of a byte buffer. Used by the wb-history
 *  block embedding — both the body sha256 and head-sha256 attributes
 *  are required by the parser. */
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.byteLength)));
  }
  return btoa(s);
}

/** Inject the current composition HTML + asset registry + edit-log
 *  Prolly chain into the source doc as wb-* blocks the packager
 *  understands. wb-history is async because reading its bytes goes
 *  through the runtime wasm prollyHead binding. */
async function injectStateInto(doc) {
  const body = doc.querySelector("body");
  if (!body) return;

  let wb = body.querySelector("wb-workbook[data-export-state]");
  if (!wb) {
    wb = doc.createElement("wb-workbook");
    wb.setAttribute("data-export-state", "");
    wb.setAttribute("name", "hyperframes-snapshot");
    wb.setAttribute("hidden", "");
    body.appendChild(wb);
  }

  // Composition — inline text, grep-able.
  let compEl = wb.querySelector('wb-data[id="composition"]');
  if (!compEl) {
    compEl = doc.createElement("wb-data");
    compEl.setAttribute("id", "composition");
    compEl.setAttribute("mime", "text/html");
    wb.appendChild(compEl);
  }
  compEl.textContent = composition.html ?? "";

  // Each asset — base64 inline if matched, raw text for non-base64
  // data URLs (svgs sometimes ship as `data:image/svg+xml,<...>`).
  // The packager extracts anything > threshold to assets/<sha>.<ext>.
  for (const a of assets.items) {
    const id = `asset-${a.id}`;
    let el = wb.querySelector(`wb-data[id="${CSS.escape(id)}"]`);
    if (!el) {
      el = doc.createElement("wb-data");
      el.setAttribute("id", id);
      wb.appendChild(el);
    }
    const m = /^data:([^;,]+)(;[^,]*)?,(.*)$/i.exec(a.dataUrl ?? "");
    if (!m) continue;
    const [, mime, params = "", payload = ""] = m;
    el.setAttribute("mime", mime);
    if (a.name) el.setAttribute("data-name", a.name);
    if (params.includes(";base64")) {
      el.setAttribute("encoding", "base64");
      el.textContent = payload;
    } else {
      el.removeAttribute("encoding");
      try { el.textContent = decodeURIComponent(payload); }
      catch { el.textContent = payload; }
    }
  }

  // Edit log — Prolly Tree commit chain. Embed only when the chain
  // has bootstrapped (some edits have been recorded). A workbook
  // exported before any edits skips the wb-history block entirely;
  // the parser's head-sha256 requirement makes an empty stub awkward
  // and "no edits yet" is fine to lose.
  const snap = await snapshotForEmbed();
  if (snap) {
    let histEl = wb.querySelector('wb-history[id="changelog"]');
    if (!histEl) {
      histEl = doc.createElement("wb-history");
      histEl.setAttribute("id", "changelog");
      histEl.setAttribute("format", "prolly-v1");
      wb.appendChild(histEl);
    }
    histEl.setAttribute("sha256", await sha256Hex(snap.bytes));
    histEl.setAttribute("head-sha256", snap.head);
    histEl.setAttribute("encoding", "base64");
    histEl.textContent = bytesToBase64(snap.bytes);
  }
}

async function buildPortableHtml() {
  const source = await fetchSourceHtml();
  if (!isPortableBuild(source)) {
    throw new Error(
      "Page isn't a self-contained build (running in dev mode?). " +
      "Open the .workbook.html in dist/ to export, or run `workbook build` first."
    );
  }
  const doc = new DOMParser().parseFromString(source, "text/html");
  await injectStateInto(doc);
  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
}

// ─── Lighter project-only export ────────────────────────────────
//
// When two people already have the editor, shuttling the full 18 MB
// .workbook.html back and forth wastes bandwidth — they only need
// the project state (composition HTML + asset registry). This path
// emits a small `.hyperframes.json` file that the editor can
// re-import via importProjectFile().
//
// Format is intentionally simple: one JSON object, every asset
// inlined as a data URL. For very large media projects this still
// gets big; a future v2 could split assets into a sidecar zip.

const PROJECT_FORMAT = "hyperframes-project";
const PROJECT_VERSION = 1;

/** Serialize the current studio state to a portable JSON blob. */
export async function exportProjectFile({ filename, onError } = {}) {
  try {
    const baseSlug = detectSlugFromManifest() ?? slug(composition.title ?? "hyperframes");
    const finalName = filename ?? `${baseSlug}.hyperframes.json`;
    const payload = {
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      generated_at: new Date().toISOString(),
      title: composition.title ?? null,
      composition: composition.html ?? "",
      assets: assets.items.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        mime: a.mime ?? null,
        size: a.size ?? null,
        duration: a.duration ?? null,
        dataUrl: a.dataUrl,
      })),
    };
    const json = JSON.stringify(payload);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = finalName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return {
      ok: true,
      bytes: json.length,
      assetCount: payload.assets.length,
      filename: finalName,
    };
  } catch (e) {
    onError?.(e);
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** Apply a previously-exported project file to the live studio.
 *  Replaces composition + asset registry. Returns a summary. */
export async function importProjectFile(fileOrText) {
  const text = typeof fileOrText === "string"
    ? fileOrText
    : await fileOrText.text();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { throw new Error("File isn't valid JSON"); }
  if (parsed?.format !== PROJECT_FORMAT) {
    throw new Error(`Unrecognized format: ${parsed?.format ?? "(none)"}`);
  }
  if ((parsed?.version ?? 0) > PROJECT_VERSION) {
    throw new Error(`Project file version ${parsed.version} is newer than supported (${PROJECT_VERSION})`);
  }
  // Reset asset registry to mirror the imported state. We add new
  // entries instead of mutating in place so subscribers see one
  // coherent change.
  assets.replaceAll((parsed.assets ?? []).map((a) => ({
    id: a.id ?? `asset-${Math.random().toString(36).slice(2, 10)}`,
    name: a.name ?? "(unnamed)",
    kind: a.kind ?? "image",
    mime: a.mime ?? null,
    size: a.size ?? null,
    duration: a.duration ?? null,
    dataUrl: a.dataUrl ?? "",
    addedAt: Date.now(),
  })));
  composition.set(String(parsed.composition ?? ""));
  return {
    ok: true,
    assetCount: parsed.assets?.length ?? 0,
  };
}

/** Build the snapshot, package it, and trigger a download. The zip
 *  contains <slug>.workbook.html + assets/ + manifest.json. */
export async function exportProject({ filename, onError } = {}) {
  try {
    const html = await buildPortableHtml();
    const baseSlug = detectSlugFromManifest() ?? slug(composition.title ?? "hyperframes");
    const zipName = filename ?? `${baseSlug}.zip`;
    await downloadWorkbookZip(html, zipName, {
      // Inline anything under 100 KB; extract larger assets to
      // assets/<sha>.<ext>.
      extractInlineLargerThan: 100 * 1024,
      // The HTML inside the zip is named <slug>.workbook.html so
      // it matches the file users would have built standalone.
      htmlBasename: `${baseSlug}.workbook`,
      // No external bundling by default — local-asset projects only.
      bundleExternal: false,
    });
    return {
      ok: true,
      sourceBytes: html.length,
      assetCount: assets.items.length,
      filename: zipName,
    };
  } catch (e) {
    onError?.(e);
    return { ok: false, error: e?.message ?? String(e) };
  }
}
