// Project I/O — File menu plumbing.
//
// Three operations:
//
//   newProject()                  Reset composition + assets to defaults.
//   openProject(File)             Load a saved hyperframe.html or workbook.html
//                                 into the running studio in-place. Does NOT
//                                 reload the page — Loro doc.import + asset
//                                 replace re-renders reactively, so the user's
//                                 chrome / chat thread / settings remain.
//   exportHyperframeHtml()        Produce a standalone playable HTML:
//                                 the composition body + IFRAME_RUNTIME_AUTOPLAY,
//                                 zero studio chrome, ~few KB. Triggers a
//                                 download. Intended as the canonical
//                                 share-with-anyone artifact.
//
// "Project" file format options accepted by openProject:
//
//   hyperframe.html    — the standalone playable. Composition is the body's
//                        innerHTML stripped of the IFRAME_RUNTIME script.
//                        Cleanest round-trip; small.
//   .workbook.html     — the full studio export (Phase A.2 Package). We
//                        extract the <wb-doc id="hyperframes-state"> base64
//                        snapshot and import into the current Loro doc.

import { writeComposition, replaceAssets, getDoc } from "./loroBackend.svelte.js";
import { INITIAL_COMPOSITION, IFRAME_RUNTIME_AUTOPLAY } from "./initial.js";

// ─── new ──────────────────────────────────────────────────────────────

export async function newProject() {
  await writeComposition(INITIAL_COMPOSITION);
  await replaceAssets([]);
}

// ─── open ─────────────────────────────────────────────────────────────

/**
 * Load a project file. Detects format from contents (prefers
 * <wb-doc id="hyperframes-state">; falls back to a hyperframe.html
 * with body innerHTML as the composition).
 *
 * @param {File} file
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function openProject(file) {
  if (!file) return { ok: false, error: "no file" };

  let text;
  try {
    text = await file.text();
  } catch (e) {
    return { ok: false, error: `failed to read file: ${e?.message ?? e}` };
  }
  if (!text) return { ok: false, error: "file is empty" };

  // Try .workbook.html first — look for the wb-doc snapshot.
  const wbDocMatch = text.match(
    /<wb-doc\s[^>]*\bid=["']hyperframes-state["'][^>]*>([\s\S]*?)<\/wb-doc>/i,
  );
  if (wbDocMatch) {
    const b64 = wbDocMatch[1].trim();
    if (b64) {
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const doc = getDoc();
        if (!doc) {
          return { ok: false, error: "runtime not booted yet — reload and try again" };
        }
        doc.import(bytes);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `decoding wb-doc failed: ${e?.message ?? e}` };
      }
    }
  }

  // Fallback: hyperframe.html — pull body innerHTML, strip the
  // autoplay runtime script, write as composition.
  const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    let composition = bodyMatch[1];
    // Drop the inlined IFRAME_RUNTIME script if present — it's runtime,
    // not authored content. Match the BEGIN/END sentinels we emit on
    // export to be precise.
    composition = composition.replace(
      /<!-- BEGIN hyperframe-runtime -->[\s\S]*?<!-- END hyperframe-runtime -->/g,
      "",
    );
    composition = composition.trim();
    if (composition) {
      await writeComposition(composition);
      return { ok: true };
    }
  }

  return {
    ok: false,
    error:
      "couldn't recognize the file as a hyperframe.html or .workbook.html. " +
      "Expected a body section or a <wb-doc id=\"hyperframes-state\"> block.",
  };
}

// ─── export ───────────────────────────────────────────────────────────

const HYPERFRAME_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%%TITLE%%</title>
<style>
  html, body { margin: 0; width: 100%; height: 100%; background: #0c0a09; overflow: hidden; }
</style>
</head>
<body>
%%COMPOSITION%%
<!-- BEGIN hyperframe-runtime -->
<script>%%RUNTIME%%</script>
<!-- END hyperframe-runtime -->
</body>
</html>
`;

function htmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build a standalone playable HTML. Returns the file contents.
 *
 * @param {object} args
 * @param {string} args.composition  composition HTML (the body innerHTML)
 * @param {string} [args.title]      page title (optional)
 */
export function buildHyperframeHtml({ composition, title } = {}) {
  let out = HYPERFRAME_TEMPLATE;
  out = out.replace("%%TITLE%%", htmlEscape(title || "Hyperframe"));
  // Composition + runtime are intentionally embedded as raw HTML/JS,
  // not escaped — they ARE the artifact.
  out = out.replace("%%COMPOSITION%%", composition || "");
  out = out.replace("%%RUNTIME%%", IFRAME_RUNTIME_AUTOPLAY);
  return out;
}

/** Export the current composition as a downloadable hyperframe.html. */
export async function exportHyperframeHtml({ title, filename } = {}) {
  const doc = getDoc();
  if (!doc) {
    return { ok: false, error: "runtime not booted yet" };
  }
  const composition = doc.getText("composition").toString();
  if (!composition) {
    return { ok: false, error: "composition is empty — nothing to export" };
  }
  const html = buildHyperframeHtml({ composition, title });
  const name = filename || "hyperframe.html";

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);

  return { ok: true, filename: name, sizeKb: Math.round(html.length / 1024) };
}
