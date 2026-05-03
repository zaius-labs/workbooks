/**
 * Browser-side workbook packager — produces a .workbook.zip Blob
 * containing the workbook HTML plus extracted assets.
 *
 * Single-file workbooks (.html) inline everything as base64
 * up to a 25 MB cap. Past that, large media (videos, audio, big
 * images) need a different shape: a zip with assets/<sha256>.<ext>
 * siblings and the HTML rewritten to reference them by relative path.
 *
 * The packager:
 *   1. Parses the workbook HTML.
 *   2. Walks every <wb-data encoding="base64"> over the threshold,
 *      every <wb-memory> over the threshold, and every <img>/<video>/
 *      <audio>/<source> with src= referencing an inline data URL or
 *      (optionally) an external https:// asset.
 *   3. Extracts each asset to a content-addressed buffer.
 *   4. Rewrites the source HTML to reference assets/<sha256>.<ext>.
 *   5. Bundles everything via fflate into a Blob the host can hand
 *      to a download anchor.
 *
 * What you get out:
 *
 *   project.workbook.zip
 *   ├── index.html                  — the rewritten workbook HTML
 *   ├── manifest.json               — id ↔ asset hash mapping + metadata
 *   └── assets/
 *       ├── <sha256>.<ext>          — content-addressed asset files
 *       └── ...
 *
 * Open by unzipping then double-clicking index.html. A "package
 * loader" companion (separate ship) detects the zip context and
 * resolves assets/* through fetch — that keeps the user-facing
 * "double-click to run" property without requiring extraction.
 */

import { zipSync, strToU8 } from "fflate";

/** What we record in the zip's manifest.json so a future tool can
 *  reconstruct the original semantics if needed. */
interface PackageManifest {
  format: "workbook-zip-v1";
  generated_at: string;
  source_size_bytes: number;
  asset_count: number;
  assets: Array<{
    /** Path inside the zip (e.g. "assets/abc123.png"). */
    path: string;
    sha256: string;
    bytes: number;
    /** Where this asset came from in the source HTML — for debugging. */
    origin:
      | { kind: "wb-data-inline"; id: string }
      | { kind: "wb-memory-inline"; id: string }
      | { kind: "data-url-attr"; element: string; attr: string }
      | { kind: "external-url"; url: string; element: string };
    mime?: string;
  }>;
}

export interface PackageWorkbookOptions {
  /**
   * Inline-base64 payloads larger than this many bytes get extracted
   * to assets/. Smaller payloads stay inlined (per-asset HTTP overhead
   * isn't worth it for tiny content). Default: 1 MB.
   */
  extractInlineLargerThan?: number;
  /**
   * Whether to fetch + bundle external https:// assets that the source
   * HTML references. Off by default — bundling external URLs introduces
   * a network dep at package time and may cross trust boundaries.
   */
  bundleExternal?: boolean;
  /**
   * Hosts allowed for external bundling, when bundleExternal=true.
   * Each https://host is checked; mismatches are left as-is in the
   * output HTML (referenced as external URLs).
   */
  externalAllowlist?: string[];
  /**
   * Override fetch (auth headers, retries). Defaults to global fetch.
   */
  fetchBytes?: (url: string) => Promise<{ bytes: Uint8Array; mime: string }>;
  /**
   * Filename (no extension) used for the rewritten HTML inside the zip.
   * Defaults to "index".
   */
  htmlBasename?: string;
}

const DEFAULT_EXTRACT_THRESHOLD = 1 * 1024 * 1024; // 1 MB

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "application/x-sqlite3": "sqlite3",
  "application/json": "json",
  "application/parquet": "parquet",
  "text/csv": "csv",
  "application/octet-stream": "bin",
};

function extForMime(mime: string | undefined): string {
  if (!mime) return "bin";
  return MIME_EXT[mime.toLowerCase()] ?? "bin";
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256HexFromBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Parse a `data:<mime>;base64,<payload>` URL. Returns null on
 *  non-base64 data URLs (we don't extract those — they're
 *  typically tiny SVGs or text). */
function parseDataUrl(url: string): { mime: string; bytes: Uint8Array } | null {
  if (!url.startsWith("data:")) return null;
  const m = /^data:([^;,]+)(;[^,]*)?,(.*)$/i.exec(url);
  if (!m) return null;
  const mime = m[1]!;
  const params = m[2] ?? "";
  const payload = m[3] ?? "";
  if (!params.includes(";base64")) return null;
  try {
    return { mime, bytes: decodeBase64(payload) };
  } catch {
    return null;
  }
}

async function defaultFetchBytes(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`packageWorkbook fetch ${url}: ${resp.status}`);
  const mime = resp.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream";
  const bytes = new Uint8Array(await resp.arrayBuffer());
  return { bytes, mime };
}

function isHttpsAllowed(url: string, allow: ReadonlyArray<string>): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const host = u.hostname.toLowerCase();
    return allow.some((h) => h.toLowerCase() === host);
  } catch {
    return false;
  }
}

/**
 * Package a workbook HTML string into a zip Blob.
 */
export async function packageWorkbook(
  html: string,
  opts: PackageWorkbookOptions = {},
): Promise<Blob> {
  const threshold = opts.extractInlineLargerThan ?? DEFAULT_EXTRACT_THRESHOLD;
  const fetchBytes = opts.fetchBytes ?? defaultFetchBytes;
  const allowlist = opts.externalAllowlist ?? [];
  const bundleExternal = opts.bundleExternal === true;
  const htmlBasename = opts.htmlBasename ?? "index";

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  const assets: PackageManifest["assets"] = [];
  const zipFiles: Record<string, Uint8Array> = {};

  /** Store an asset by content hash; idempotent on duplicate sha256. */
  async function storeAsset(
    bytes: Uint8Array,
    mime: string,
    origin: PackageManifest["assets"][number]["origin"],
  ): Promise<string> {
    const sha = await sha256HexFromBytes(bytes);
    const ext = extForMime(mime);
    const path = `assets/${sha}.${ext}`;
    if (!zipFiles[path]) {
      zipFiles[path] = bytes;
      assets.push({ path, sha256: sha, bytes: bytes.byteLength, origin, mime });
    }
    return path;
  }

  // 1. <wb-data encoding="base64"> over threshold
  for (const el of Array.from(doc.querySelectorAll("wb-data"))) {
    const id = el.getAttribute("id") ?? "";
    if (el.getAttribute("encoding")?.toLowerCase() !== "base64") continue;
    const raw = el.textContent ?? "";
    const b64 = raw.replace(/\s+/g, "");
    if (!b64) continue;
    const approxBytes = Math.floor((b64.length * 3) / 4);
    if (approxBytes < threshold) continue;
    const bytes = decodeBase64(b64);
    const mime = el.getAttribute("mime") ?? "application/octet-stream";
    const path = await storeAsset(bytes, mime, { kind: "wb-data-inline", id });
    el.setAttribute("src", path);
    el.removeAttribute("encoding");
    el.textContent = "";
  }

  // 2. <wb-memory encoding="base64"> over threshold
  for (const el of Array.from(doc.querySelectorAll("wb-memory"))) {
    const id = el.getAttribute("id") ?? "";
    if (el.getAttribute("encoding")?.toLowerCase() !== "base64") continue;
    const raw = el.textContent ?? "";
    const b64 = raw.replace(/\s+/g, "");
    if (!b64) continue;
    const approxBytes = Math.floor((b64.length * 3) / 4);
    if (approxBytes < threshold) continue;
    const bytes = decodeBase64(b64);
    const path = await storeAsset(bytes, "application/octet-stream", {
      kind: "wb-memory-inline",
      id,
    });
    el.setAttribute("src", path);
    el.removeAttribute("encoding");
    el.textContent = "";
  }

  // 3. <img>/<video>/<audio>/<source> with data: URLs (any size — these
  //    are media references the host explicitly meant to be assets) and,
  //    optionally, external https:// URLs on the allowlist.
  for (const tag of ["img", "video", "audio", "source"]) {
    for (const el of Array.from(doc.querySelectorAll(tag))) {
      const src = el.getAttribute("src");
      if (!src) continue;
      const dataUrl = parseDataUrl(src);
      if (dataUrl) {
        const path = await storeAsset(dataUrl.bytes, dataUrl.mime, {
          kind: "data-url-attr",
          element: tag,
          attr: "src",
        });
        el.setAttribute("src", path);
        continue;
      }
      if (
        bundleExternal &&
        (src.startsWith("https://") || src.startsWith("http://")) &&
        isHttpsAllowed(src, allowlist)
      ) {
        try {
          const fetched = await fetchBytes(src);
          const path = await storeAsset(fetched.bytes, fetched.mime, {
            kind: "external-url",
            url: src,
            element: tag,
          });
          el.setAttribute("src", path);
        } catch {
          // Fetch failed — leave the external URL in place. The
          // resulting zip will need network to render fully.
        }
      }
    }
  }

  // 4. Manifest + serialize HTML
  const manifest: PackageManifest = {
    format: "workbook-zip-v1",
    generated_at: new Date().toISOString(),
    source_size_bytes: html.length,
    asset_count: assets.length,
    assets,
  };
  zipFiles[`${htmlBasename}.html`] = strToU8(
    "<!DOCTYPE html>\n" + doc.documentElement.outerHTML,
  );
  zipFiles["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));

  const zipped = zipSync(zipFiles);
  // Construct Blob from a copy so we don't share the underlying buffer
  // with the (potentially short-lived) intermediate Uint8Array.
  const blob = new Blob([zipped.slice() as BlobPart], { type: "application/zip" });
  return blob;
}

/**
 * Convenience: package a workbook and trigger a download in the
 * current page. Hosts often want this exact shape — call once,
 * file appears in the user's downloads folder.
 */
export async function downloadWorkbookZip(
  html: string,
  filename: string,
  opts?: PackageWorkbookOptions,
): Promise<void> {
  const blob = await packageWorkbook(html, opts);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.endsWith(".zip") ? filename : `${filename}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    // Defer revoke so the click handler has time to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
