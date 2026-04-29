// Project export — packages the running hyperframes app + current
// state (composition HTML + asset registry) into a portable
// .workbook.zip via the @work.books/runtime packager.
//
// Why a snapshot rather than passing document.documentElement.outerHTML
// directly: the asset registry lives in JS heap (assets.items[].dataUrl),
// not in <wb-data> elements yet. We materialize the registry into the
// snapshot DOM at export time so the packager can extract them.
//
// The deeper migration (assets stored as live <wb-data> blocks at all
// times) is task #26 and tracks separately. This export path works
// either way — extracting from the live DOM where assets are wired,
// extracting from the snapshot DOM otherwise.

import { downloadWorkbookZip } from "@work.books/runtime/packageWorkbook";
import { composition } from "./composition.svelte.js";
import { assets } from "./assets.svelte.js";

/** Slugify a string for use in a filename. */
function slug(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "hyperframes";
}

/**
 * Build a workbook-shaped HTML string capturing the current state:
 *   - the live runtime (cloned from document.documentElement)
 *   - composition.html injected into a <wb-data id="composition" mime="text/html">
 *   - each asset as <wb-data id="asset-<id>" mime="..."> with the data URL inlined
 *
 * The packager will then walk those <wb-data> blocks, extract anything
 * over the inline threshold to assets/<sha256>.<ext>, and rewrite refs.
 */
function buildSnapshotHtml() {
  const cloned = document.documentElement.cloneNode(true);

  // Find or create a <wb-workbook> wrapper inside body so the runtime
  // can locate the embedded data on reload. We don't need it for the
  // current ship (the runtime mounts its own SPA) but it makes the
  // zip self-describing.
  const body = cloned.querySelector("body");
  if (!body) return "<!DOCTYPE html>\n" + cloned.outerHTML;

  let wb = body.querySelector("wb-workbook");
  if (!wb) {
    wb = document.createElement("wb-workbook");
    wb.setAttribute("name", "hyperframes-snapshot");
    wb.style.display = "none";
    body.appendChild(wb);
  }

  // Composition HTML — stored as inline-text wb-data (not base64
  // because it's already text and benefits from being grep-able).
  let compEl = wb.querySelector('wb-data[id="composition"]');
  if (!compEl) {
    compEl = document.createElement("wb-data");
    compEl.setAttribute("id", "composition");
    compEl.setAttribute("mime", "text/html");
    wb.appendChild(compEl);
  }
  compEl.textContent = composition.html ?? "";

  // Asset registry — each entry as inline-base64 wb-data. We strip
  // the "data:<mime>;base64," prefix and put the raw base64 in the
  // body, with mime as an attribute. The packager extracts anything
  // over its threshold to assets/<sha256>.<ext>.
  for (const a of assets.items) {
    const id = `asset-${a.id}`;
    let el = wb.querySelector(`wb-data[id="${id}"]`);
    if (!el) {
      el = document.createElement("wb-data");
      el.setAttribute("id", id);
      wb.appendChild(el);
    }
    const m = /^data:([^;,]+)(;[^,]*)?,(.*)$/i.exec(a.dataUrl ?? "");
    if (!m) continue;
    const mime = m[1];
    const params = m[2] ?? "";
    const payload = m[3] ?? "";
    if (!params.includes(";base64")) {
      // Non-base64 data URL — keep inline-text so we don't lose
      // semantics. SVGs sometimes ship as `data:image/svg+xml,<...>`
      // url-encoded.
      el.setAttribute("mime", mime);
      el.removeAttribute("encoding");
      try { el.textContent = decodeURIComponent(payload); }
      catch { el.textContent = payload; }
      continue;
    }
    el.setAttribute("mime", mime);
    el.setAttribute("encoding", "base64");
    el.textContent = payload;
  }

  return "<!DOCTYPE html>\n" + cloned.outerHTML;
}

/**
 * Build the snapshot, package it, and trigger a download. Returns
 * a summary of what got bundled for the caller to surface in UI.
 */
export async function exportProject({ filename, onError } = {}) {
  try {
    const html = buildSnapshotHtml();
    const sourceBytes = html.length;
    const finalName = filename ?? `${slug(composition.title ?? "hyperframes")}.workbook.zip`;
    await downloadWorkbookZip(html, finalName, {
      // Inline anything under 100 KB; extract larger assets (videos
      // especially). Per-asset HTTP overhead isn't worth it for tiny
      // SVGs and thumbnails.
      extractInlineLargerThan: 100 * 1024,
      // No external bundling by default — the export flow is for
      // local-asset projects. Hosts that need external bundling can
      // pass an allowlist via opts.
      bundleExternal: false,
    });
    return {
      ok: true,
      sourceBytes,
      assetCount: assets.items.length,
      filename: finalName,
    };
  } catch (e) {
    onError?.(e);
    return { ok: false, error: e?.message ?? String(e) };
  }
}
