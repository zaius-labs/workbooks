<script lang="ts">
  import type { MarkdownBlock } from "../types";
  import {
    CITE_ANCHOR_RE,
    getCitationContext,
  } from "../citationContext";
  import { DEFAULT_BRAND_ICON } from "./chart/brandIcon";
  import { safeHref, safeImgSrc } from "../util/url";

  let { block }: { block: MarkdownBlock } = $props();
  const citations = getCitationContext();

  let host = $state<HTMLElement | null>(null);

  /** Wire fallback-icon error listeners to brand <img>s after each
   *  render. Inline `onerror=` would force 'unsafe-inline' in CSP —
   *  closes core-0id.10 by attaching from JS. */
  $effect(() => {
    void tokens; // re-wire when content changes
    if (!host) return;
    queueMicrotask(() => {
      if (!host) return;
      for (const img of host.querySelectorAll<HTMLImageElement>("img.sd-brand-icon")) {
        if (img.dataset.wbBrandWired === "1") continue;
        img.dataset.wbBrandWired = "1";
        img.addEventListener(
          "error",
          function onerr() {
            this.removeEventListener("error", onerr);
            this.src = DEFAULT_BRAND_ICON;
          },
          { once: true },
        );
      }
    });
  });

  /**
   * Minimal, safe Markdown renderer. Supports:
   *   - paragraphs separated by blank lines
   *   - inline **bold** / *italic* / `code`
   *   - unordered lists (- or *)
   *   - ordered lists (1.)
   *   - fenced code blocks (```)
   *   - blockquotes (>)
   * No raw HTML, no links that aren't validated, no images.
   */

  type Token =
    | { kind: "p"; text: string }
    | { kind: "ul"; items: string[] }
    | { kind: "ol"; items: string[] }
    | { kind: "code"; language?: string; text: string }
    | { kind: "quote"; text: string };

  function tokenize(src: string): Token[] {
    const out: Token[] = [];
    const lines = src.replace(/\r\n/g, "\n").split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith("```")) {
        const language = line.slice(3).trim() || undefined;
        const buf: string[] = [];
        i += 1;
        while (i < lines.length && !lines[i].startsWith("```")) {
          buf.push(lines[i]);
          i += 1;
        }
        i += 1;
        out.push({ kind: "code", language, text: buf.join("\n") });
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
          i += 1;
        }
        out.push({ kind: "ul", items });
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
          i += 1;
        }
        out.push({ kind: "ol", items });
        continue;
      }
      if (line.startsWith(">")) {
        const buf: string[] = [];
        while (i < lines.length && lines[i].startsWith(">")) {
          buf.push(lines[i].slice(1).trim());
          i += 1;
        }
        out.push({ kind: "quote", text: buf.join(" ") });
        continue;
      }
      if (!line.trim()) {
        i += 1;
        continue;
      }
      const buf: string[] = [line];
      i += 1;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\s*[-*]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i]) &&
        !lines[i].startsWith("```") &&
        !lines[i].startsWith(">")
      ) {
        buf.push(lines[i]);
        i += 1;
      }
      out.push({ kind: "p", text: buf.join(" ") });
    }
    return out;
  }

  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Replace `[[c:id]]` citation anchors with numbered superscripts.
   *  Unknown ids drop silently. */
  function renderCiteAnchors(s: string): string {
    if (!citations) return s.replace(CITE_ANCHOR_RE, "");
    return s.replace(
      /\[\[c:([a-z][a-z0-9_]*)\]\]/g,
      (_match, id: string) => {
        const r = citations.resolve(id);
        if (!r) return "";
        return `<sup class="sd-cite"><a href="#sdoc-cite-${id}" data-cite-id="${id}">${r.number}</a></sup>`;
      },
    );
  }

  /** Replace `[[e:id]]` entity anchors with hover-tooltip badges. The
   *  badge label comes from entity.label; the tooltip body lists the
   *  data field/value pairs. */
  function renderEntityAnchors(s: string): string {
    if (!citations) return s.replace(/\[\[e:([a-z][a-z0-9_]*)\]\]/g, "");
    return s.replace(
      /\[\[e:([a-z][a-z0-9_]*)\]\]/g,
      (_match, id: string) => {
        const e = citations.resolveEntity(id);
        if (!e) return "";
        const tipRows = Object.entries(e.data)
          .slice(0, 8)
          .map(
            ([k, v]) =>
              `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v ?? ""))}</dd>`,
          )
          .join("");
        const ref = e.source?.ref ? escapeHtml(e.source.ref) : null;
        const tipHeader = ref
          ? `<header><span class="sd-ent-kind">${escapeHtml(e.kind)}</span><span class="sd-ent-ref">${ref}</span></header>`
          : `<header><span class="sd-ent-kind">${escapeHtml(e.kind)}</span></header>`;
        return `<span class="sd-entity"><span class="sd-entity-badge" tabindex="0" data-entity-id="${escapeHtml(id)}">${escapeHtml(e.label)}</span><span class="sd-entity-tip" role="tooltip">${tipHeader}<dl>${tipRows}</dl></span></span>`;
      },
    );
  }

  /** Replace `[[b:id]]` brand anchors with logo + name pills. The
   *  badge links to the brand's URL; the favicon comes from the
   *  context resolver (Google's favicon service or an override). */
  function renderBrandAnchors(s: string): string {
    if (!citations) return s.replace(/\[\[b:([a-z][a-z0-9_]*)\]\]/g, "");
    return s.replace(
      /\[\[b:([a-z][a-z0-9_]*)\]\]/g,
      (_match, id: string) => {
        const r = citations.resolveBrand(id);
        if (!r) return "";
        // Validate URL scheme — encodeURI is a percent-encoder, NOT a
        // scheme filter. A workbook-controlled `r.brand.url` of
        // "javascript:alert(1)" would otherwise ship a working XSS
        // payload through the {@html ...} consumer above. closes core-0id.1
        const url = safeHref(r.brand.url);
        if (!url) {
          // Brand has an unsafe URL — render as plain text, no anchor.
          return `<span class="sd-brand sd-brand-disabled" data-brand-id="${escapeHtml(id)}">${escapeHtml(r.brand.name)}</span>`;
        }
        const iconSrc = safeImgSrc(r.faviconUrl) ?? "";
        return `<a class="sd-brand" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" data-brand-id="${escapeHtml(id)}"><img class="sd-brand-icon" src="${escapeHtml(iconSrc)}" alt="" loading="lazy" referrerpolicy="no-referrer" /><span class="sd-brand-name">${escapeHtml(r.brand.name)}</span></a>`;
      },
    );
  }

  function inline(s: string): string {
    let t = escapeHtml(s);
    t = renderCiteAnchors(t);
    t = renderEntityAnchors(t);
    t = renderBrandAnchors(t);
    t = t.replace(/`([^`]+)`/g, '<code class="sd-icode">$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    return t;
  }

  const tokens = $derived(tokenize(block.text));
</script>

<div class="flex flex-col gap-3 text-[14px] leading-relaxed text-fg" bind:this={host}>
  {#each tokens as tok, i (i)}
    {#if tok.kind === "p"}
      <p>{@html inline(tok.text)}</p>
    {:else if tok.kind === "ul"}
      <ul class="list-disc space-y-1 pl-5">
        {#each tok.items as item, j (j)}
          <li>{@html inline(item)}</li>
        {/each}
      </ul>
    {:else if tok.kind === "ol"}
      <ol class="list-decimal space-y-1 pl-5">
        {#each tok.items as item, j (j)}
          <li>{@html inline(item)}</li>
        {/each}
      </ol>
    {:else if tok.kind === "code"}
      <pre
        class="overflow-x-auto rounded-lg bg-surface-soft px-3 py-2 text-[12.5px] leading-snug"
      ><code>{tok.text}</code></pre>
    {:else if tok.kind === "quote"}
      <blockquote
        class="border-l-2 border-border-strong pl-3 text-fg-muted"
      >
        {@html inline(tok.text)}
      </blockquote>
    {/if}
  {/each}
</div>

<style>
  :global(.sd-icode) {
    background: color-mix(in srgb, currentColor 6%, transparent);
    padding: 0 4px;
    border-radius: 4px;
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono",
      monospace;
    font-size: 0.92em;
  }
  :global(.sd-cite) {
    margin-left: 1px;
    font-size: 0.72em;
    color: var(--color-fg-muted);
  }
  :global(.sd-cite a) {
    text-decoration: none;
    border-radius: 4px;
    padding: 0 3px;
    background: color-mix(in srgb, currentColor 6%, transparent);
  }
  :global(.sd-cite a:hover) {
    color: var(--color-fg);
    background: color-mix(in srgb, currentColor 12%, transparent);
  }

  /* Entity badge — hover/focus reveals the data tooltip. */
  :global(.sd-entity) {
    position: relative;
    display: inline-block;
  }
  :global(.sd-entity-badge) {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 8px;
    margin: 0 1px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-surface-soft);
    font-size: 0.78em;
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono",
      monospace;
    color: var(--color-fg-muted);
    cursor: help;
    line-height: 1.4;
  }
  :global(.sd-entity-badge:hover),
  :global(.sd-entity-badge:focus) {
    color: var(--color-fg);
    border-color: var(--color-border-strong);
    outline: none;
  }
  :global(.sd-entity-tip) {
    position: absolute;
    z-index: 50;
    bottom: calc(100% + 6px);
    left: 0;
    min-width: 220px;
    max-width: 360px;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    box-shadow: var(--shadow-pop);
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 12px;
    line-height: 1.45;
    color: var(--color-fg);
    opacity: 0;
    pointer-events: none;
    transform: translateY(2px);
    transition:
      opacity 120ms ease,
      transform 120ms ease;
  }
  :global(.sd-entity:hover .sd-entity-tip),
  :global(.sd-entity:focus-within .sd-entity-tip) {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
  }
  :global(.sd-entity-tip header) {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin-bottom: 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--color-border);
  }
  :global(.sd-entity-tip .sd-ent-kind) {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-fg-muted);
  }
  :global(.sd-entity-tip .sd-ent-ref) {
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono",
      monospace;
    font-size: 11px;
    color: var(--color-fg);
  }
  :global(.sd-entity-tip dl) {
    display: grid;
    grid-template-columns: minmax(60px, auto) 1fr;
    gap: 2px 10px;
    margin: 0;
  }
  :global(.sd-entity-tip dt) {
    color: var(--color-fg-muted);
    font-size: 11px;
  }
  :global(.sd-entity-tip dd) {
    margin: 0;
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono",
      monospace;
    font-size: 11px;
    word-break: break-word;
  }

  /* Brand badge — favicon + name pill linking to the brand site. */
  :global(.sd-brand) {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 1px 8px 1px 4px;
    margin: 0 1px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-surface-soft);
    font-size: 0.86em;
    color: var(--color-fg);
    text-decoration: none;
    line-height: 1.4;
    vertical-align: baseline;
    transition: border-color 120ms ease, background 120ms ease;
  }
  :global(.sd-brand:hover) {
    border-color: var(--color-border-strong);
    background: var(--color-surface);
  }
  :global(.sd-brand-icon) {
    display: inline-block;
    width: 14px;
    height: 14px;
    border-radius: 3px;
    object-fit: cover;
    flex: 0 0 auto;
    /* Subtle ring so light favicons stay visible on light surfaces. */
    box-shadow: 0 0 0 1px color-mix(in srgb, currentColor 8%, transparent);
  }
  :global(.sd-brand-name) {
    font-weight: 500;
  }
</style>
