// Workbook config loader. Looks for workbook.config.{js,mjs} in the
// project root, validates required fields, applies defaults.
//
// A minimal config:
//
//   export default {
//     name: "my workbook",
//     slug: "my-workbook",
//     entry: "src/index.html",
//   };
//
// Extended:
//
//   export default {
//     name: "my workbook",
//     slug: "my-workbook",
//     entry: "src/index.html",
//     env: {
//       OPENROUTER_API_KEY: { required: true, secret: true, prompt: "sk-or-…" },
//     },
//     runtimeFeatures: ["polars", "rhai", "charts"],  // hint only, not enforced
//     vite: { /* extra Vite config merged in */ },
//   };

import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const CANDIDATES = ["workbook.config.mjs", "workbook.config.js"];

export async function loadConfig(projectDir) {
  const root = path.resolve(projectDir);
  let configPath = null;
  for (const c of CANDIDATES) {
    const p = path.join(root, c);
    try { await fs.access(p); configPath = p; break; } catch {}
  }
  if (!configPath) {
    throw new Error(
      `no workbook.config.{js,mjs} found in ${root}.\n` +
      `Create one with at minimum: { name, slug, entry }.`,
    );
  }

  const mod = await import(pathToFileURL(configPath).href);
  const cfg = mod.default ?? mod;
  if (!cfg || typeof cfg !== "object") {
    throw new Error(`${configPath} did not export a config object (use 'export default {...}')`);
  }

  if (!cfg.slug || typeof cfg.slug !== "string") {
    throw new Error(`workbook.config: 'slug' is required (string, kebab-case)`);
  }
  if (!cfg.entry || typeof cfg.entry !== "string") {
    throw new Error(`workbook.config: 'entry' is required (path to entry HTML file, relative to project root)`);
  }
  const entryAbs = path.resolve(root, cfg.entry);
  try { await fs.access(entryAbs); } catch {
    throw new Error(`workbook.config: entry not found: ${cfg.entry} (resolved to ${entryAbs})`);
  }

  // Workbook type — canonical rendering profile. Must be one of:
  //   "document" — sdoc-style read-mostly artifact (prose + auto-rendered blocks)
  //   "notebook" — Jupyter-style linear runner with cells + reactive DAG
  //   "spa"      — full canvas app (chat-app, svelte-app); author renders custom UI
  // Defaults to "spa" since it's the least opinionated.
  const VALID_TYPES = new Set(["document", "notebook", "spa"]);
  const type = cfg.type ?? "spa";
  if (!VALID_TYPES.has(type)) {
    throw new Error(`workbook.config: 'type' must be one of: ${[...VALID_TYPES].join(", ")} (got '${type}')`);
  }

  // Icons — accept short form (single string path) or long form (array of
  // { src, sizes?, type? }). Normalize to the long form. If neither is
  // provided, the build plugin substitutes a default workbook glyph so
  // every saved .workbook.html has a recognizable browser-tab icon.
  let icons = null;
  if (typeof cfg.icon === "string" && cfg.icon) {
    icons = [{ src: cfg.icon }];
  } else if (Array.isArray(cfg.icons)) {
    icons = cfg.icons.map((entry, i) => {
      if (typeof entry === "string") return { src: entry };
      if (entry && typeof entry === "object" && typeof entry.src === "string") {
        return { src: entry.src, sizes: entry.sizes, type: entry.type };
      }
      throw new Error(
        `workbook.config: icons[${i}] must be a string path or { src, sizes?, type? }`,
      );
    });
  }
  if (icons) {
    for (const icon of icons) {
      const abs = path.resolve(root, icon.src);
      try { await fs.access(abs); }
      catch { throw new Error(`workbook.config: icon not found: ${icon.src} (resolved to ${abs})`); }
    }
  }

  return {
    root,
    configPath,
    name: cfg.name ?? cfg.slug,
    slug: cfg.slug,
    type,
    version: cfg.version ?? "0.1",
    entry: cfg.entry,
    entryAbs,
    env: cfg.env ?? {},
    icons,                      // null means "use the default workbook glyph"
    runtimeFeatures: cfg.runtimeFeatures ?? [],
    vite: cfg.vite ?? {},
    // Inline assets unless explicitly disabled; --no-wasm flag flips this.
    inlineRuntime: cfg.inlineRuntime ?? true,
  };
}
