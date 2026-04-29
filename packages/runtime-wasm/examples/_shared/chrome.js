// Shared chrome — top nav + footer rendered into every demo so the tour
// reads as a coherent showcase. Each demo calls `mountChrome({ slug })`
// at the top of its module script; the function inserts a <nav> at the
// start of <body> and a <footer> at the end.

const PAGES = [
  { slug: "hello-cell",       title: "hello",      desc: "rhai eval" },
  { slug: "csv-explore",      title: "csv ↦ sql",  desc: "polars" },
  { slug: "reactive-cells",   title: "reactive",   desc: "dag" },
  { slug: "candle-ops",       title: "tensors",    desc: "candle" },
  { slug: "vector-knn",       title: "vectors",    desc: "knn" },
  { slug: "sentence-search",  title: "embeddings", desc: "bert + knn" },
  { slug: "chat-cell",        title: "chat",       desc: "llm" },
  { slug: "html-workbook",    title: "html",       desc: "custom elements" },
  { slug: "html-agent",       title: "html agent", desc: "agent + chat" },
  { slug: "notebook-agent",   title: "notebook agent", desc: "agent edits cells" },
  { slug: "runner",           title: "runner",     desc: "open .workbook" },
];

export function mountChrome({ slug, version = "v0.1" } = {}) {
  // Nav.
  const nav = document.createElement("nav");
  nav.className = "wb-nav";
  nav.innerHTML = `
    <span class="brand">workbook<span class="accent">/</span>runtime</span>
    <span class="links">
      ${PAGES.map((p) => `
        <a href="../${p.slug}/" ${p.slug === slug ? 'aria-current="page"' : ""}>${p.title}</a>
      `).join("")}
    </span>
    <span class="spacer"></span>
    <span class="meta">${version}</span>
    <button id="wb-download" class="wb-btn ghost wb-download" aria-disabled="true"
            title="Download .workbook of this page (the demo must opt in via setWorkbookExport)">
      <span class="glyph">↓</span> workbook
    </button>
  `;
  document.body.insertBefore(nav, document.body.firstChild);

  // Wire the download button. Default click produces a self-contained
  // .workbook.html runnable in any browser (open by double-click, no
  // server needed). Holding alt/option produces the JSON-only .workbook
  // (smaller; needs a host that has the runtime — e.g. the runner page).
  const btn = nav.querySelector("#wb-download");
  btn.addEventListener("click", (ev) => {
    const jsonOnly = ev.altKey;
    downloadCurrentWorkbook(slug, jsonOnly);
  });
  btn.title = "Click: download self-contained .workbook.html (runs anywhere)\n" +
              "Option-click: download .workbook (JSON only — needs a host)";

  // Footer.
  const footer = document.createElement("footer");
  footer.className = "wb-footer";
  footer.innerHTML = `
    <span>real ml in the browser, end to end · all rust → wasm</span>
    <span>
      <a href="https://github.com/zaius-labs/workbooks" target="_blank">github.com/zaius-labs/workbooks</a>
    </span>
  `;
  document.body.appendChild(footer);
}

/** Convenience: render a build-info card with cold-start ms + features. */
export function renderBuildInfo(target, info, coldStartMs) {
  if (typeof target === "string") target = document.getElementById(target);
  if (!target) return;
  const features = (info?.features ?? []).join(" · ") || "—";
  target.innerHTML = `
    <div class="wb-tag-row">
      <span class="wb-tag"><span>cold start</span><strong>${coldStartMs} ms</strong></span>
      <span class="wb-tag"><span>contract</span><strong>${info?.contract_version ?? "?"}</strong></span>
      <span class="wb-tag"><span>features</span><strong>${features}</strong></span>
    </div>
  `;
}

// ----------------------------------------------------------------------
// Workbook export hook + downloader.
//
// A demo calls `setWorkbookExport(() => spec)` once it has constructed
// its workbook spec (cells + inputs). Spec shape:
//
//   {
//     manifest: { name, slug, version?, runtime?, runtime_features?[] },
//     cells:    [{ id, language, source?, spec?, dependsOn?, provides? }],
//     inputs?:  Record<string, unknown>,
//   }
//
// The download button serializes this to JSON, wraps in a Blob, triggers
// the browser file download dialog as `<slug>.workbook`. The runner page
// (examples/runner/) accepts this same shape and re-executes the cells.
// ----------------------------------------------------------------------

let workbookExport = null;

export function setWorkbookExport(exporter) {
  workbookExport = exporter;
  const btn = document.getElementById("wb-download");
  if (btn) {
    btn.removeAttribute("aria-disabled");
    btn.title = "Download .workbook of this page";
  }
}

async function downloadCurrentWorkbook(fallbackSlug, jsonOnly) {
  if (!workbookExport) {
    showHint(
      "This demo doesn't expose a workbook export yet — try " +
      "reactive-cells, csv-explore, or hello-cell.",
    );
    return;
  }
  let spec;
  try {
    spec = workbookExport();
  } catch (e) {
    showHint(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const slug = spec?.manifest?.slug ?? fallbackSlug ?? "workbook";

  if (jsonOnly) {
    const json = JSON.stringify(spec, null, 2);
    triggerDownload(
      new Blob([json], { type: "application/x-workbook+json" }),
      `${slug}.workbook`,
    );
    return;
  }

  // Default: self-contained .workbook.html.
  showHint("Building portable HTML (~15 MB) — takes a few seconds…");
  try {
    // Cache-buster: bump on every portable.js fix so reloads don't need
    // a hard refresh. Bump again if the inlined runner changes shape.
    const { buildPortableHtml } = await import("./portable.js?v=4");
    const html = await buildPortableHtml(spec);
    triggerDownload(
      new Blob([html], { type: "text/html;charset=utf-8" }),
      `${slug}.workbook.html`,
    );
    showHint("Saved · open the file with any browser to run it.");
  } catch (e) {
    showHint(`Portable build failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function showHint(text) {
  const existing = document.getElementById("wb-hint");
  if (existing) existing.remove();
  const div = document.createElement("div");
  div.id = "wb-hint";
  div.className = "wb-hint";
  div.textContent = text;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 4000);
}
