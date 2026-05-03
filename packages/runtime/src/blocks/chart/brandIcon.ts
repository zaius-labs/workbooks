/**
 * Default brand icon — a neutral briefcase SVG inlined as a data URI.
 * Used wherever a brand favicon can't be resolved (malformed URL,
 * Brandfetch 404, network failure, blocked image). Visible on both
 * light and dark surfaces.
 *
 * Surfaced two ways:
 *   - Static: faviconFor(brand) returns this when the URL can't parse.
 *   - Reactive: every brand <img> gets a JS-attached `error` listener
 *     (see Paragraph.svelte / Markdown.svelte $effect) that swaps to
 *     this URI when the original load fails. Inline `onerror=` was
 *     removed in core-0id.10 — its presence forced 'unsafe-inline' in
 *     consumer CSP and defeated most of CSP's value.
 *
 * Stroke color is a fixed neutral grey (#9aa0a8) so it reads on both
 * light (#fafafa) and dark (#1a1a1f) surfaces. CSS `currentColor`
 * doesn't traverse into data-URI SVGs in <img>, so we bake in a
 * mid-tone instead. Light mode reads at ~3.4:1 contrast and dark
 * mode ~4.1:1 — fine for a non-text glyph.
 */

const STROKE = "#9aa0a8";

/* Lucide briefcase paths, simplified into a self-contained SVG.
 * Quoted as a single line so URL-encoding stays predictable. */
const SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${STROKE}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect width='20' height='14' x='2' y='6' rx='2'/><path d='M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2'/><path d='M2 13h20'/></svg>`;

/** Data URI for an `<img src>` fallback. */
export const DEFAULT_BRAND_ICON: string =
  "data:image/svg+xml;utf8," + encodeURIComponent(SVG);
