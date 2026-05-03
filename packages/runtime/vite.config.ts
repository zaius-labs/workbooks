import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "path";

/**
 * Build configuration for @workbook/runtime.
 *
 * Produces a CDN-deployable ESM bundle at dist/workbook-runtime.js plus a
 * library-mode export tree.
 *
 * Consumed by:
 *   - apps/web (workspace import, dev-mode)
 *   - exported .workbook files (CDN reference at cdn.signal.app/workbook-runtime/v1.js)
 */
export default defineConfig({
  plugins: [svelte()],
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: () => "workbook-runtime.js",
    },
    rollupOptions: {
      // Externalize all non-relative imports. Block components reach into a
      // wide ecosystem (mermaid, deck.gl, plotly, three, cytoscape, …);
      // bundling them all would balloon the CDN artifact. Externals are
      // resolved at load time — apps/web supplies them via its dependency
      // graph; an exported workbook references them from CDN.
      external: (id) => !id.startsWith(".") && !id.startsWith("/"),
    },
    sourcemap: true,
    minify: "esbuild",
    target: "es2022",
  },
});
