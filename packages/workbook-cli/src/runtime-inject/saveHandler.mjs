// Cmd+S / Ctrl+S → save the workbook in place, with current state.
//
// Inlined into every workbook by workbookInline.mjs. Self-contained:
// no imports, no deps. The whole file is injected as one <script>.
//
// What this gives every workbook for free:
//
//   1. Cmd+S / Ctrl+S is intercepted (preventDefault on the browser's
//      "Save Page As" — that flow snapshots a stale DOM and produces
//      a broken file).
//
//   2. A new HTML blob is built from the live DOM, with current
//      state captured into a <script id="wb-saved-state"> block.
//
//   3. The blob is written:
//      - via File System Access API on Chrome / Edge (TRUE save in
//        place — first save asks where, subsequent saves write
//        silently to the same handle)
//      - via <a download> on Safari and on file:// (download with
//        the same filename so the OS offers to overwrite)
//
//   4. A minimal "saved" toast appears for ~2s.
//
// Authors override the state envelope by setting a hook before the
// runtime mounts:
//
//   window.serializeWorkbookState = () => ({
//     conversation: getMessages(),
//     dataset:      ipc.toBase64(),
//     // anything else you want to ship with the file
//   });
//
//   window.rehydrateWorkbookState = (state) => { /* restore */ };
//
// Without an override, the default envelope is "heavy" — every form
// input value + localStorage + sessionStorage. That's enough for most
// workbooks; authors who want light or custom override the hook.
//
// Disable per-workbook via workbook.config.mjs:
//   export default { save: { enabled: false }, ... }

(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__wbSaveHandlerInstalled) return;
  window.__wbSaveHandlerInstalled = true;

  // -------- state default + override hooks --------

  function defaultSerialize() {
    /** @type {Record<string, unknown>} */
    const state = { v: 1, ts: Date.now() };

    // Form values — every <input>, <textarea>, <select>.
    const forms = {};
    let formIdx = 0;
    for (const el of document.querySelectorAll("input, textarea, select")) {
      const key = el.id || el.name || `__${formIdx++}`;
      if (el.type === "checkbox" || el.type === "radio") {
        forms[key] = !!el.checked;
      } else if (el.type === "file") {
        // Skip — files can't be serialized portably without inlining bytes.
      } else {
        forms[key] = el.value ?? "";
      }
    }
    state.forms = forms;

    // localStorage + sessionStorage — copy whole. If the author wants
    // narrower scope, they override.
    try {
      const ls = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) ls[k] = localStorage.getItem(k);
      }
      state.localStorage = ls;
    } catch { /* private mode: ignore */ }
    try {
      const ss = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k) ss[k] = sessionStorage.getItem(k);
      }
      state.sessionStorage = ss;
    } catch { /* private mode: ignore */ }

    return state;
  }

  function defaultRehydrate(state) {
    if (!state || typeof state !== "object") return;
    if (state.forms) {
      let formIdx = 0;
      for (const el of document.querySelectorAll("input, textarea, select")) {
        const key = el.id || el.name || `__${formIdx++}`;
        if (!(key in state.forms)) continue;
        const v = state.forms[key];
        if (el.type === "checkbox" || el.type === "radio") el.checked = !!v;
        else el.value = String(v ?? "");
      }
    }
    try {
      if (state.localStorage) {
        for (const [k, v] of Object.entries(state.localStorage)) {
          localStorage.setItem(k, String(v));
        }
      }
    } catch { /* ignore */ }
    try {
      if (state.sessionStorage) {
        for (const [k, v] of Object.entries(state.sessionStorage)) {
          sessionStorage.setItem(k, String(v));
        }
      }
    } catch { /* ignore */ }
  }

  // -------- rehydrate on load --------

  function tryRehydrate() {
    const node = document.getElementById("wb-saved-state");
    if (!node) return;
    let parsed;
    try { parsed = JSON.parse(node.textContent || ""); } catch { return; }
    const fn = window.rehydrateWorkbookState ?? defaultRehydrate;
    try { fn(parsed); } catch (e) { console.warn("[workbook] rehydrate failed:", e); }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tryRehydrate, { once: true });
  } else {
    tryRehydrate();
  }

  // -------- file-as-database: refresh persistent elements ----------
  //
  // Before snapshotting the DOM for save, walk every <wb-doc> and
  // <wb-memory> element in the live document and refresh its content
  // with the runtime's current bytes. Without this step, the saved
  // file would contain the INITIAL state of these elements (the bytes
  // they were authored with), not whatever the user mutated during
  // the session. The runtime exposes its client at `window.__wbRuntime`
  // (see htmlBindings.ts and authoring/WorkbookApp.svelte for the
  // installer hooks). This is what makes "the file IS the database"
  // actually work — Loro CRDT changes and Arrow-memory appends round-
  // trip back into the .workbook.html on every Cmd+S.

  async function bytesToBase64Async(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(
        null,
        bytes.subarray(i, Math.min(i + chunk, bytes.length)),
      );
    }
    return btoa(binary);
  }

  async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function refreshPersistentElements() {
    const rt = window.__wbRuntime;
    if (!rt) return; // no runtime mounted (e.g. encrypted workbook pre-unlock)

    const tasks = [];
    if (typeof rt.exportDoc === "function") {
      for (const el of document.querySelectorAll("wb-doc")) {
        const id = el.getAttribute("id");
        if (id) tasks.push(refreshElement(el, id, rt.exportDoc.bind(rt)));
      }
    }
    if (typeof rt.exportMemory === "function") {
      for (const el of document.querySelectorAll("wb-memory")) {
        const id = el.getAttribute("id");
        if (id) tasks.push(refreshElement(el, id, rt.exportMemory.bind(rt)));
      }
    }
    await Promise.allSettled(tasks);
  }

  async function refreshElement(el, id, exporter) {
    try {
      const bytes = await exporter(id);
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) return;
      const [b64, sha] = await Promise.all([
        bytesToBase64Async(bytes),
        sha256Hex(bytes),
      ]);
      el.textContent = b64;
      el.setAttribute("encoding", "base64");
      el.setAttribute("sha256", sha);
      el.setAttribute("bytes", String(bytes.length));
      // Drop external src — content is now inline. Keeps the saved
      // file fully self-contained even if the original authored form
      // was a remote fetch.
      el.removeAttribute("src");
    } catch (e) {
      console.warn(`[workbook] save: failed to refresh <${el.tagName.toLowerCase()} id="${id}">:`, e);
    }
  }

  // -------- save flow --------

  function buildSavedHtml() {
    // Snapshot the current document so user-edited DOM is preserved.
    // Then append/replace <script id="wb-saved-state"> with the state.
    const doctype = "<!doctype html>\n";
    const html = document.documentElement.outerHTML;

    const fn = window.serializeWorkbookState ?? defaultSerialize;
    let state;
    try { state = fn(); } catch (e) {
      console.warn("[workbook] serialize hook threw:", e);
      state = {};
    }
    const stateJson = JSON.stringify(state);

    // Replace any prior state block; otherwise inject before </body>.
    const stateScript =
      `<script id="wb-saved-state" type="application/json">` +
      stateJson.replace(/<\//g, "<\\/") +
      `</script>`;

    let withState;
    if (/<script id="wb-saved-state"[^>]*>[\s\S]*?<\/script>/i.test(html)) {
      withState = html.replace(
        /<script id="wb-saved-state"[^>]*>[\s\S]*?<\/script>/i,
        stateScript,
      );
    } else if (/<\/body>/i.test(html)) {
      withState = html.replace(/<\/body>/i, stateScript + "\n</body>");
    } else {
      withState = html + stateScript;
    }

    return doctype + withState;
  }

  function suggestedFilename() {
    const path = (typeof location !== "undefined" && location.pathname) || "";
    const base = decodeURIComponent(path.split("/").pop() || "");
    if (base && /\.html?$/i.test(base)) return base;
    if (base) return base + ".html";
    return "workbook.html";
  }

  async function save() {
    // Refresh <wb-doc> + <wb-memory> elements with current runtime
    // state BEFORE snapshotting the HTML. This is the file-roundtrip
    // glue: in-memory mutations land in the saved file.
    await refreshPersistentElements();

    const html = buildSavedHtml();
    const sizeKb = Math.max(1, Math.round(html.length / 1024));

    // FSA API path (Chrome, Edge). Hold onto the handle for subsequent
    // silent saves.
    if (typeof window.showSaveFilePicker === "function") {
      try {
        if (!window.__wbSaveHandle) {
          window.__wbSaveHandle = await window.showSaveFilePicker({
            suggestedName: suggestedFilename(),
            types: [{
              description: "Workbook HTML",
              accept: { "text/html": [".html"] },
            }],
          });
        }
        const writable = await window.__wbSaveHandle.createWritable();
        await writable.write(html);
        await writable.close();
        toast(`saved (${sizeKb} KB)`);
        return;
      } catch (e) {
        // User cancelled, or permission denied — fall through to download.
        if (e && e.name === "AbortError") return;
      }
    }

    // Download fallback — Safari + file:// in any browser.
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedFilename();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`saved (${sizeKb} KB · download)`);
  }

  // -------- toast --------

  let toastEl = null;
  let toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "wb-save-toast";
      toastEl.style.cssText =
        "position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(8px);" +
        "background:var(--wb-toast-bg,#0f1115);color:var(--wb-toast-fg,#fbfbf9);" +
        "padding:8px 14px;border-radius:6px;" +
        "font:500 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;" +
        "letter-spacing:.02em;box-shadow:0 4px 12px rgba(0,0,0,.15);" +
        "opacity:0;transition:opacity .15s ease, transform .15s ease;" +
        "pointer-events:none;z-index:2147483647;";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    requestAnimationFrame(() => {
      toastEl.style.opacity = "1";
      toastEl.style.transform = "translateX(-50%) translateY(0)";
    });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.style.opacity = "0";
      toastEl.style.transform = "translateX(-50%) translateY(8px)";
    }, 1800);
  }

  // -------- keybind --------

  // Authors can call this directly if they want a custom save button.
  // Set FIRST so the keybind below sees `window.workbookSave === save`
  // when no override has run, and sees a different ref when one has.
  window.workbookSave = save;

  document.addEventListener("keydown", (e) => {
    const isSave = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey &&
      (e.key === "s" || e.key === "S");
    if (!isSave) return;
    e.preventDefault();
    // Delegate to whatever's currently on window.workbookSave. If a
    // host (e.g. a substrate-enabled workbook) has reassigned it,
    // their save fn runs and the wb-saved-state envelope path is
    // bypassed entirely — Y.Doc / WAL is already the canonical state,
    // capturing forms/localStorage on top would be duplicate work.
    // If untouched, this calls our local `save()`.
    const fn = typeof window.workbookSave === "function" ? window.workbookSave : save;
    fn();
  }, { capture: true });
})();
