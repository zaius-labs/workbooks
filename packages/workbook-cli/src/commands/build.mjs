// `workbook build` — compile project into a single .workbook.html.

import path from "node:path";
import fs from "node:fs/promises";
import { build as viteBuild } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { loadConfig } from "../util/config.mjs";
import workbookPlugin from "../plugins/workbookInline.mjs";
import workbookVirtualModulesPlugin from "../plugins/virtualModules.mjs";
import { readPassphrase, assertStrongPassphrase } from "../encrypt/secrets.mjs";
import { wrapEncrypted } from "../encrypt/wrapHtml.mjs";

export async function runBuild(opts = {}) {
  const { project = ".", out, runtime, wasm } = opts;
  const config = await loadConfig(project);
  const outDir = path.resolve(config.root, out ?? "dist");
  const inlineRuntime = wasm === false ? false : config.inlineRuntime;

  // Encryption is opt-in: must be configured in workbook.config.mjs OR
  // requested via --encrypt. Either way we resolve the passphrase here
  // BEFORE Vite runs so we fail fast (no point compiling 21 MB if the
  // env var is missing).
  const encryptRequest = await resolveEncryptRequest(opts, config);

  const plugins = [
    // Resolve `workbook:*` virtual module imports to the SDK shipped
    // with the CLI. Must run before viteSingleFile/workbookPlugin so
    // the SDK source is in the module graph by the time inlining runs.
    workbookVirtualModulesPlugin(),
    // viteSingleFile inlines all JS + CSS into the HTML. Without it,
    // Vite emits separate /assets/*.js + .css files and the HTML
    // <script>/<link> them — which defeats single-file portability.
    viteSingleFile({
      removeViteModuleLoader: true,
      useRecommendedBuildConfig: true,
    }),
    workbookPlugin({ config: { ...config, inlineRuntime }, runtimeOverride: runtime }),
  ];

  const sveltePlugin = await tryLoadSveltePlugin(config.root);
  if (sveltePlugin) plugins.unshift(sveltePlugin);

  // Use the entry's parent dir as the Vite root so the entry sits
  // at "/index.html" — that gives us a flat dist/ instead of
  // dist/src/index.html mirroring the source layout.
  const entryAbs = path.resolve(config.root, config.entry);
  const viteRoot = path.dirname(entryAbs);

  // Merge user-supplied vite config last, but PREPEND any user plugins
  // to ours so they get first crack (e.g. @tailwindcss/vite needs to
  // see CSS before the workbook plugin or singlefile collapses it).
  // Spread-overwriting `plugins` from config.vite would drop our own
  // plugins entirely — explicit merge avoids that footgun.
  const { plugins: userPlugins = [], build: userBuild = {}, ...userVite } =
    config.vite ?? {};

  await viteBuild({
    root: viteRoot,
    ...userVite,
    plugins: [...userPlugins, ...plugins],
    build: {
      ...userBuild,
      outDir,
      emptyOutDir: true,
      rollupOptions: {
        ...(userBuild.rollupOptions ?? {}),
        input: entryAbs,
      },
      // Single-file output — no code splitting, no asset emission.
      // These four MUST stay set; user-supplied build options can
      // tweak everything else (target, minify, etc.) but not these.
      assetsInlineLimit: 100_000_000,
      cssCodeSplit: false,
      sourcemap: false,
    },
    logLevel: "info",
  });

  // Encryption stage. workbookInline already renamed the artifact to
  // <slug>.workbook.html before we got here; we read it back, wrap it
  // in a lock screen, and write it back to the same path.
  if (encryptRequest) {
    const artifactPath = path.join(outDir, `${config.slug}.workbook.html`);
    const plaintext = await fs.readFile(artifactPath, "utf8");
    const wrapped = await wrapEncrypted({
      html: plaintext,
      passphrase: encryptRequest.passphrase,
      title: config.name ?? config.slug,
    });
    await fs.writeFile(artifactPath, wrapped);
    const sealedKb = Math.round(wrapped.length / 1024);
    process.stdout.write(
      `[workbook] sealed → ${path.relative(process.cwd(), artifactPath)} ` +
      `(${sealedKb} KB · age-v1 passphrase)\n`,
    );
  }

  process.stdout.write(`[workbook] build complete · slug=${config.slug} → ${path.relative(process.cwd(), outDir)}\n`);
}

/**
 * Resolve the encryption request from CLI flags + workbook.config.mjs.
 * Returns null when encryption isn't requested. Otherwise returns
 * `{ passphrase }` (multi-unlock methods land in P3.x).
 *
 * Resolution order for the passphrase:
 *   1. --password-stdin   (the canonical CI pattern)
 *   2. --password-file
 *   3. --password (insecure — visible in `ps`; warns)
 *   4. process.env[config.encrypt.passwordEnv] (default WORKBOOK_PASSWORD)
 *
 * Fails loud if --encrypt was requested but no passphrase resolved.
 */
async function resolveEncryptRequest(opts, config) {
  const flagOn = opts.encrypt === true || opts.encrypt === "true";
  const configOn = config.encrypt !== null && config.encrypt !== undefined;
  if (!flagOn && !configOn) return null;

  const passwordEnv = config.encrypt?.passwordEnv ?? "WORKBOOK_PASSWORD";
  const passphrase = await readPassphrase(opts, { fallbackEnv: passwordEnv });
  if (!passphrase) {
    throw new Error(
      `--encrypt requires a passphrase. Provide one of:\n` +
      `  --password-stdin       (echo $PASS | workbook build --encrypt)\n` +
      `  --password-file <path> (chmod 600)\n` +
      `  ${passwordEnv}=...       (env var; configure via encrypt.passwordEnv)\n` +
      `  --password <s>         (insecure — visible in 'ps')`,
    );
  }
  if (opts.password) {
    process.stderr.write(
      "workbook build: WARNING — --password is visible in `ps`. Prefer --password-stdin or env var.\n",
    );
  }
  assertStrongPassphrase(passphrase);
  return { passphrase };
}

async function tryLoadSveltePlugin(root) {
  // Mirror dev.mjs — autoload mdsvex as a preprocessor when present.
  try {
    const sveltePlugin = await import("@sveltejs/vite-plugin-svelte");
    const mdsvex = await tryLoadMdsvex();
    if (mdsvex) {
      return sveltePlugin.svelte({
        extensions: [".svelte", ".svx"],
        preprocess: [mdsvex],
      });
    }
    return sveltePlugin.svelte();
  } catch {
    return null;
  }
}

async function tryLoadMdsvex() {
  try {
    const mod = await import("mdsvex");
    const { remarkWorkbookCells } = await import(
      "../plugins/remarkWorkbookCells.mjs"
    );
    return mod.mdsvex({
      extensions: [".svx"],
      remarkPlugins: [remarkWorkbookCells],
    });
  } catch {
    return null;
  }
}
