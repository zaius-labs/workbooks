// Portable workbook export — produces a self-contained .html
// file that runs in any browser without a server, a pkg/ directory, or
// network access. Opens by double-click.
//
// What gets inlined into the HTML:
//   - design.css      (the same scientific-paper styling as the demos)
//   - workbook_runtime.js (wasm-bindgen JS glue, served via blob: URL)
//   - workbook_runtime_bg.wasm (base64-encoded; passed to init() as bytes)
//   - runtime.bundle.js (the JS-side bridge: createRuntimeClient,
//                        analyzeCell, ReactiveExecutor)
//   - the workbook spec itself (manifest + cells + inputs)
//   - a compact runner UI (cells, inputs, status badges)
//
// The result is one HTML file, ~15-17 MB depending on wasm features.
// Heavy but standalone — can be emailed, dropped on a USB stick, or
// served from a static host. Brotli over HTTP knocks it back to ~3 MB
// on the wire.

/** Build a self-contained HTML string runnable in any browser. */
export async function buildPortableHtml(spec) {
  // Fetch our local assets relative to the page that's calling this.
  // Each example lives at examples/<name>/index.html, so pkg/ is two
  // levels up — but design.css is one level up at examples/_shared/.
  const [designCss, bindgenJs, runtimeBundle, wasmBytes] = await Promise.all([
    fetchText("../_shared/design.css"),
    fetchText("../../pkg/workbook_runtime.js"),
    fetchText("../reactive-cells/runtime.bundle.js"),
    fetchBytes("../../pkg/workbook_runtime_bg.wasm"),
  ]);

  // Strip the wasm-bindgen default loader's URL-resolution path. The
  // generated JS calls `new URL("workbook_runtime_bg.wasm", import.meta.url)`
  // when no input is passed. We DO pass input (the base64 bytes), so the
  // URL line never executes — but it does run as part of the function
  // body and `import.meta.url` is opaque inside a blob: module. Replace
  // that line with a no-op so the inlined code can't throw.
  const safeBindgenJs = bindgenJs
    .replace(
      /new URL\([\s\S]*?import\.meta\.url\)/g,
      'undefined /* stripped: caller supplies bytes */',
    );

  const wasmB64 = uint8ToBase64(wasmBytes);
  const title = spec?.manifest?.name ?? spec?.manifest?.slug ?? "workbook";
  const slug = spec?.manifest?.slug ?? "workbook";

  return TEMPLATE({
    title,
    slug,
    designCss,
    bindgenJs: safeBindgenJs,
    runtimeBundle,
    wasmB64,
    spec,
  });
}

// ----------------------------------------------------------------------

async function fetchText(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`fetch ${path} → ${r.status}`);
  return r.text();
}

async function fetchBytes(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`fetch ${path} → ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

function uint8ToBase64(arr) {
  // Chunk the apply call — String.fromCharCode caps stack depth around
  // 65k elements on most JS engines. 32k is comfortably below.
  const CHUNK = 0x8000;
  let s = "";
  for (let i = 0; i < arr.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

// Triple-backtick safe template literal — escape any backticks the
// caller's content might contain so the inlined source survives.
function escapeBackticks(s) {
  return s.replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function TEMPLATE({ title, slug, designCss, bindgenJs, runtimeBundle, wasmB64, spec }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · workbook</title>
<style>
${designCss}

/* portable-runner extras */
.cell { border: 1px solid var(--line); border-radius: var(--radius); padding: var(--s-4) var(--s-5); background: var(--bg); transition: border-color var(--t-mid) var(--ease-out), opacity var(--t-mid) var(--ease-out); }
.cell + .cell { margin-top: var(--s-3); }
.cell.running { border-color: var(--run); }
.cell.ok { border-color: color-mix(in srgb, var(--ok) 35%, var(--line)); }
.cell.error { border-color: color-mix(in srgb, var(--err) 35%, var(--line)); }
.cell.stale { opacity: 0.55; }
.cell-head { display: flex; justify-content: space-between; align-items: baseline; font-family: var(--font-mono); font-size: var(--t-xs); color: var(--ink-3); margin-bottom: var(--s-2); letter-spacing: 0.02em; }
.cell-head .id { color: var(--ink); font-weight: 500; }
.cell-head .lang { text-transform: uppercase; font-size: 11px; }
.cell-source { font-family: var(--font-mono); font-size: var(--t-sm); background: var(--bg-soft); padding: var(--s-2) var(--s-3); border-radius: 3px; color: var(--ink-2); margin: var(--s-2) 0; white-space: pre-wrap; }
.cell-out { font-family: var(--font-mono); font-size: var(--t-sm); color: var(--ink); margin-top: var(--s-2); white-space: pre-wrap; }
.cell.error .cell-out { color: var(--err); }
.cell-img svg { max-width: 100%; height: auto; display: block; }
.input-row { display: flex; align-items: baseline; gap: var(--s-3); padding: var(--s-2) 0; }
.input-row label { font-family: var(--font-mono); font-size: var(--t-xs); color: var(--ink-3); min-width: 6rem; }
.boot { padding: var(--s-9) 0; text-align: center; color: var(--ink-3); font-family: var(--font-mono); font-size: var(--t-sm); }
.boot .progress { margin-top: var(--s-3); color: var(--ink-4); font-size: var(--t-xs); }
</style>
</head>
<body>
<header class="wb-nav">
  <span class="brand">workbook<span class="accent">·</span>portable</span>
  <span class="links"><a aria-current="page">${escapeHtml(slug)}</a></span>
  <span class="spacer"></span>
  <span class="meta">self-contained</span>
</header>

<main class="wb-page">
  <header class="wb-hero">
    <div class="eyebrow">portable workbook</div>
    <h1>${escapeHtml(title)}</h1>
    <p class="wb-muted" id="status">booting runtime…</p>
  </header>

  <section class="wb-section" id="bootSection">
    <div class="boot">
      <span class="wb-dot running"></span> instantiating wasm…
      <div class="progress" id="progress">decoding ${(wasmB64.length / 1024 / 1024).toFixed(1)} MB → wasm bytes…</div>
    </div>
  </section>

  <section class="wb-section" id="inputsSection" style="display:none;">
    <h2 class="wb-section-title">Inputs</h2>
    <div class="wb-card" id="inputs"></div>
  </section>

  <section class="wb-section" id="cellsSection" style="display:none;">
    <h2 class="wb-section-title">Cells</h2>
    <div id="cells"></div>
  </section>
</main>

<footer class="wb-footer">
  <span>portable workbook · runs without a server</span>
  <span><a href="https://github.com/zaius-labs/workbooks" target="_blank">workbooks</a></span>
</footer>

<!-- Source containers: type="text/plain" so the browser does NOT execute
     them as classic scripts (the inlined modules use export, which is
     illegal in classic mode). We read .textContent and route the source
     into blob: URLs that we dynamic-import as proper modules. -->
<script id="bindgen-src" type="text/plain">${escapeBackticksAndScripts(bindgenJs)}</script>
<script id="runtime-bundle-src" type="text/plain">${escapeBackticksAndScripts(runtimeBundle)}</script>
<script id="workbook-spec" type="application/json">${escapeJsonForScriptTag(spec)}</script>
<script id="wasm-b64" type="text/plain">${wasmB64}</script>

<script type="module">
  const SPEC = JSON.parse(document.getElementById("workbook-spec").textContent);
  const WASM_B64 = document.getElementById("wasm-b64").textContent;
  const BINDGEN_SRC = document.getElementById("bindgen-src").textContent;
  const BUNDLE_SRC = document.getElementById("runtime-bundle-src").textContent;

  const status = document.getElementById("status");
  const progress = document.getElementById("progress");

  function fail(stage, err) {
    const msg = err instanceof Error ? (err.stack || err.message) : String(err);
    status.textContent = "boot failed at: " + stage;
    document.getElementById("bootSection").innerHTML =
      '<div class="wb-out error" style="white-space:pre-wrap;">' +
      '<strong>boot failed at: ' + stage + '</strong>\\n' +
      'browser: ' + (navigator.userAgent || '?') + '\\n\\n' +
      msg.replace(/&/g,'&amp;').replace(/</g,'&lt;') +
      '</div>';
  }

  // Surface unhandled module-level rejections too — async iOS Safari
  // sometimes swallows these silently.
  window.addEventListener("unhandledrejection", (ev) => {
    fail("unhandledrejection", ev.reason);
  });
  window.addEventListener("error", (ev) => {
    fail("window.error", ev.error || ev.message);
  });

  let wasm, bundle, client;
  try {
    progress.textContent = "feature support check…";
    const features = {
      WebAssembly: typeof WebAssembly !== "undefined",
      simd: await wasmFeatureCheck("simd"),
      bigInt: typeof BigInt !== "undefined",
    };
    progress.textContent = "wasm: " + JSON.stringify(features);
    if (!features.WebAssembly) throw new Error("WebAssembly not available");

    progress.textContent = "decoding " + (WASM_B64.length / 1024 / 1024).toFixed(1) + " MB base64 → wasm bytes…";
    const t0 = performance.now();
    const wasmBytes = base64ToBytes(WASM_B64);
    progress.textContent = "decoded in " + (performance.now() - t0).toFixed(0) + " ms · creating module URL…";

    const bindgenUrl = URL.createObjectURL(new Blob([BINDGEN_SRC], { type: "application/javascript" }));
    progress.textContent = "importing bindgen module via blob:…";
    wasm = await import(bindgenUrl);

    progress.textContent = "calling wasm-bindgen init() with " + (wasmBytes.length / 1024 / 1024).toFixed(1) + " MB…";
    await wasm.default(wasmBytes);
    URL.revokeObjectURL(bindgenUrl);

    progress.textContent = "loading runtime bundle…";
    const bundleUrl = URL.createObjectURL(new Blob([BUNDLE_SRC], { type: "application/javascript" }));
    bundle = await import(bundleUrl);
    URL.revokeObjectURL(bundleUrl);

    progress.textContent = "creating runtime client…";
    client = bundle.createRuntimeClient({ loadWasm: async () => wasm });
  } catch (err) {
    fail("init", err);
    throw err;
  }

  // Per-feature wasm support probe. Tries to instantiate a tiny module
  // that only validates if the feature is enabled.
  async function wasmFeatureCheck(feature) {
    try {
      if (feature === "simd") {
        // 8-byte module that uses v128.const — only validates with simd.
        const bytes = new Uint8Array([
          0,97,115,109, 1,0,0,0,
          1,5,1,96,0,1,123,
          3,2,1,0,
          10,12,1,10,0,253,15,0,0,0,0,0,0,0,0,0,0,0,0,11,
        ]);
        return await WebAssembly.validate(bytes);
      }
      return false;
    } catch { return false; }
  }

  status.textContent = "ready · running cells";
  document.getElementById("bootSection").style.display = "none";

  // Inputs.
  const inputs = { ...(SPEC.inputs ?? {}) };
  const inputsEl = document.getElementById("inputs");
  const inputNames = Object.keys(inputs);
  if (inputNames.length === 0) {
    inputsEl.innerHTML = '<span class="wb-muted wb-mono" style="font-size: var(--t-sm);">no declared inputs</span>';
  } else {
    inputsEl.innerHTML = inputNames.map((name) => {
      const val = inputs[name];
      const type = typeof val === "number" ? "number" : "text";
      return '<div class="input-row"><label>' + name + '</label>' +
             '<input class="wb-input ' + (type === "number" ? "num" : "text") + '" type="' + type + '" value="' + escapeAttr(String(val)) + '" data-input="' + name + '" /></div>';
    }).join("");
  }
  document.getElementById("inputsSection").style.display = "block";

  // Cells.
  const cellsRoot = document.getElementById("cells");
  const cellEls = new Map();
  for (const cell of (SPEC.cells ?? [])) {
    const a = bundle.analyzeCell(cell);
    const el = document.createElement("div");
    el.className = "cell stale";
    el.innerHTML =
      '<div class="cell-head">' +
        '<span><span class="wb-dot idle"></span><span class="id">' + escapeHtml(cell.id) + '</span></span>' +
        '<span class="lang">' + escapeHtml(cell.language ?? "?") + '</span>' +
      '</div>' +
      '<div class="cell-source">' + escapeHtml(cell.source ?? "(no source)") + '</div>' +
      '<div class="cell-out wb-muted">—</div>';
    cellsRoot.appendChild(el);
    cellEls.set(cell.id, el);
  }
  document.getElementById("cellsSection").style.display = "block";

  const executor = new bundle.ReactiveExecutor({
    client,
    cells: SPEC.cells ?? [],
    inputs,
    workbookSlug: SPEC.manifest?.slug ?? "portable",
    debounceMs: 200,
    onCellState: updateCellState,
  });

  inputsEl.querySelectorAll("input[data-input]").forEach((el) => {
    el.addEventListener("input", () => {
      const name = el.dataset.input;
      const v = el.type === "number" ? Number(el.value) : el.value;
      executor.setInput(name, v);
    });
  });

  await executor.runAll();

  function updateCellState(state) {
    const el = cellEls.get(state.cellId);
    if (!el) return;
    el.className = "cell " + state.status;
    el.querySelector(".wb-dot").className = "wb-dot " + state.status;
    const out = el.querySelector(".cell-out");
    if (state.status === "ok" && state.outputs?.length) {
      out.classList.remove("wb-muted");
      out.innerHTML = "";
      for (const o of state.outputs) out.appendChild(renderOutput(o));
    } else if (state.status === "error") {
      out.textContent = state.error ?? "(error)";
    } else if (state.status === "running") {
      out.classList.add("wb-muted");
      out.textContent = "running…";
    }
  }

  function renderOutput(o) {
    if (o.kind === "image" && o.mime_type === "image/svg+xml") {
      const div = document.createElement("div"); div.className = "cell-img"; div.innerHTML = o.content; return div;
    }
    if (o.kind === "text" && o.mime_type === "text/csv") return csvToTable(o.content);
    const div = document.createElement("div");
    if (o.kind === "text") div.textContent = o.content;
    else if (o.kind === "error") div.textContent = "ERROR: " + o.message;
    else div.textContent = JSON.stringify(o);
    return div;
  }

  function csvToTable(csv) {
    const rows = csv.trim().split("\\n").map(parseCsvRow);
    const t = document.createElement("table"); t.className = "wb-table";
    const thead = document.createElement("thead"); const tr = document.createElement("tr");
    for (const c of rows[0]) { const th = document.createElement("th"); th.textContent = c; tr.appendChild(th); }
    thead.appendChild(tr); t.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (let i = 1; i < rows.length; i++) {
      const r = document.createElement("tr");
      for (const c of rows[i]) {
        const td = document.createElement("td"); td.textContent = c;
        if (!isNaN(Number(c)) && c !== "") td.className = "num";
        r.appendChild(td);
      }
      tbody.appendChild(r);
    }
    t.appendChild(tbody);
    return t;
  }
  function parseCsvRow(row) {
    const out = []; let cur = ""; let inQ = false;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => {
      if (c === "&") return "&amp;";
      if (c === "<") return "&lt;";
      if (c === ">") return "&gt;";
      if (c === '"') return "&quot;";
      return "&#39;";
    });
  }
  function escapeAttr(s) { return escapeHtml(s); }
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Inlining JS source inside <script> tags requires escaping `</script>`
// (so the content can't break out of the tag). We also escape backticks
// only if we were embedding into a template literal, which we're not —
// we're using <script type="application/javascript">…raw source…</script>
// and reading via .textContent. So only </script> matters.
function escapeBackticksAndScripts(s) {
  return s.replace(/<\/script>/gi, "<\\/script>");
}

function escapeJsonForScriptTag(spec) {
  return JSON.stringify(spec).replace(/<\/script>/gi, "<\\/script>");
}
