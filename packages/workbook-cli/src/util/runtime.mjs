// Resolve where the workbook runtime assets live: wasm-bindgen JS,
// the wasm bytes, the runtime bundle, and the shared design.css.
//
// Two cases:
//   1. CLI run inside the workbooks monorepo — use sibling packages
//      (../runtime-wasm/pkg, ../runtime-wasm/examples/...).
//   2. CLI run in a downstream project that depends on
//      @work.books/runtime-wasm via npm — resolve via node_modules.
//      The published tarball ships pkg/ + examples/ in the same
//      layout the monorepo uses, so once we locate the package root,
//      the rest of the resolver is identical.
//
// Override either case via --runtime <path>.

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function resolveNpmRuntimeWasm() {
  // require.resolve traverses up from the CLI's location through
  // every parent node_modules — finds the package whether it's
  // installed alongside this CLI (global -g install) or hoisted
  // into a downstream project's tree.
  try {
    const pkgJson = require.resolve("@work.books/runtime-wasm/package.json");
    return path.dirname(pkgJson);
  } catch {
    return null;
  }
}

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

/** Map a config-level variant name to the pkg directory shipped by
 *  runtime-wasm. Variants are pre-built slices of the same crate
 *  with different cargo features turned on, see runtime-wasm/Cargo.toml.
 *
 *    "default" / undefined → pkg/         (full ~16 MB; everything)
 *    "minimal"             → pkg-minimal/ (~888 KB; SQL/Polars off)
 *    "app"                 → pkg-app/     (~140 KB; SPA-shape only —
 *                                          no Polars, no Plotters,
 *                                          no Rhai, no Arrow)
 *
 *  Workbooks declare which variant they need in workbook.config.mjs:
 *    export default { wasmVariant: "app", ... }
 *  Picking a slice that's missing a feature the workbook actually
 *  uses surfaces as a runtime error; the cli does not (yet) verify
 *  variant compatibility against the workbook's wb.* surface usage.
 */
function variantToPkgDir(variant) {
  switch (variant) {
    case "minimal": return "pkg-minimal";
    case "app":     return "pkg-app";
    case "default":
    case undefined:
    case null:      return "pkg";
    default:
      throw new Error(
        `unknown wasmVariant=${JSON.stringify(variant)}. ` +
        `Use "default", "minimal", or "app".`,
      );
  }
}

export async function resolveRuntime(opts = {}) {
  // Candidate roots, in priority order:
  //   1. explicit --runtime override
  //   2. monorepo subtree (when CLI runs inside packages/workbook-cli)
  //   3. npm-installed @work.books/runtime-wasm (when CLI runs as a
  //      published package — global install, npx, or downstream dep)
  const candidates = [];
  if (opts.override) candidates.push(path.resolve(opts.override));
  candidates.push(path.resolve(HERE, "..", "..", "..", "runtime-wasm"));
  candidates.push(path.resolve(HERE, "..", "..", "..", "..", "packages", "runtime-wasm"));
  const npmRoot = resolveNpmRuntimeWasm();
  if (npmRoot) candidates.push(npmRoot);

  const requestedPkgDir = variantToPkgDir(opts.variant);

  // Pick the first candidate that has the runtime at the requested
  // variant. If none has the requested variant, fall back to any
  // candidate that has the default pkg/ — variants are a size
  // optimization, not a correctness feature, and the npm package
  // only ships pkg/. Warn so authors know what happened.
  let runtimeWasm = null;
  let pkgDir = requestedPkgDir;
  for (const c of candidates) {
    if (await exists(path.join(c, requestedPkgDir, "workbook_runtime.js"))) {
      runtimeWasm = c;
      break;
    }
  }
  if (!runtimeWasm && requestedPkgDir !== "pkg") {
    for (const c of candidates) {
      if (await exists(path.join(c, "pkg", "workbook_runtime.js"))) {
        runtimeWasm = c;
        pkgDir = "pkg";
        if (!opts.quiet) {
          console.warn(
            `[workbook] wasmVariant="${opts.variant}" not available in resolved runtime ` +
            `(${c}); falling back to "default" (pkg/). To use the slim variant, ` +
            `build it from the monorepo or use a runtime-wasm release that ships ${requestedPkgDir}/.`,
          );
        }
        break;
      }
    }
  }

  if (!runtimeWasm) {
    const tried = candidates.map((c) => `  ${c}/${requestedPkgDir}/`).join("\n");
    const buildHint = requestedPkgDir === "pkg"
      ? "Install it: npm install @work.books/runtime-wasm\n" +
        "Or build from source: cd packages/runtime-wasm && wasm-pack build --target web --release"
      : `Build the ${requestedPkgDir} variant: cd packages/runtime-wasm && wasm-pack build --out-dir ${requestedPkgDir} --target web --release --no-default-features <features-for-${opts.variant}>`;
    throw new Error(
      `could not locate @work.books/runtime-wasm. Tried:\n` +
      tried + "\n" + buildHint + "\nOr pass --runtime <path>.",
    );
  }

  // examples/ layout: in the monorepo it sits at the repo root
  // (../../examples relative to packages/runtime-wasm). In the npm
  // tarball the same files ship at <pkg-root>/examples/. Try both.
  const monorepoExamples = path.resolve(runtimeWasm, "..", "..", "examples");
  const npmExamples = path.join(runtimeWasm, "examples");
  let examplesRoot = (await exists(path.join(monorepoExamples, "_shared", "design.css")))
    ? monorepoExamples
    : npmExamples;

  const sharedDir = path.join(examplesRoot, "_shared");
  const bundlePath = path.join(examplesRoot, "reactive-cells", "runtime.bundle.js");
  const bindgenPath = path.join(runtimeWasm, pkgDir, "workbook_runtime.js");
  const wasmPath = path.join(runtimeWasm, pkgDir, "workbook_runtime_bg.wasm");
  const designCssPath = path.join(sharedDir, "design.css");

  for (const p of [bundlePath, bindgenPath, wasmPath, designCssPath]) {
    if (!(await exists(p))) {
      throw new Error(`workbook-runtime asset missing: ${p}`);
    }
  }

  return {
    runtimeWasm,
    pkgDir,
    bundlePath,
    bindgenPath,
    wasmPath,
    designCssPath,
  };
}

export async function readRuntimeAssets(runtime) {
  const [bindgenJs, bundleSrc, designCss, wasmBytes] = await Promise.all([
    fs.readFile(runtime.bindgenPath, "utf8"),
    fs.readFile(runtime.bundlePath, "utf8"),
    fs.readFile(runtime.designCssPath, "utf8"),
    fs.readFile(runtime.wasmPath),
  ]);

  // Strip wasm-bindgen's `new URL(name, import.meta.url)` because
  // import.meta.url is opaque inside a blob: module — we hand the
  // wasm bytes to init() directly so the URL line never executes,
  // but it does parse, and that's the failure mode otherwise.
  const safeBindgen = bindgenJs.replace(
    /new URL\([\s\S]*?import\.meta\.url\)/g,
    "undefined /* stripped: caller supplies bytes */",
  );

  return {
    bindgenJs: safeBindgen,
    bundleSrc,
    designCss,
    wasmBytes,
    wasmB64: Buffer.from(wasmBytes).toString("base64"),
  };
}
