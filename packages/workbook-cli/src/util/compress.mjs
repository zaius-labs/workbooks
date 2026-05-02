// Brotli-sandwich compression for portable .workbook.html artifacts.
//
// Wraps the finalized HTML in a self-decompressing shim:
//
//   <doctype + minimal head + brotli payload + decompressor>
//
// At load, the decompressor reads the inlined base64 payload, pipes
// it through DecompressionStream("br"), and replaces the document
// via document.open()/write()/close(). All engines support brotli
// in DecompressionStream (Q1 2026).
//
// Why not gzip: brotli runs ~20% smaller on minified JS — and we're
// optimizing for a single payload size, not transfer compression
// (no upstream HTTP-level br to defer to since this is the .html
// file itself).

import zlib from "node:zlib";
import { promisify } from "node:util";

const brotliCompress = promisify(zlib.brotliCompress);
const gzipCompress = promisify(zlib.gzip);

/**
 * Heuristic head-essentials extractor: lifts the tags that should be
 * visible BEFORE decompression (charset, viewport, title, favicons,
 * darkreader-lock, lang, doctype) into the shim's outer document so
 * the tab title + favicon don't flash blank during the ~50ms decode.
 *
 * Conservative: only matches well-formed standalone tags. Anything
 * uncertain stays in the compressed payload — duplicates are harmless
 * because document.write() rebuilds the tree wholesale.
 */
function extractHeadEssentials(html) {
  const out = [];
  const lang = html.match(/<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i);
  const langAttr = lang ? ` lang="${lang[1]}"` : "";

  // Pull <meta charset>, <meta name="viewport">, <meta name="darkreader-lock">,
  // <title>, <link rel="icon">. We don't pull preload/preconnect since the
  // decompressed doc sets those itself. Pull from anywhere in <head>.
  const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  const head = headMatch ? headMatch[1] : "";

  const charsetRe = /<meta[^>]*\bcharset\b[^>]*>/i;
  const viewportRe = /<meta[^>]*\bname\s*=\s*["']?viewport["']?[^>]*>/i;
  const darkreaderRe = /<meta[^>]*\bname\s*=\s*["']?darkreader-lock["']?[^>]*>/i;
  const titleRe = /<title>[\s\S]*?<\/title>/i;
  const iconRe = /<link[^>]*\brel\s*=\s*["']?icon["']?[^>]*>/gi;
  // wb-secrets-policy and wb-permissions are read by workbooksd at
  // serve time. Both MUST stay in the outer shell so the daemon
  // can grep them without decompressing the payload.
  const policyRe = /<meta[^>]*\bname\s*=\s*["']?wb-secrets-policy["']?[^>]*>/i;
  const permsRe = /<meta[^>]*\bname\s*=\s*["']?wb-permissions["']?[^>]*>/i;

  const m1 = head.match(charsetRe); if (m1) out.push(m1[0]);
  const m2 = head.match(viewportRe); if (m2) out.push(m2[0]);
  const m3 = head.match(darkreaderRe); if (m3) out.push(m3[0]);
  const m4 = head.match(titleRe); if (m4) out.push(m4[0]);
  const m5 = head.match(policyRe); if (m5) out.push(m5[0]);
  const m6 = head.match(permsRe); if (m6) out.push(m6[0]);
  const icons = head.match(iconRe); if (icons) out.push(...icons);

  return { langAttr, headTags: out.join("\n  ") };
}

/**
 * Build the self-decompressing shim. Inlined script reads the
 * payload textContent (base64), decodes, decompresses via
 * DecompressionStream("br"), and replaces the document via
 * document.open/write/close so URL + origin (localStorage, IDB)
 * are preserved.
 *
 * The script tag holding the payload is type="application/octet-stream"
 * so the parser treats its contents as raw text — no </script> escaping
 * needed because base64 alphabet contains no `<` characters.
 *
 * Fallback: if DecompressionStream isn't available (very old browser),
 * the catch handler writes a plain-text error message.
 */
function buildShim({ langAttr, headTags, base64, format, originalSize, compressedSize }) {
  const ratio = ((compressedSize / originalSize) * 100).toFixed(1);
  return `<!DOCTYPE html>
<html${langAttr}>
<head>
  ${headTags}
  <style>html,body{margin:0;background:#09090b;color:#e4e4e7;font-family:system-ui,sans-serif}</style>
</head>
<body>
<script id="__wb_payload" type="application/octet-stream">${base64}</script>
<script>
(async () => {
  try {
    if (typeof DecompressionStream !== "function") {
      throw new Error("This browser does not support DecompressionStream. Try Chrome 80+, Firefox 113+, Safari 16.4+.");
    }
    const b64 = document.getElementById("__wb_payload").textContent;
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream(${JSON.stringify(format)}));
    const html = await new Response(stream).text();
    document.open();
    document.write(html);
    document.close();
  } catch (e) {
    document.body.innerHTML = '<pre style="padding:24px;color:#fca5a5;white-space:pre-wrap">workbook decompress failed: ' + (e && e.message ? e.message : String(e)) + '</pre>';
  }
})();
</script>
<!-- ${format} ${originalSize} → ${compressedSize} bytes (${ratio}%) -->
</body>
</html>
`;
}

/**
 * Compress the full HTML into a self-decompressing shim. Returns the
 * new HTML string. The original HTML is preserved verbatim inside the
 * payload, so document.open/write rebuilds it 1:1 — every <script>,
 * <link>, <style>, base64 asset survives.
 *
 * Format defaults to "gzip" (universal DecompressionStream support
 * since 2022). "br" is ~5–10% smaller but DecompressionStream("br")
 * landed only in Chrome 138+ / Safari 17.6+ / Firefox 132+; fall back
 * to gzip for any browser older than the user's target floor.
 */
export async function brotliWrapHtml(html, { format = "gzip" } = {}) {
  const { langAttr, headTags } = extractHeadEssentials(html);
  const buf = Buffer.from(html, "utf8");
  let compressed;
  if (format === "br") {
    compressed = await brotliCompress(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      },
    });
  } else if (format === "gzip") {
    compressed = await gzipCompress(buf, { level: 9 });
  } else {
    throw new Error(`compress: unsupported format '${format}'. Use "gzip" or "br".`);
  }
  const base64 = compressed.toString("base64");
  return buildShim({
    langAttr,
    headTags,
    base64,
    format,
    originalSize: buf.length,
    compressedSize: compressed.length,
  });
}
