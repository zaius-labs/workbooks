// `workbook unbundle <file.html> [outDir]` — extract the gzipped
// source bundle embedded in a compiled .html artifact back into a
// working source tree.
//
// Pairs with `workbook build`'s default-on bundle embed (W1.3). Lets
// recipients of a .html iterate on the source without round-tripping
// through a separate distribution channel.
//
// Default out dir is `<basename-without-ext>-source/`. Refuses to
// overwrite a non-empty existing dir unless --force is passed.

import path from "node:path";
import fs from "node:fs/promises";
import {
  decodeBundle,
  extractBundle,
  readBundleMeta,
} from "../bundle/embedSource.mjs";

export async function runUnbundle(opts = {}) {
  const inputPath = opts._?.[0] ?? opts.input;
  if (!inputPath) {
    throw new Error(
      "workbook unbundle: missing input file.\n" +
        "  workbook unbundle <file.html> [outDir]",
    );
  }
  const inputAbs = path.resolve(inputPath);
  const html = await fs.readFile(inputAbs, "utf8");

  const meta = readBundleMeta(html);
  if (!meta) {
    throw new Error(
      `workbook unbundle: ${path.relative(process.cwd(), inputAbs)} has no embedded ` +
        `source bundle. Was it built with --no-bundle?`,
    );
  }
  if (meta.version !== "1") {
    throw new Error(
      `workbook unbundle: bundle format version "${meta.version}" not supported by ` +
        `this CLI (expected 1). Upgrade your CLI.`,
    );
  }
  if (meta.format !== "json+gzip+base64") {
    throw new Error(
      `workbook unbundle: unsupported bundle format "${meta.format}".`,
    );
  }

  const buf = extractBundle(html);
  const manifest = decodeBundle(buf);
  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error("workbook unbundle: malformed bundle manifest.");
  }

  const outArg = opts._?.[1] ?? opts.out;
  const defaultName =
    manifest.rootName ??
    path
      .basename(inputAbs)
      .replace(/\.html$/, "")
      .replace(/\.workbook$/, "") + "-source";
  const outDir = path.resolve(outArg ?? defaultName);

  await guardOutDir(outDir, opts.force === true);

  const truncated = [];
  let written = 0;
  for (const file of manifest.files) {
    const safe = sanitizePath(file.path);
    if (!safe) {
      // Reject path-traversal-ish entries (..  / absolute / null bytes).
      // The bundle should never contain these, but be defensive.
      continue;
    }
    if (file.truncated || file.content == null) {
      truncated.push({ path: safe, originalSize: file.originalSize ?? 0 });
      continue;
    }
    const dest = path.join(outDir, safe);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const buffer = Buffer.from(file.content, "base64");
    await fs.writeFile(dest, buffer);
    if (typeof file.mode === "number") {
      try {
        await fs.chmod(dest, file.mode);
      } catch {
        // Some FS / Windows can't honor the mode; non-fatal.
      }
    }
    written++;
  }

  process.stdout.write(
    `[workbook] unbundled ${written} file(s) → ${path.relative(process.cwd(), outDir)}\n`,
  );
  if (truncated.length > 0) {
    process.stderr.write(
      `[workbook] WARNING: ${truncated.length} file(s) were truncated at build time:\n`,
    );
    for (const t of truncated) {
      process.stderr.write(
        `    ${t.path}  (${Math.round(t.originalSize / 1024)} KB at build time, content not embedded)\n`,
      );
    }
  }
  if (manifest.createdAt) {
    process.stdout.write(`[workbook] bundle createdAt=${manifest.createdAt}\n`);
  }
}

async function guardOutDir(outDir, force) {
  let entries;
  try {
    entries = await fs.readdir(outDir);
  } catch (err) {
    if (err.code === "ENOENT") {
      await fs.mkdir(outDir, { recursive: true });
      return;
    }
    throw err;
  }
  if (entries.length > 0 && !force) {
    throw new Error(
      `workbook unbundle: ${outDir} is not empty. Pass --force to overwrite.`,
    );
  }
}

/**
 * Reject path-traversal + absolute paths. Returns the cleaned posix
 * path or null when the entry should be dropped.
 */
function sanitizePath(p) {
  if (typeof p !== "string" || p.length === 0) return null;
  if (p.includes("\0")) return null;
  // Normalize separators
  const norm = p.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[A-Za-z]:[\\/]/.test(norm)) return null;
  // No `..` segments anywhere
  const segs = norm.split("/");
  if (segs.some((s) => s === "..")) return null;
  return norm;
}
