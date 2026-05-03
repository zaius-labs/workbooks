// Static check: does the chosen wasmVariant actually cover the
// symbols the workbook calls?
//
// wasmVariant is hint-only — pick "app" but call wasm.runPolarsSql()
// and the workbook breaks at runtime with "is not a function." Catch
// that at build time by:
//
//   1. Reading the full pkg/'s d.ts as the universe of symbols
//      runtime-wasm CAN export.
//   2. Reading the chosen variant's d.ts as the symbols actually
//      exported in this build.
//   3. Computing universe - chosen = "symbols only available in
//      heavier variants."
//   4. Scanning the user's bundle for property accesses matching
//      any of those names. A hit means the workbook is calling a
//      function the chosen variant doesn't ship — variant is too
//      small.
//
// We warn (not error) since the regex match is best-effort: a false
// positive on a coincidentally-named property is possible, and a
// build-time error would be more annoying than a runtime warning the
// developer can read at first launch. The warning's message names the
// missing symbol(s) and the smallest variant that covers all of them.
//
// The fallback also handles the inverse case ("you picked default
// but only call symbols in the app slice — you could go smaller")
// since that's the same shape of analysis. A smaller-variant
// suggestion is informational; nothing breaks.

import path from "node:path";
import fs from "node:fs/promises";

/** Variants in order from smallest to largest. The first variant
 *  whose export set covers all `usedSymbols` is the recommended
 *  minimum for the workbook. */
const VARIANTS_ASCENDING = ["app", "minimal", "default"];

const VARIANT_TO_PKG_DIR = {
  app:     "pkg-app",
  minimal: "pkg-minimal",
  default: "pkg",
};

/** Extract every `export function name(` from a wasm-bindgen .d.ts
 *  file. Returns a Set of symbol names. */
async function readVariantExports(runtimeDir, variant) {
  const dts = path.join(runtimeDir, VARIANT_TO_PKG_DIR[variant], "workbook_runtime.d.ts");
  let src;
  try { src = await fs.readFile(dts, "utf8"); }
  catch { return null; }
  const out = new Set();
  for (const m of src.matchAll(/^export function ([A-Za-z_][A-Za-z0-9_]*)\(/gm)) {
    out.add(m[1]);
  }
  return out;
}

/** Best-effort scan for property accesses against bundled JS.
 *  We only consider symbols ≥ 6 chars that look distinctive — the
 *  chance of a coincidental hit on something like `.runPolarsSql`
 *  is essentially zero, while short names like `.run` would false-
 *  positive on every codebase. */
function scanForUsage(bundleSrc, candidates) {
  const used = new Set();
  for (const sym of candidates) {
    if (sym.length < 6) continue; // skip too-generic names
    // Word-boundary property access: foo.<sym>(  or  foo.<sym>  ,
    // also via destructure  { <sym> }  or  { <sym>: ...
    const re = new RegExp(`(?:\\.|\\{\\s*)${sym}\\b`);
    if (re.test(bundleSrc)) used.add(sym);
  }
  return used;
}

/**
 * Run the variant check on a built bundle.
 *
 * @param {object} args
 * @param {string} args.runtimeDir Absolute path to packages/runtime-wasm.
 * @param {string} args.variant    The wasmVariant the workbook picked.
 * @param {string} args.bundleSrc  The bundled JS / HTML to scan.
 * @returns {Promise<{warnings: string[]}>}
 */
export async function checkVariant({ runtimeDir, variant, bundleSrc }) {
  const warnings = [];

  // Always read the default variant as the universe — pkg/ has every
  // exported symbol since it has every feature on. If the project
  // didn't build pkg/ (uncommon), we silently skip the check.
  const universe = await readVariantExports(runtimeDir, "default");
  if (!universe) return { warnings };
  const chosenExports = await readVariantExports(runtimeDir, variant);
  if (!chosenExports) return { warnings };

  // Symbols that ONLY exist in heavier variants ("the things picking
  // a smaller variant takes away"). If the bundle uses any of these,
  // the variant is too small.
  const heavyOnly = new Set();
  for (const sym of universe) if (!chosenExports.has(sym)) heavyOnly.add(sym);

  const usedHeavy = scanForUsage(bundleSrc, heavyOnly);
  if (usedHeavy.size > 0) {
    // Find the smallest variant that covers every used heavy symbol.
    let recommended = "default";
    for (const v of VARIANTS_ASCENDING) {
      if (v === variant) continue; // skip the one we already know fails
      const exp = await readVariantExports(runtimeDir, v);
      if (!exp) continue;
      let covers = true;
      for (const sym of usedHeavy) if (!exp.has(sym)) { covers = false; break; }
      if (covers) { recommended = v; break; }
    }
    const list = [...usedHeavy].sort();
    const preview = list.slice(0, 6).join(", ") + (list.length > 6 ? `, +${list.length - 6} more` : "");
    warnings.push(
      `wasmVariant="${variant}" is missing ${list.length} ` +
      `symbol${list.length === 1 ? "" : "s"} the bundle references (${preview}). ` +
      `Either switch to wasmVariant="${recommended}", remove the calls, or ` +
      `set wasmVariantCheck: false if these are feature-detected fallbacks.`,
    );
    return { warnings };
  }

  // Inverse hint: if the user picked a heavier variant but doesn't
  // need it, suggest dropping. Only fires when the workbook isn't
  // already on the smallest variant.
  if (variant !== "app") {
    let smallestThatWorks = variant;
    for (const v of VARIANTS_ASCENDING) {
      const exp = await readVariantExports(runtimeDir, v);
      if (!exp) continue;
      // Does this variant cover everything currently exported by the
      // chosen one that the bundle actually uses? Same question,
      // different framing: scan the bundle for any chosen symbols
      // not in this candidate.
      const wouldDrop = new Set();
      for (const sym of chosenExports) if (!exp.has(sym)) wouldDrop.add(sym);
      const usedDrop = scanForUsage(bundleSrc, wouldDrop);
      if (usedDrop.size === 0) { smallestThatWorks = v; break; }
    }
    if (smallestThatWorks !== variant) {
      warnings.push(
        `wasmVariant="${variant}" larger than needed — bundle would work with ` +
        `wasmVariant="${smallestThatWorks}". Saves ~MB on the .html.`,
      );
    }
  }

  return { warnings };
}
