// Vite plugin: resolve `workbook:*` virtual module imports to the SDK
// source shipped with @work.books/cli.
//
// This is the heart of the "make it almost impossible to mess up"
// strategy. Today, examples reach past the runtime to apache-arrow,
// polars-wasm, raw onnx — every leaked surface is a footgun. This
// plugin defines a controlled, ergonomic set of imports:
//
//   import { fromArrays, tableFromIPC } from "workbook:data"
//   // (more namespaces forthcoming: workbook:ml, workbook:ui, workbook:runtime)
//
// And resolves them to vetted source files in this package's src/sdk/.
// Underlying packages (apache-arrow, polars-wasm, candle) get bundled
// transitively as before — but the user surface is the facade, and
// `workbook check` lints any direct import of the underlying packages.

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const VIRTUAL_PREFIX = "workbook:";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = path.resolve(HERE, "..", "sdk");

// Single source of truth for which virtual namespaces exist. Adding a
// new namespace = adding an .mjs file under src/sdk/ AND an entry here.
const NAMESPACES = new Map([
  ["data", "data.mjs"],
  // future: ["ml", "ml.mjs"], ["ui", "ui.mjs"], ["runtime", "runtime.mjs"]
]);

export default function workbookVirtualModulesPlugin() {
  return {
    name: "workbook:virtual-modules",
    enforce: "pre",
    async resolveId(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      const ns = id.slice(VIRTUAL_PREFIX.length);
      const file = NAMESPACES.get(ns);
      if (!file) {
        // Unknown namespace — surface a clear error rather than letting
        // it fall through and produce a confusing "module not found".
        throw new Error(
          `unknown 'workbook:' virtual module: '${id}'. ` +
          `available: ${[...NAMESPACES.keys()].map((n) => `'workbook:${n}'`).join(", ")}`,
        );
      }
      const abs = path.join(SDK_ROOT, file);
      try {
        await fs.access(abs);
      } catch {
        throw new Error(
          `workbook:virtual-modules: '${id}' is registered but its ` +
          `source file is missing at ${abs}. This is a packaging bug — ` +
          `please file an issue.`,
        );
      }
      return abs;
    },
  };
}
