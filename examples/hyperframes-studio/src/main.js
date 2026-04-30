// Entry — mount the workbook runtime first so the <wb-doc> in
// index.html gets parsed + registered with a LoroDocHandle, then
// mount the Svelte app once persistent state is ready.
//
// Order matters: the studio's loroBackend reads its LoroDoc from
// window.__wbRuntime.getDocHandle("hyperframes-state"), which only
// exists after mountHtmlWorkbook() resolves. Awaiting both before
// Svelte mount eliminates the brief default-state flash that the
// prior IDB-bootstrap flow had.
//
// No IndexedDB. State lives in <wb-doc> inside the .workbook.html
// file; mutations during the session round-trip back into the file
// on Cmd+S via the SDK's save handler.
//
// Wrapped in an async IIFE rather than top-level await so the
// module evaluates without TLA semantics — vite-plugin-singlefile
// flattens chunks in a way that interacts poorly with TLA wrappers.
import { mount } from "svelte";
import App from "./App.svelte";
import { loadRuntime } from "virtual:workbook-runtime";
import { bootstrapLoro } from "./lib/loroBackend.svelte.js";

(async () => {
  try {
    // Load + mount the workbook runtime. Registers <wb-doc> with the
    // runtime client and exposes window.__wbRuntime for tooling
    // (save handler, loroBackend).
    const { wasm, bundle } = await loadRuntime();
    await bundle.mountHtmlWorkbook({
      loadWasm: () => Promise.resolve(wasm),
    });

    // Hand the runtime-registered LoroDocHandle to loroBackend so
    // the studio's existing API (getDoc / readComposition /
    // writeComposition) keeps working unchanged.
    await bootstrapLoro();
  } catch (e) {
    console.error("hyperframes-studio: runtime bootstrap failed:", e);
    // Continue anyway with empty state — the app is still usable;
    // composition starts from INITIAL_COMPOSITION rather than
    // restored bytes.
  }
  mount(App, { target: document.getElementById("app") });
})();
