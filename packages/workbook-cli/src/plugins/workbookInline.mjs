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
import {
  escapeForScript,
  makeSentinels,
  makeAssetTag,
  TRIGGER,
  SLOT_PORTABLE,
} from "../util/triggerSafe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ICON_PATH = path.resolve(HERE, "..", "..", "templates", "default-icon.svg");
const SAVE_HANDLER_PATH = path.resolve(HERE, "..", "runtime-inject", "saveHandler.mjs");
const INSTALL_TOAST_PATH = path.resolve(HERE, "..", "runtime-inject", "installToast.mjs");

// Cache the inject sources after first read — they don't change
// during a build run.
let _saveHandlerSrc = null;
async function readSaveHandler() {
  if (_saveHandlerSrc !== null) return _saveHandlerSrc;
  _saveHandlerSrc = await fs.readFile(SAVE_HANDLER_PATH, "utf8");
  return _saveHandlerSrc;
}
let _installToastSrc = null;
async function readInstallToast() {
  if (_installToastSrc !== null) return _installToastSrc;
  _installToastSrc = await fs.readFile(INSTALL_TOAST_PATH, "utf8");
  return _installToastSrc;
}

// Sentinels for each injected block — kept separate so we can update
// any one independently on re-runs without disturbing the others.
function makeSaveSentinels() {
  return {
    BEGIN: "<!-- BEGIN workbook-save-handler -->",
    END: "<!-- END workbook-save-handler -->",
  };
}
function makeInstallToastSentinels() {
  return {
    BEGIN: "<!-- BEGIN workbook-install-toast -->",
    END: "<!-- END workbook-install-toast -->",
  };
}

// ----------------------------------------------------------------------
// Head-injection helpers — closes core-bii.
//
// The previous regex-based injector used a plain `</head>` lookup. That
// regex is unaware of JS scoping: if a user's bundled JS contains the
// substring "</head>" inside a template literal (legitimate in iframe
// srcdoc helpers and similar HTML-emitting code), the injector would
// land ~16 MB of base64 wasm INSIDE that template literal, severing
// the JS expression and corrupting the entire bundle.
//
// Fix: SLOT_PORTABLE — a unique sentinel comment — is emitted into
// the document head during the early HTML transform (order: "pre",
// before vite-plugin-singlefile inlines the user JS bundle). Later
// asset-injection passes anchor on the slot instead of </head>; by
// construction the slot lives outside any user code. The </head>
// regex is retained as a fallback only for HTML inputs that bypass
// transformIndexHtml entirely.
// ----------------------------------------------------------------------

/** Inject `content` into the document head. Prefers the SLOT_PORTABLE
 *  sentinel (placed during transformIndexHtml at order "pre") as the
 *  anchor. Falls back to a </head> regex for HTML inputs that haven't
 *  been through the slot-emitting transform. */
function injectIntoHead(html, content, { consumeSlot = false } = {}) {
  if (html.includes(SLOT_PORTABLE)) {
    const replacement = consumeSlot ? content : content + "\n" + SLOT_PORTABLE;
    return html.replace(SLOT_PORTABLE, replacement);
  }
  const headClose = TRIGGER.HEAD_CLOSE();
  if (html.toLowerCase().includes(headClose)) {
    return html.replace(new RegExp(headClose, "i"), content + "\n" + headClose);
  }
  return content + "\n" + html;
}

/** Ensure SLOT_PORTABLE is present in the document head. Idempotent
 *  — calling on an HTML that already has the slot returns it unchanged. */
function ensureSlot(html) {
  if (html.includes(SLOT_PORTABLE)) return html;
  const headClose = TRIGGER.HEAD_CLOSE();
  if (html.toLowerCase().includes(headClose)) {
    return html.replace(new RegExp(headClose, "i"), SLOT_PORTABLE + "\n" + headClose);
  }
  return SLOT_PORTABLE + "\n" + html;
}

// ----------------------------------------------------------------------
// Pure HTML transforms — used by both the Vite plugin (build path with
// component compilation) and the singleFile build path (hand-written
// HTML, no Vite). Keep these side-effect-free; callers handle I/O.
// ----------------------------------------------------------------------

/** Inject favicon link tags (data-URL inlined) and the workbook-spec
 *  JSON script into the document head. Skips favicon injection if the
 *  page already declares one. Idempotent — running twice is a no-op.
 *  Also ensures SLOT_PORTABLE is present so a subsequent
 *  inlinePortableAssets pass can anchor on it (closes core-bii). */
export async function injectSpecAndIcons(html, config) {
  const hasUserIcon = /<link\s[^>]*rel\s*=\s*["']?(?:icon|shortcut icon)["']?/i.test(html);
  const iconLinks = hasUserIcon ? "" : await buildIconLinks(config);

  // Skip if already injected (singleFile re-builds).
  if (/<script id="workbook-spec"[^>]*>/.test(html)) return ensureSlot(html);

  const spec = buildSpec(config);
  const specJson = escapeForScript(JSON.stringify(spec));
  const tagOpen = TRIGGER.TAG_SCRIPT_OPEN();
  const tagEnd = TRIGGER.TAG_SCRIPT_END();
  const specTag =
    `${tagOpen} id="workbook-spec" type="application/json">${specJson}${tagEnd}`;
  const injection = (iconLinks ? iconLinks + "\n" : "") + specTag;
  // Make sure the slot exists, then inject above it. Slot stays —
  // inlinePortableAssets uses it as its own anchor.
  return injectIntoHead(ensureSlot(html), injection);
}

/** Inline the wasm-bindgen JS, runtime bundle JS, and wasm bytes as
 *  <script type="text/plain"> blocks in the head, between sentinels.
 *  Replaces a prior block if present. Anchors on SLOT_PORTABLE
 *  (closes core-bii) — the slot is consumed at this point because
 *  no further injection passes need it. */
export async function inlinePortableAssets(html, runtime) {
  const assets = await readRuntimeAssets(runtime);
  const { BEGIN, END } = makeSentinels();
  const block = [
    makeAssetTag("wasm-b64", "text/plain", assets.wasmB64),
    makeAssetTag("bindgen-src", "text/plain", escapeForScript(assets.bindgenJs)),
    makeAssetTag("runtime-bundle-src", "text/plain", escapeForScript(assets.bundleSrc)),
  ].join("\n");
  const wrapped = `${BEGIN}\n${block}\n${END}`;

  // Replace prior block if present (re-runs).
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const priorRe = new RegExp(
    escapeRe(BEGIN) + "[\\s\\S]*?" + escapeRe(END),
    "i",
  );
  if (priorRe.test(html)) return html.replace(priorRe, wrapped);

  return injectIntoHead(html, wrapped, { consumeSlot: true });
}

/** Replace <link rel="stylesheet" href="..."> tags with inlined
 *  <style> blocks. href must be relative; absolute URLs are skipped.
 *  Used by the singleFile build path so a hand-written example with
 *  `<link href="../_shared/design.css">` produces a portable HTML
 *  with that CSS inlined. */
export async function inlineLinkedStylesheets(html, sourceDir) {
  const re = /<link\b[^>]*rel\s*=\s*["']?stylesheet["']?[^>]*>/gi;
  const matches = [...html.matchAll(re)];
  if (!matches.length) return html;

  const replacements = await Promise.all(matches.map(async (m) => {
    const tag = m[0];
    const hrefMatch = tag.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) return { tag, replacement: tag };
    const href = hrefMatch[1];
    if (/^[a-z]+:\/\//i.test(href) || href.startsWith("//")) {
      return { tag, replacement: tag }; // external URL — leave alone
    }
    const abs = path.resolve(sourceDir, href);
    try {
      const css = await fs.readFile(abs, "utf8");
      const idMatch = tag.match(/id\s*=\s*["']([^"']+)["']/i);
      const idAttr = idMatch ? ` id="${idMatch[1]}"` : "";
      return { tag, replacement: `<style${idAttr}>${css}</style>` };
    } catch {
      return { tag, replacement: tag }; // unresolvable — leave alone
    }
  }));

  let out = html;
  for (const { tag, replacement } of replacements) {
    if (tag !== replacement) out = out.replace(tag, replacement);
  }
  return out;
}

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
    // wasm-bindgen 0.2.93+ deprecates the positional init form. The
    // object form (module_or_path) is supported back to ~0.2.86, so
    // it works against any runtime we're realistically going to ship.
    await wasm.default({ module_or_path: wasmBytes });
    URL.revokeObjectURL(bindgenUrl);
    const bundleUrl = URL.createObjectURL(new Blob([bundleEl.textContent], { type: "application/javascript" }));
    bundle = await import(/* @vite-ignore */ bundleUrl);
    URL.revokeObjectURL(bundleUrl);
  } else {
    // Build URLs at runtime so the bundler doesn't try to resolve them.
    const base = "/" + "_" + "_workbook/";
    wasm = await import(/* @vite-ignore */ base + "bindgen.js");
    await wasm.default({ module_or_path: base + "runtime.wasm" });
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
      // When inlining is disabled (e.g. `workbook build --no-wasm` for
      // SPA workbooks that don't embed the runtime), skip the runtime
      // resolve entirely. Otherwise the build fails with "could not
      // locate workbook-runtime-wasm pkg/ output" even though the
      // resolved bytes are never used. The downstream `transformIndexHtml`
      // already short-circuits at `inlineRuntime === false`.
      if (config.inlineRuntime === false) return;
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
     * optional peer deps (deck.gl, mermaid, plotly, etc.) that should NOT be
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

    /** Inject the workbook-spec script + favicon links + the
     *  SLOT_PORTABLE anchor (closes core-bii). Runs at order "pre" so
     *  it sees the source HTML BEFORE viteSingleFile inlines the user
     *  JS bundle into <body>. The slot lands in <head>; later
     *  writeBundle uses it as the asset-injection anchor instead of a
     *  </head> regex that could match inside a JS template literal. */
    transformIndexHtml: {
      order: "pre",
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
        // Place the slot first, then inject spec/icons before it. The
        // slot stays in place for the writeBundle pass.
        return injectIntoHead(ensureSlot(html), injection);
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

      // Save handler script — runs in <head> as the page parses. The
      // keydown listener attaches synchronously; rehydrate runs on
      // DOMContentLoaded inside the script. Disable per-workbook via
      // config.save.enabled = false.
      const saveEnabled = config.save?.enabled !== false;
      const saveHandlerSrc = saveEnabled ? await readSaveHandler() : null;
      const { BEGIN: SAVE_BEGIN, END: SAVE_END } = makeSaveSentinels();
      const saveBlock = saveHandlerSrc
        ? `${SAVE_BEGIN}\n<script>${escapeForScript(saveHandlerSrc)}</script>\n${SAVE_END}`
        : "";

      // Install-Workbooks toast — fixed bottom-left card that shows up
      // when the file is opened via file:// (or any non-daemon URL),
      // prompting the user to install workbooksd. Self-suppresses when
      // loaded via http://127.0.0.1:47119/wb/<token>/ or inside an
      // iframe. Disable per-workbook via config.installToast.enabled =
      // false (e.g. for cloud-only workbooks where the CTA doesn't apply).
      const installToastEnabled = config.installToast?.enabled !== false;
      const installToastSrc = installToastEnabled ? await readInstallToast() : null;
      const { BEGIN: TOAST_BEGIN, END: TOAST_END } = makeInstallToastSentinels();
      const installToastBlock = installToastSrc
        ? `${TOAST_BEGIN}\n<script>${escapeForScript(installToastSrc)}</script>\n${TOAST_END}`
        : "";

      // Compose the full head-injection block: save handler first
      // (so Cmd+S works as soon as the page parses, even if the
      // runtime fails to boot), then the portable assets. Both go
      // through injectIntoHead which anchors on SLOT_PORTABLE — a
      // unique sentinel that lives outside any user JS, so the
      // "literal </body> in DOMPurify source" footgun (which the
      // first cut of save-handler injection tripped on) cannot
      // happen here.
      const portableBlock = [
        makeAssetTag("wasm-b64", "text/plain", assets.wasmB64),
        makeAssetTag("bindgen-src", "text/plain", escapeForScript(assets.bindgenJs)),
        makeAssetTag("runtime-bundle-src", "text/plain", escapeForScript(assets.bundleSrc)),
      ].join("\n");
      // Compose ordered blocks: save handler → install toast → portable
      // assets. Save first so Cmd+S works even if the others fail.
      const headBlocks = [saveBlock, installToastBlock, `${BEGIN}\n${portableBlock}\n${END}`]
        .filter(Boolean)
        .join("\n");
      const wrapped = headBlocks;

      for (const file of htmlFiles) {
        let src = await fs.readFile(file, "utf8");
        // Anchor on SLOT_PORTABLE if present (the transformIndexHtml
        // pre-pass put it there). Falls back to a </head> regex when
        // the source HTML never went through transformIndexHtml.
        // Closes core-bii: a user JS bundle that includes the
        // literal substring "</head>" (e.g. iframe srcdoc helpers)
        // can't trick us into landing 16 MB of base64 inside their
        // template literal because the slot is unique.
        src = injectIntoHead(src, wrapped, { consumeSlot: true });
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
