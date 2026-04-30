// Recursive directory walker for `workbook check`. Intentionally tiny:
// no glob lib, no .gitignore parser. Skips well-known build/dep dirs.

import fs from "node:fs/promises";
import path from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".cache",
  ".parcel-cache",
  ".vite",
  ".svelte-kit",
  ".turbo",
  "target", // rust build dir (vendored crates)
  "pkg",    // wasm-bindgen output
]);

/**
 * Walk a directory tree, yielding files whose extension is in the
 * given set. Skips SKIP_DIRS at every level.
 *
 * @param {string} root            absolute or relative directory
 * @param {Set<string>} extensions e.g. new Set(["js","mjs","svelte"])
 * @returns {AsyncGenerator<{abs: string, rel: string}>}
 */
export async function* walkFiles(root, extensions) {
  const absRoot = path.resolve(root);
  yield* recurse(absRoot, "", extensions);
}

async function* recurse(absDir, relPrefix, extensions) {
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    if (ent.name.startsWith(".") && ent.name !== ".gitignore") continue;
    const abs = path.join(absDir, ent.name);
    const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      yield* recurse(abs, rel, extensions);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).slice(1).toLowerCase();
      if (extensions.has(ext)) yield { abs, rel };
    }
  }
}
