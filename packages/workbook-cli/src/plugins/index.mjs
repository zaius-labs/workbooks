// Programmatic plugin entrypoint — for users who want to drive Vite
// directly with their own config. Equivalent to what `workbook dev`
// and `workbook build` use internally.
//
// Usage in vite.config.js:
//
//   import { workbookPlugin } from "@workbook/cli/vite";
//   import { svelte } from "@sveltejs/vite-plugin-svelte";
//   export default {
//     plugins: [
//       svelte(),
//       workbookPlugin({ config: { slug: "my-app", entry: "src/index.html" } }),
//     ],
//   };

export { default as workbookPlugin } from "./workbookInline.mjs";
export { default as workbookVirtualModulesPlugin } from "./virtualModules.mjs";
