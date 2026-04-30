// Resolve where the workbook runtime assets live: wasm-bindgen JS,
// the wasm bytes, the runtime bundle, and the shared design.css.
//
// Two cases:
//   1. CLI run inside the workbooks monorepo — use sibling packages
//      (../runtime-wasm/pkg, ../runtime-wasm/examples/...).
//   2. CLI run in a downstream project that depends on @workbook/runtime
//      and @workbook/runtime-wasm via npm — resolve via node_modules.
//
// For now (v1) we only support case 1. Override via --runtime <path>
// when needed.

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

export async function resolveRuntime(opts = {}) {
  // Walk up from the CLI's own location to find packages/runtime-wasm.
  // CLI lives at packages/workbook-cli/src/util/runtime.mjs → ../../../../packages/runtime-wasm.
  const candidates = [];
  if (opts.override) candidates.push(path.resolve(opts.override));
  candidates.push(path.resolve(HERE, "..", "..", "..", "runtime-wasm"));
  candidates.push(path.resolve(HERE, "..", "..", "..", "..", "packages", "runtime-wasm"));

  let runtimeWasm = null;
  for (const c of candidates) {
    if (await exists(path.join(c, "pkg", "workbook_runtime.js"))) {
      runtimeWasm = c; break;
    }
  }
  if (!runtimeWasm) {
    const tried = candidates.map((c) => `  ${c}`).join("\n");
    throw new Error(
      "could not locate workbook-runtime-wasm pkg/ output. Tried:\n" +
      tried + "\n" +
      "Build it first: cd packages/runtime-wasm && wasm-pack build --target web --release\n" +
      "Or pass --runtime <path>.",
    );
  }

  // examples/ lives at the repo root (was hoisted out of runtime-wasm
  // in commit bad45b3). reactive-cells and _shared are runtime assets
  // that happen to live alongside the user-facing examples; long term
  // they should move into runtime-wasm/ as internal assets.
  const examplesRoot = path.resolve(runtimeWasm, "..", "..", "examples");
  const sharedDir = path.join(examplesRoot, "_shared");
  const bundlePath = path.join(examplesRoot, "reactive-cells", "runtime.bundle.js");
  const bindgenPath = path.join(runtimeWasm, "pkg", "workbook_runtime.js");
  const wasmPath = path.join(runtimeWasm, "pkg", "workbook_runtime_bg.wasm");
  const designCssPath = path.join(sharedDir, "design.css");

  // Validate everything exists.
  for (const p of [bundlePath, bindgenPath, wasmPath, designCssPath]) {
    if (!(await exists(p))) {
      throw new Error(`workbook-runtime asset missing: ${p}`);
    }
  }

  return {
    runtimeWasm,
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
