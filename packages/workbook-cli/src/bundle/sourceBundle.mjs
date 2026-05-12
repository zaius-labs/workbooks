// Source bundle producer (Phase W1.1).
//
// Walks a project tree and produces a single gzipped JSON bundle of
// every file the recipient would need to iterate on the workbook
// post-receipt. The bundle gets embedded into the compiled .html
// (see embedSource.mjs) so the artifact carries its own source.
//
// Why JSON, not tar?
//   - No native tar in Node; tar-stream / node-tar would add a dep.
//   - JSON is human-debuggable. A recipient with curiosity can extract
//     the embedded blob and inspect contents directly in a browser.
//   - The ~33% inflation from base64'd file contents is mostly absorbed
//     by gzip — typical workbook source compresses ~5x.
//   - tar's mtime/uid/gid metadata adds non-determinism we don't want.
//
// Format (versioned):
//   {
//     "version": 1,
//     "createdAt": "ISO-8601",
//     "rootName": "project-slug",
//     "files": [
//       { "path": "src/index.html", "content": "<b64>", "mode": 0o644 },
//       ...
//     ]
//   }
//
// Symlinks are skipped (rare in workbook source trees; opening that
// can-of-worms — relative target resolution, security — isn't worth
// it for the v1 bundle). Empty directories are skipped.

import path from "node:path";
import fs from "node:fs/promises";
import { gzipSync } from "node:zlib";

/**
 * Default ignore patterns. Mirror sane gitignore-style globs.
 * Prefix-match against POSIX-normalized relative paths.
 */
const DEFAULT_IGNORES = [
  "node_modules/",
  ".git/", // override via opts.includeGit
  "dist/",
  "build/",
  ".next/",
  ".svelte-kit/",
  ".turbo/",
  ".cache/",
  // Workbook-specific
  "*.workbook.html", // built artifacts
  // Editor / OS noise
  ".DS_Store",
  ".vscode/",
  ".idea/",
  // Lock-of-locks
  "package-lock.json.bak",
  // Common secrets
  ".env",
  ".env.*",
  "secrets.json",
  // The bundle itself when iterated in-place
  "*.bundle.json",
  "*.bundle.json.gz",
];

/**
 * Build a source bundle for `root`. Returns
 *   { buffer: Buffer (gzipped JSON), fileCount, uncompressedSize }
 *
 * Options:
 *   includeGit         - when true, includes the .git/ directory
 *                        (history travels with the artifact). Default false.
 *   maxFileBytes       - skip files larger than this (default 5 MiB).
 *                        Source trees with vendored binary blobs would
 *                        bloat the .html otherwise.
 *   maxTotalBytes      - cap the total uncompressed size (default 50 MiB).
 *                        Hard fail if exceeded — better to surface than
 *                        silently truncate.
 *   additionalIgnore   - array of extra prefixes/globs to skip.
 *   rootName           - logical name (defaults to basename of root).
 */
export async function createSourceBundle(root, opts = {}) {
  const {
    includeGit = false,
    maxFileBytes = 5 * 1024 * 1024,
    maxTotalBytes = 50 * 1024 * 1024,
    additionalIgnore = [],
    rootName = path.basename(path.resolve(root)),
  } = opts;

  const ignores = [...DEFAULT_IGNORES, ...additionalIgnore];
  if (includeGit) {
    // Re-allow .git/ by removing the default ignore.
    const idx = ignores.indexOf(".git/");
    if (idx >= 0) ignores.splice(idx, 1);
  }

  const files = [];
  let totalBytes = 0;

  async function walk(absDir, relDir) {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    // Stable order — bundle is reproducible regardless of fs iteration.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (matchesIgnore(rel, entry.isDirectory(), ignores)) continue;

      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        const stat = await fs.stat(abs);
        if (stat.size > maxFileBytes) {
          // Larger-than-cap files are signaled in the manifest as a
          // truncation marker so a recipient knows something was elided.
          files.push({
            path: rel,
            content: null,
            mode: stat.mode & 0o777,
            truncated: true,
            originalSize: stat.size,
          });
          continue;
        }
        const content = await fs.readFile(abs);
        totalBytes += content.length;
        if (totalBytes > maxTotalBytes) {
          throw new Error(
            `source bundle exceeds ${Math.round(maxTotalBytes / 1024 / 1024)} MiB ` +
              `(reading ${rel} pushed total to ${Math.round(totalBytes / 1024 / 1024)} MiB). ` +
              `Add additionalIgnore patterns or pass --no-bundle to skip.`,
          );
        }
        files.push({
          path: rel,
          content: content.toString("base64"),
          mode: stat.mode & 0o777,
        });
      }
      // Skip symlinks + sockets + devices entirely. They don't roundtrip
      // safely in a portable JSON container.
    }
  }

  await walk(path.resolve(root), "");

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    rootName,
    files,
  };
  const json = JSON.stringify(manifest);
  const buffer = gzipSync(Buffer.from(json, "utf8"), { level: 9 });

  return {
    buffer,
    fileCount: files.length,
    uncompressedSize: json.length,
  };
}

/**
 * gitignore-lite matcher. Supports:
 *   - `name/`        directory prefix match (anchored anywhere in path)
 *   - `*.ext`        glob extension (any path segment)
 *   - `name`         exact filename or path-prefix
 *
 * Not full gitignore semantics — but enough for default patterns +
 * user-supplied additionalIgnore. Authors with complex needs can
 * shape their tree before bundling (or set additionalIgnore directly).
 */
function matchesIgnore(relPath, isDir, patterns) {
  // Always normalize to posix separators for matching.
  const p = relPath.replace(/\\/g, "/");
  for (const pat of patterns) {
    if (pat.endsWith("/")) {
      // Directory prefix match — match if any path segment equals pat[:-1]
      const dir = pat.slice(0, -1);
      const segments = p.split("/");
      if (segments.includes(dir)) return true;
    } else if (pat.includes("*")) {
      // Simple glob: only `*` wildcard support, anchored to a segment
      const re = globToRegex(pat);
      const segments = p.split("/");
      const last = segments[segments.length - 1];
      if (re.test(last)) return true;
      // Also match the full path (for patterns like ".env.*" that
      // span the basename of any depth).
      if (re.test(p)) return true;
    } else {
      // Exact filename or full-path match.
      const segments = p.split("/");
      const last = segments[segments.length - 1];
      if (last === pat || p === pat) return true;
    }
  }
  return false;
}

function globToRegex(pat) {
  // Escape regex specials, then turn `*` into `[^/]*`.
  const escaped = pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}
