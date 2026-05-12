// Embed + extract the source bundle inside a compiled .html.
//
// The bundle is stored in a `<script>` block whose `type` is NOT
// `application/javascript` — browsers ignore non-script types entirely,
// so the embedded data has zero runtime cost. The data lives as
// base64 (gzipped JSON) so the .html stays utf-8 clean.
//
// Element shape:
//
//   <script id="wb-source-bundle"
//           type="application/x-workbook-source"
//           data-format="json+gzip+base64"
//           data-version="1"
//           data-root-name="my-workbook"
//           data-file-count="42"
//           data-bundle-size="14823">BASE64...</script>
//
// Multiple bundles per artifact are unsupported — embed replaces any
// existing block. Roundtrip is verified by a unit test.

import { gunzipSync } from "node:zlib";

const MARKER_OPEN = '<script id="wb-source-bundle"';
const MARKER_CLOSE = "</script>";

/**
 * Embed `bundleBuffer` (gzipped JSON) into `html`. Returns the new
 * html string. Idempotent: a second embed replaces the first.
 *
 * `meta` is optional metadata (rootName, fileCount, originalSize) that
 * gets stamped as data-* attributes for human inspection without
 * needing to decode the payload.
 */
export function embedBundle(html, bundleBuffer, meta = {}) {
  const stripped = stripBundle(html);
  const b64 = bundleBuffer.toString("base64");
  const attrs = [
    'id="wb-source-bundle"',
    'type="application/x-workbook-source"',
    'data-format="json+gzip+base64"',
    'data-version="1"',
  ];
  if (meta.rootName) attrs.push(`data-root-name="${escapeAttr(meta.rootName)}"`);
  if (typeof meta.fileCount === "number") {
    attrs.push(`data-file-count="${meta.fileCount}"`);
  }
  if (typeof meta.bundleSize === "number") {
    attrs.push(`data-bundle-size="${meta.bundleSize}"`);
  }
  if (typeof meta.uncompressedSize === "number") {
    attrs.push(`data-uncompressed-size="${meta.uncompressedSize}"`);
  }
  const block = `<script ${attrs.join(" ")}>${b64}</script>`;

  // Insert just before </body> so the bundle is the very last thing
  // a parser sees — keeps it out of the DOM render path. Fall back
  // to </html> when there's no body, or append when neither exists.
  if (stripped.includes("</body>")) {
    return stripped.replace("</body>", `${block}</body>`);
  }
  if (stripped.includes("</html>")) {
    return stripped.replace("</html>", `${block}</html>`);
  }
  return stripped + block;
}

/**
 * Pull the bundle buffer out of an html string. Returns null when the
 * artifact carries no bundle (older builds, or `--no-bundle`).
 */
export function extractBundle(html) {
  const found = findBundleBlock(html);
  if (!found) return null;
  const buf = Buffer.from(found.b64, "base64");
  return buf;
}

/**
 * Read the bundle's metadata from the data-* attributes WITHOUT
 * decoding the payload. Useful for `inspect` style commands.
 */
export function readBundleMeta(html) {
  const found = findBundleBlock(html);
  if (!found) return null;
  return found.meta;
}

/**
 * Decompress + parse the gzipped JSON manifest.
 */
export function decodeBundle(bundleBuffer) {
  const json = gunzipSync(bundleBuffer).toString("utf8");
  return JSON.parse(json);
}

/* ----------------------------- internals ----------------------------- */

function stripBundle(html) {
  const start = html.indexOf(MARKER_OPEN);
  if (start < 0) return html;
  const end = html.indexOf(MARKER_CLOSE, start);
  if (end < 0) return html;
  return html.slice(0, start) + html.slice(end + MARKER_CLOSE.length);
}

function findBundleBlock(html) {
  const start = html.indexOf(MARKER_OPEN);
  if (start < 0) return null;
  const tagEnd = html.indexOf(">", start);
  if (tagEnd < 0) return null;
  const close = html.indexOf(MARKER_CLOSE, tagEnd);
  if (close < 0) return null;
  const tagAttrs = html.slice(start + "<script".length, tagEnd);
  const meta = {
    rootName: matchAttr(tagAttrs, "data-root-name"),
    format: matchAttr(tagAttrs, "data-format"),
    version: matchAttr(tagAttrs, "data-version"),
    fileCount: parseIntOrNull(matchAttr(tagAttrs, "data-file-count")),
    bundleSize: parseIntOrNull(matchAttr(tagAttrs, "data-bundle-size")),
    uncompressedSize: parseIntOrNull(
      matchAttr(tagAttrs, "data-uncompressed-size"),
    ),
  };
  const b64 = html.slice(tagEnd + 1, close).trim();
  return { b64, meta };
}

function matchAttr(attrString, name) {
  const re = new RegExp(`${name}="([^"]*)"`);
  const m = attrString.match(re);
  return m ? m[1] : null;
}

function parseIntOrNull(s) {
  if (s == null) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
