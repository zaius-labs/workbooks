import { mount } from "svelte";
import App from "./App.svelte";
import { bootstrapLoro } from "./lib/loroBackend.svelte.js";

// Block Svelte mount on Loro bootstrap. The composition + assets
// stores' constructors read from the Loro doc to hydrate; if we
// mount first, they render with default INITIAL_COMPOSITION values
// for ~50-200 ms before the bootstrap promise resolves and snaps
// the iframe to the saved state. Awaiting first eliminates the
// flash entirely.
//
// Loro is inlined as base64 in the bundle (no network), so this is
// just WASM instantiation + IDB read — typically under 100 ms even
// on cold starts. The brief blank-page window is preferable to a
// visible content flash.
//
// Wrapped in an async IIFE rather than top-level await so the
// module evaluates without TLA semantics — vite-plugin-singlefile
// flattens chunks in a way that interacts poorly with TLA wrappers.
(async () => {
  try {
    await bootstrapLoro();
  } catch (e) {
    // bootstrapLoro itself swallows the missing-peer-dep case and
    // returns null. Anything that lands here is unexpected — surface
    // to console, app continues with empty state.
    console.error("hf: loro bootstrap failed:", e);
  }
  mount(App, { target: document.getElementById("app") });
})();
