/**
 * Workbook markdown renderer.
 *
 * A small CommonMark-ish renderer for assistant text in chat / agent
 * workbooks. Returns HTML string; callers use `innerHTML`. HTML in
 * the input is escaped first; only tags this function emits make it
 * into the output.
 *
 * Supports:
 *   - Fenced code blocks (```lang\n...\n```)
 *   - Inline code (`...`)
 *   - Headings (#, ##, ###, ####)
 *   - Unordered + ordered lists (- / * / + and 1.)
 *   - Blockquotes (>)
 *   - Horizontal rules (---, ***, ___)
 *   - Bold (**, __) and italic (*, _)
 *   - Links [text](url) — http(s) / anchor / root-relative only;
 *     javascript: and data: URLs render as plain text
 *   - Bare URL autolinks
 *
 * Streaming-friendly: an unclosed fence renders as a code block and
 * recovers cleanly when the closing ``` arrives in the next delta.
 *
 * Tradeoffs:
 *   - No nested lists, no GFM tables (kept tight).
 *   - No source-map / position info (we don't author markdown
 *     editors here, just render assistant output).
 */

import { safeHref } from "./util/url";

export function escapeHtml(s: string | null | undefined): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;"
      : c === "<" ? "&lt;"
        : c === ">" ? "&gt;"
          : c === '"' ? "&quot;"
            : "&#39;",
  );
}

export function renderMarkdown(src: string | null | undefined): string {
  const text = String(src ?? "");

  // 1. Pull out fenced code blocks first so their contents skip
  //    inline transforms. Placeholders are sentinels that user text
  //    can't reasonably collide with.
  const blocks: string[] = [];
  const FENCE = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)(?:```|$)/g;
  const withPlaceholders = text.replace(FENCE, (_m, lang, body) => {
    const id = blocks.length;
    const cls = lang ? ` class="language-${String(lang).toLowerCase()}"` : "";
    blocks.push(`<pre><code${cls}>${escapeHtml(body)}</code></pre>`);
    return ` FENCE${id} `;
  });

  // 2. Escape everything else, then re-introduce inline syntax.
  const escaped = escapeHtml(withPlaceholders);

  // 3. Block parsing: split into groups separated by blank lines.
  const lines = escaped.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) { i++; continue; }

    // Fence placeholder
    const fenceMatch = line.match(/^ FENCE(\d+) $/);
    if (fenceMatch) {
      out.push(blocks[Number(fenceMatch[1])]);
      i++; continue;
    }

    // Heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++; continue;
    }

    // HR
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("<hr/>");
      i++; continue;
    }

    // Blockquote group (escapeHtml turned > into &gt;)
    if (/^\s*&gt;\s?/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
        rows.push(lines[i].replace(/^\s*&gt;\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inline(rows.join("\n")).replace(/\n/g, "<br/>")}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      out.push("<ul>" + items.map((t) => `<li>${inline(t)}</li>`).join("") + "</ul>");
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push("<ol>" + items.map((t) => `<li>${inline(t)}</li>`).join("") + "</ol>");
      continue;
    }

    // Paragraph: collect contiguous non-blank, non-special lines.
    const para: string[] = [];
    while (
      i < lines.length
      && !/^\s*$/.test(lines[i])
      && !/^(#{1,4})\s+/.test(lines[i])
      && !/^\s*[-*+]\s+/.test(lines[i])
      && !/^\s*\d+\.\s+/.test(lines[i])
      && !/^\s*&gt;\s?/.test(lines[i])
      && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])
      && !/^ FENCE\d+ $/.test(lines[i])
    ) {
      para.push(lines[i]); i++;
    }
    out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br/>")}</p>`);
  }

  return out.join("");
}

// Inline pass: backtick code, bold, italic, links, autolinks.
// Order matters: code spans first so `*` inside code isn't bold.
function inline(s: string): string {
  const codes: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, body) => {
    codes.push(`<code>${body}</code>`);
    return ` CODE${codes.length - 1} `;
  });
  // Bold (** or __), then italic (* or _).
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, "<em>$1</em>");
  s = s.replace(/(?<![_\w])_([^_\n]+)_(?!\w)/g, "<em>$1</em>");
  // Links [text](url) — http(s) / mailto / anchor / root-relative
  // only. Anything else (javascript:, data:html, vbscript:, etc.)
  // renders as plain text. Centralized via safeHref for consistency
  // with brand-anchor / Paragraph / Markdown rendering.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/g, (m, label, url, title) => {
    const safe = safeHref(url);
    if (!safe) return m;
    const t = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer noopener"${t}>${label}</a>`;
  });
  // Autolinks for bare http(s) URLs.
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g,
    (_m, lead, url) => {
      const safe = safeHref(url);
      if (!safe) return _m;
      return `${lead}<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer noopener">${escapeHtml(safe)}</a>`;
    });
  // Restore code spans.
  s = s.replace(/ CODE(\d+) /g, (_m, n) => codes[Number(n)]);
  return s;
}
