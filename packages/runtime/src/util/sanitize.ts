/**
 * HTML / SVG sanitization helpers — closes core-0id.2.
 *
 * Anywhere we set `el.innerHTML = workbook_controlled_string`, we
 * need to strip dangerous markup first. SVG is not a safe subset of
 * HTML — `<svg><script>...</script></svg>`, `<svg onload="...">`,
 * and `<svg><foreignObject><iframe src=javascript:...>` all execute
 * if dropped into innerHTML untouched.
 *
 * We use DOMPurify for both HTML and SVG sanitization. DOMPurify
 * runs entirely in-browser, parses to a DOM, walks it removing
 * dangerous tags/attributes, and re-serializes. It's the standard
 * library for this job; rolling our own would be the wrong call.
 *
 * Two profiles:
 *
 *   sanitizeSvg(svg)   — for SVG payloads (Plotters chart output,
 *                         Mermaid diagram render, embedded SVG cell
 *                         outputs). Allows SVG + filters; forbids
 *                         <script>, <foreignObject>, on*= handlers.
 *
 *   sanitizeHtml(html) — for arbitrary author-provided HTML. Allows
 *                         a conservative set of structural tags +
 *                         text-formatting + minimal media. URLs
 *                         restricted to http(s) / mailto / root-
 *                         relative / fragment — same set as
 *                         util/url.ts safeHref.
 *
 * Lazy-loaded: workbooks that never produce SVG / sanitize HTML
 * don't pay the ~22 KB DOMPurify cost. Two import sites:
 *  - the bundle re-exports them for chat-app's inline-bundle path;
 *    ESM tree-shaking handles the lazy load there.
 *  - npm consumers import on demand.
 */

import DOMPurify from "dompurify";

const SVG_PROFILE: DOMPurify.Config = {
  USE_PROFILES: { svg: true, svgFilters: true },
  // Belt-and-suspenders — the SVG profile already blocks <script>
  // and on-event handlers, but list explicitly so a future profile
  // change in DOMPurify doesn't quietly weaken our policy.
  FORBID_TAGS: ["script", "foreignObject"],
  FORBID_ATTR: [
    "onclick", "onload", "onerror", "onmouseover", "onmouseout",
    "onfocus", "onblur", "onkeydown", "onkeyup", "onkeypress",
    "onchange", "onsubmit", "ondblclick", "onpointerdown",
    "onpointerup", "onanimationend", "onanimationstart",
    "onanimationiteration", "ontransitionend", "ontransitionstart",
  ],
};

const HTML_PROFILE: DOMPurify.Config = {
  ALLOWED_TAGS: [
    "a", "b", "code", "div", "em", "i", "p", "pre", "small", "span",
    "strong", "sub", "sup", "br", "hr", "ul", "ol", "li", "blockquote",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "img", "table", "thead", "tbody", "tr", "th", "td", "caption",
    "figure", "figcaption", "kbd", "mark",
  ],
  ALLOWED_ATTR: [
    "class", "href", "src", "alt", "title", "target", "rel",
    "data-cite-id", "data-entity-id", "data-brand-id", "data-cell-id",
    "tabindex", "role", "aria-label", "aria-describedby",
    "loading", "referrerpolicy", "colspan", "rowspan",
  ],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|\/[^/]|#)/i,
};

/** Sanitize an SVG payload before setting innerHTML. */
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, SVG_PROFILE) as string;
}

/** Sanitize an HTML fragment before setting innerHTML. */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, HTML_PROFILE) as string;
}
