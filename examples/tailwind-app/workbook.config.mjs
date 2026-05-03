// tailwind-app — analyst dashboard authored in Svelte + Tailwind v4.
// Demonstrates the CLI's ability to merge user-supplied Vite plugins
// (here: @tailwindcss/vite) with the workbook plugin chain.
//
// Same SPA workbook shape as svelte-app and notebook-agent — different
// CSS authoring style. Output is one .html that runs from
// file:// with all CSS, JS, wasm, and assets inlined.
import tailwindcss from "@tailwindcss/vite";

export default {
  name: "tailwind-app · workbook",
  slug: "tailwind-app",
  type: "spa",
  version: "0.1",
  entry: "src/index.html",
  vite: {
    plugins: [tailwindcss()],
  },
  runtimeFeatures: ["polars", "rhai", "charts"],
};
