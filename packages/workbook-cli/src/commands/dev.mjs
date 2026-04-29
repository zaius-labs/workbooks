// `workbook dev` — start a Vite dev server for the project.

import path from "node:path";
import fs from "node:fs/promises";
import { createServer } from "vite";
import { loadConfig } from "../util/config.mjs";
import workbookPlugin from "../plugins/workbookInline.mjs";

export async function runDev({ project = ".", port, runtime } = {}) {
  const config = await loadConfig(project);
  const plugins = [workbookPlugin({ config, runtimeOverride: runtime })];

  // Auto-load Svelte plugin if the project has it as a dep.
  const sveltePlugin = await tryLoadSveltePlugin(config.root);
  if (sveltePlugin) plugins.unshift(sveltePlugin);

  // Mirror build: serve from the entry's parent dir so / maps to
  // index.html (instead of /src/index.html mirroring the source layout).
  const entryAbs = path.resolve(config.root, config.entry);
  const viteRoot = path.dirname(entryAbs);

  // Merge user-supplied vite config — see build.mjs for rationale.
  const { plugins: userPlugins = [], server: userServer = {}, ...userVite } =
    config.vite ?? {};

  const server = await createServer({
    root: viteRoot,
    ...userVite,
    plugins: [...userPlugins, ...plugins],
    server: {
      ...userServer,
      port: port ? Number(port) : (userServer.port ?? 5173),
      open: false,
      fs: {
        ...(userServer.fs ?? {}),
        // Allow Vite to read sibling packages (runtime-wasm pkg etc.).
        allow: [config.root, path.resolve(config.root, "..", "..")],
      },
    },
  });
  await server.listen();
  server.printUrls();
  process.stdout.write(`\n[workbook] dev — slug=${config.slug} entry=${config.entry}\n`);
}

async function tryLoadSveltePlugin(root) {
  // Look for @sveltejs/vite-plugin-svelte either in the project or a
  // sibling/up-tree node_modules.
  try {
    const mod = await import("@sveltejs/vite-plugin-svelte");
    return mod.svelte();
  } catch {
    return null;
  }
}
