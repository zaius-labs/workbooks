import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
  // Svelte 5 with runes. No legacy reactivity.
  compilerOptions: {
    runes: true,
  },
};
