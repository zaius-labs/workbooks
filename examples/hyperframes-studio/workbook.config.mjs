// hyperframes-studio — chat-on-left, player+timeline-on-right.
// An LLM agent edits an HTML video composition; a sandboxed iframe
// renders it; a parsed timeline shows clips with their data-start /
// data-duration. Same SPA workbook shape as svelte-app & tailwind-app.
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";

export default {
  name: "hyperframes-studio · workbook",
  slug: "hyperframes-studio",
  type: "spa",
  version: "0.1",
  entry: "src/index.html",
  vite: {
    // vite-plugin-wasm handles loro-crdt's ESM-integrated WASM init.
    //
    // We deliberately do NOT pair with vite-plugin-top-level-await:
    // vite-plugin-singlefile flattens every module into one inline
    // <script>, and the TLA plugin's IIFE wrapper produces TDZ
    // violations when its variables are read before the wrapper has
    // initialized them. Modern browsers support top-level await
    // natively at the module level, so target=esnext + native TLA
    // is the cleaner path. (If we ever need to support older
    // browsers, we'd need to disable singlefile too.)
    plugins: [tailwindcss(), wasm()],
    build: { target: "esnext" },
    resolve: {
      alias: [
        // just-bash imports node:zlib for its gzip/gunzip/zcat
        // commands (which the agent doesn't need for editing HTML).
        // Stub the import to avoid pulling a polyfill into the bundle.
        { find: "node:zlib", replacement: new URL("./src/lib/zlib-stub.js", import.meta.url).pathname },
      ],
    },
  },
  env: {
    OPENROUTER_API_KEY: {
      label: "openrouter api key",
      prompt: "sk-or-…",
      required: true,
      secret: true,
    },
  },
};
