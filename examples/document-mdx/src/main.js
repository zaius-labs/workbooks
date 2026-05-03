// Mount the .svx page, then hand the rendered DOM to
// mountHtmlWorkbook so any <wb-cell> elements (emitted by the
// remark-workbook-cells plugin) get parsed + executed by the
// runtime's reactive cell DAG.
import { mount, tick } from "svelte";
import App from "./App.svx";
import { loadRuntime } from "virtual:workbook-runtime";

const target = document.getElementById("app");
mount(App, { target });

// Wrap async setup in an IIFE — esbuild's default target doesn't
// allow top-level await. Promise rejection surfaces in the console.
(async () => {
  // Wait one Svelte tick so the .svx component has rendered all its
  // wb-cell / wb-input / wb-output elements into the DOM, then bind
  // the workbook runtime to them.
  await tick();
  const { wasm, bundle } = await loadRuntime();
  await bundle.mountHtmlWorkbook({ loadWasm: async () => wasm });
})();
