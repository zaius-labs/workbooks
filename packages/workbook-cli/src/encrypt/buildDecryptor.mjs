// Bundle the decryptor source + age-encryption into a single self-
// contained string we can inline as a <script> tag.
//
// We use esbuild's programmatic API (it ships with Vite, so no extra
// deps for users). Result is cached per process — bundling takes
// ~150ms cold and we only need to do it once per `workbook build`.

import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, "decryptorSource.mjs");

let cachedCode = null;

/** Returns the bundled decryptor JS (IIFE, minified). */
export async function getDecryptorBundle() {
  if (cachedCode) return cachedCode;
  const result = await esbuild.build({
    entryPoints: [SOURCE],
    bundle: true,
    format: "iife",
    target: "es2020",
    platform: "browser",
    minify: true,
    write: false,
    legalComments: "none",
    // Pull age-encryption (and its deps: @noble/ciphers, @noble/curves,
    // @noble/hashes, @scure/base) into the bundle. Resolved through the
    // monorepo's node_modules at build time.
    external: [],
  });
  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error("decryptor bundle: esbuild produced no output");
  }
  cachedCode = result.outputFiles[0].text;
  return cachedCode;
}
