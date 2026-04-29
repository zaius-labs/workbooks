// Vite plugin: inject the workbook runtime + spec into the final
// HTML at build (and serve a small dev-mode shim in dev).
//
// Two phases:
//   1. transformIndexHtml — runs in both dev + build. We add the
//      workbook-spec script tag (manifest as JSON) and a banner
//      that tells the user this is a workbook.
//   2. closeBundle — only in build. After Vite has emitted the
//      bundled HTML, we rewrite it to inline wasm + bindgen + bundle
//      as <script type="text/plain"> blocks (the "portable assets"
//      block).
//
// In dev mode we DON'T inline the wasm — instead, the dev page
// imports from the runtime-wasm pkg/ directly via a virtual module.
// That keeps reload fast and avoids re-encoding 13 MB of base64 on
// every save.

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveRuntime, readRuntimeAssets } from "../util/runtime.mjs";
import { escapeForScript, makeSentinels, makeAssetTag, TRIGGER } from "../util/triggerSafe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ICON_PATH = path.resolve(HERE, "..", "..", "templates", "default-icon.svg");

const VIRTUAL_RUNTIME_ID = "virtual:workbook-runtime";
const RESOLVED_RUNTIME_ID = "\0" + VIRTUAL_RUNTIME_ID;

// Runtime loader. Lives inside the virtual module so it ships with
// the user's bundle. Detects portable mode (inlined assets) vs dev
// mode (HTTP fetch) and returns { wasm, bundle, initWasm }.
const RUNTIME_LOADER_SRC = String.raw`
let _cached;

function base64ToBytes(b64) {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function loadRuntime() {
  if (_cached) return _cached;
  const wasmEl = typeof document !== "undefined" ? document.getElementById("wasm-b64") : null;
  const bindgenEl = typeof document !== "undefined" ? document.getElementById("bindgen-src") : null;
  const bundleEl = typeof document !== "undefined" ? document.getElementById("runtime-bundle-src") : null;
  const portable = wasmEl && bindgenEl && bundleEl && wasmEl.textContent.trim().length > 0;

  let wasm, bundle;
  if (portable) {
    const wasmBytes = base64ToBytes(wasmEl.textContent);
    const bindgenUrl = URL.createObjectURL(new Blob([bindgenEl.textContent], { type: "application/javascript" }));
    wasm = await import(/* @vite-ignore */ bindgenUrl);
    await wasm.default(wasmBytes);
    URL.revokeObjectURL(bindgenUrl);
    const bundleUrl = URL.createObjectURL(new Blob([bundleEl.textContent], { type: "application/javascript" }));
    bundle = await import(/* @vite-ignore */ bundleUrl);
    URL.revokeObjectURL(bundleUrl);
  } else {
    // Build URLs at runtime so the bundler doesn't try to resolve them.
    const base = "/" + "_" + "_workbook/";
    wasm = await import(/* @vite-ignore */ base + "bindgen.js");
    await wasm.default(base + "runtime.wasm");
    bundle = await import(/* @vite-ignore */ base + "bundle.js");
  }
  _cached = { wasm, bundle };
  return _cached;
}

async function initWasm() { return (await loadRuntime()).wasm; }

export { loadRuntime, initWasm };
export default loadRuntime;
`;

export default function workbookInline({ config, runtimeOverride } = {}) {
  let runtime = null;
  let resolvedConfig = null;

  return {
    name: "workbook-inline",
    enforce: "post",

    async configResolved(c) {
      resolvedConfig = c;
      runtime = await resolveRuntime({ override: runtimeOverride });
    },

    /**
     * Provide a virtual module so user code can do:
     *
     *   import { loadRuntime } from "virtual:workbook-runtime";
     *   const { wasm, bundle } = await loadRuntime();
     *   const out = wasm.runPolarsSql(sql, csv);
     *
     * Why a loader instead of direct imports: the runtime bundle has
     * optional peer deps (duckdb, deck.gl, etc.) that should NOT be
     * bundled into the user's app at build time. We inline the
     * runtime bundle JS as a side asset and import it at use time
     * via blob URLs. This also keeps the *user code* small even when
     * the runtime is heavy.
     *
     * In dev: the loader fetches /__workbook/<file> served by our
     * dev middleware (relative to the runtime-wasm package).
     * In build: the loader reads the inlined <script id> blocks and
     * imports via URL.createObjectURL.
     */
    resolveId(id) {
      if (id === VIRTUAL_RUNTIME_ID) return RESOLVED_RUNTIME_ID;
    },
    async load(id) {
      if (id !== RESOLVED_RUNTIME_ID) return;
      return RUNTIME_LOADER_SRC;
    },

    // Dev middleware: serve the runtime files at /__workbook/...
    // so dev mode can fetch them without us pre-encoding base64.
    configureServer(server) {
      const PREFIX = "/__workbook/";
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith(PREFIX)) return next();
        const slug = req.url.slice(PREFIX.length).split("?")[0];
        let target = null;
        if (slug === "bindgen.js") target = runtime.bindgenPath;
        else if (slug === "bundle.js") target = runtime.bundlePath;
        else if (slug === "runtime.wasm") target = runtime.wasmPath;
        if (!target) return next();
        try {
          const data = await fs.readFile(target);
          if (slug === "runtime.wasm") {
            res.setHeader("Content-Type", "application/wasm");
          } else {
            res.setHeader("Content-Type", "application/javascript");
            // Strip wasm-bindgen URL line for bindgen, same as build path.
            if (slug === "bindgen.js") {
              const stripped = data.toString("utf8").replace(
                /new URL\([\s\S]*?import\.meta\.url\)/g,
                "undefined /* stripped */",
              );
              return res.end(stripped);
            }
          }
          res.end(data);
        } catch (e) {
          res.statusCode = 500;
          res.end(String(e?.message ?? e));
        }
      });
    },

    /** Inject the workbook-spec script + favicon links. Runs in both
     * dev and build. */
    transformIndexHtml: {
      order: "post",
      async handler(html) {
        // Skip injection if the host page already has its own favicon
        // links — let the author opt out by simply declaring them.
        const hasUserIcon = /<link\s[^>]*rel\s*=\s*["']?(?:icon|shortcut icon)["']?/i.test(html);
        const iconLinks = hasUserIcon
          ? ""
          : await buildIconLinks(config);

        const spec = buildSpec(config);
        const specJson = escapeForScript(JSON.stringify(spec));
        const tagOpen = TRIGGER.TAG_SCRIPT_OPEN();
        const tagEnd = TRIGGER.TAG_SCRIPT_END();
        const specTag =
          `${tagOpen} id="workbook-spec" type="application/json">${specJson}${tagEnd}`;
        const injection = (iconLinks ? iconLinks + "\n" : "") + specTag;
        // Inject before </head>.
        const headClose = TRIGGER.HEAD_CLOSE();
        if (html.toLowerCase().includes(headClose)) {
          return html.replace(
            new RegExp(headClose, "i"),
            injection + "\n" + headClose,
          );
        }
        // No <head>? Prepend.
        return injection + "\n" + html;
      },
    },

    /** Build only: inline wasm + bindgen + bundle into the emitted
     * HTML so the resulting file runs without any siblings. We use
     * writeBundle (not closeBundle) and enforce: post above so this
     * runs AFTER other plugins (vite-plugin-singlefile) have written
     * the HTML to disk. */
    async writeBundle() {
      if (resolvedConfig.command !== "build") return;
      if (config.inlineRuntime === false) return;

      const outDir = resolvedConfig.build.outDir;
      try { await fs.access(outDir); }
      catch {
        process.stderr.write(`[workbook] outDir ${outDir} does not exist; skipping inline.\n`);
        return;
      }
      const htmlFiles = await collectHtml(outDir);
      if (!htmlFiles.length) {
        process.stderr.write(`[workbook] no .html files in ${outDir}; skipping inline.\n`);
        return;
      }

      const assets = await readRuntimeAssets(runtime);
      const { BEGIN, END } = makeSentinels();
      const block = [
        makeAssetTag("wasm-b64", "text/plain", assets.wasmB64),
        makeAssetTag("bindgen-src", "text/plain", escapeForScript(assets.bindgenJs)),
        makeAssetTag("runtime-bundle-src", "text/plain", escapeForScript(assets.bundleSrc)),
      ].join("\n");
      const wrapped = `${BEGIN}\n${block}\n${END}`;
      const headClose = TRIGGER.HEAD_CLOSE();
      const headCloseRe = new RegExp(headClose, "i");

      for (const file of htmlFiles) {
        let src = await fs.readFile(file, "utf8");
        if (headCloseRe.test(src)) {
          src = src.replace(headCloseRe, wrapped + "\n" + headClose);
        } else {
          src = wrapped + "\n" + src;
        }
        // Rename <slug>.html → <slug>.workbook.html unless the user
        // already used the .workbook.html extension.
        const base = path.basename(file);
        const dir = path.dirname(file);
        let target;
        if (base === "index.html") {
          target = path.join(dir, `${config.slug}.workbook.html`);
        } else if (base.endsWith(".workbook.html")) {
          target = file;
        } else {
          target = file.replace(/\.html$/, ".workbook.html");
        }
        await fs.writeFile(target, src);
        if (target !== file) await fs.rm(file);
        const sizeMb = (Buffer.byteLength(src) / 1024 / 1024).toFixed(1);
        process.stdout.write(
          `[workbook] inlined runtime → ${path.relative(process.cwd(), target)} (${sizeMb} MB)\n`,
        );
      }
    },
  };
}

function buildSpec(config) {
  return {
    manifest: {
      name: config.name,
      slug: config.slug,
      // Canonical rendering type: "document" | "notebook" | "spa".
      // Hosts use this to decide which chrome to wrap the workbook
      // in (or render it raw, in the SPA case).
      type: config.type ?? "spa",
      version: config.version,
      env: config.env ?? {},
      runtimeFeatures: config.runtimeFeatures ?? [],
    },
    cells: [],
    inputs: {},
  };
}

async function collectHtml(dir) {
  const out = [];
  async function walk(d) {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith(".html")) out.push(p);
    }
  }
  await walk(dir);
  return out;
}

// Build <link rel="icon"> tags for the workbook. Always inlines as a
// data: URL so the saved .workbook.html ships with the icon and a
// file:// open shows the right glyph in the browser tab. The
// ".workbook.html → OS file icon" association is a separate concern
// that needs platform-level registration; see core-7fw.1.
async function buildIconLinks(config) {
  const icons = config.icons ?? [{ src: DEFAULT_ICON_PATH, _isDefault: true }];
  const tags = [];
  for (const icon of icons) {
    const abs = icon._isDefault
      ? icon.src
      : path.resolve(config.root, icon.src);
    let bytes;
    try { bytes = await fs.readFile(abs); }
    catch (e) {
      process.stderr.write(`[workbook] icon not readable: ${abs}\n`);
      continue;
    }
    const ext = path.extname(abs).toLowerCase().slice(1);
    const mime = icon.type ?? extToMime(ext);
    const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
    const sizes = icon.sizes ? ` sizes="${escapeAttr(icon.sizes)}"` : "";
    const typeAttr = ` type="${escapeAttr(mime)}"`;
    tags.push(`<link rel="icon"${typeAttr}${sizes} href="${dataUrl}">`);
  }
  return tags.join("\n");
}

function extToMime(ext) {
  switch (ext) {
    case "svg":  return "image/svg+xml";
    case "png":  return "image/png";
    case "ico":  return "image/x-icon";
    case "gif":  return "image/gif";
    case "webp": return "image/webp";
    case "jpg":  case "jpeg": return "image/jpeg";
    default: return "application/octet-stream";
  }
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}
