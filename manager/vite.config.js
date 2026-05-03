import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Tauri builds with Vite — no SSR, no hydration, just a single
// HTML entry that Tauri's webview loads. Dev server runs on a
// fixed port so tauri.conf.json can wire `devPath` to it.
export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
  },
  // Tauri loads the built bundle from src-tauri/../dist by default.
  build: {
    target: "esnext",
    minify: "esbuild",
    sourcemap: false,
  },
});
