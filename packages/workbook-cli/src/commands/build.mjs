// `workbook build` — compile project into a single .workbook.html.

import path from "node:path";
import { build as viteBuild } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { loadConfig } from "../util/config.mjs";
import workbookPlugin from "../plugins/workbookInline.mjs";
import workbookVirtualModulesPlugin from "../plugins/virtualModules.mjs";

export async function runBuild({ project = ".", out, runtime, wasm } = {}) {
  const config = await loadConfig(project);
  const outDir = path.resolve(config.root, out ?? "dist");
  const inlineRuntime = wasm === false ? false : config.inlineRuntime;

  const plugins = [
    // Resolve `workbook:*` virtual module imports to the SDK shipped
    // with the CLI. Must run before viteSingleFile/workbookPlugin so
    // the SDK source is in the module graph by the time inlining runs.
    workbookVirtualModulesPlugin(),
    // viteSingleFile inlines all JS + CSS into the HTML. Without it,
    // Vite emits separate /assets/*.js + .css files and the HTML
    // <script>/<link> them — which defeats single-file portability.
    viteSingleFile({
      removeViteModuleLoader: true,
      useRecommendedBuildConfig: true,
    }),
    workbookPlugin({ config: { ...config, inlineRuntime }, runtimeOverride: runtime }),
  ];

  const sveltePlugin = await tryLoadSveltePlugin(config.root);
  if (sveltePlugin) plugins.unshift(sveltePlugin);

  // Use the entry's parent dir as the Vite root so the entry sits
  // at "/index.html" — that gives us a flat dist/ instead of
  // dist/src/index.html mirroring the source layout.
  const entryAbs = path.resolve(config.root, config.entry);
  const viteRoot = path.dirname(entryAbs);

  // Merge user-supplied vite config last, but PREPEND any user plugins
  // to ours so they get first crack (e.g. @tailwindcss/vite needs to
  // see CSS before the workbook plugin or singlefile collapses it).
  // Spread-overwriting `plugins` from config.vite would drop our own
  // plugins entirely — explicit merge avoids that footgun.
  const { plugins: userPlugins = [], build: userBuild = {}, ...userVite } =
    config.vite ?? {};

  await viteBuild({
    root: viteRoot,
    ...userVite,
    plugins: [...userPlugins, ...plugins],
    build: {
      ...userBuild,
      outDir,
      emptyOutDir: true,
      rollupOptions: {
        ...(userBuild.rollupOptions ?? {}),
        input: entryAbs,
      },
      // Single-file output — no code splitting, no asset emission.
      // These four MUST stay set; user-supplied build options can
      // tweak everything else (target, minify, etc.) but not these.
      assetsInlineLimit: 100_000_000,
      cssCodeSplit: false,
      sourcemap: false,
    },
    logLevel: "info",
  });

  process.stdout.write(`[workbook] build complete · slug=${config.slug} → ${path.relative(process.cwd(), outDir)}\n`);
}

async function tryLoadSveltePlugin(root) {
  // Mirror dev.mjs — autoload mdsvex as a preprocessor when present.
  try {
    const sveltePlugin = await import("@sveltejs/vite-plugin-svelte");
    const mdsvex = await tryLoadMdsvex();
    if (mdsvex) {
      return sveltePlugin.svelte({
        extensions: [".svelte", ".svx"],
        preprocess: [mdsvex],
      });
    }
    return sveltePlugin.svelte();
  } catch {
    return null;
  }
}

async function tryLoadMdsvex() {
  try {
    const mod = await import("mdsvex");
    const { remarkWorkbookCells } = await import(
      "../plugins/remarkWorkbookCells.mjs"
    );
    return mod.mdsvex({
      extensions: [".svx"],
      remarkPlugins: [remarkWorkbookCells],
    });
  } catch {
    return null;
  }
}
