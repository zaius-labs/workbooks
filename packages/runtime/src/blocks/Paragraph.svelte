<script lang="ts">
  import type { ParagraphBlock } from "../types";
  import {
    CITE_ANCHOR_RE,
    getCitationContext,
  } from "../citationContext";
  import { DEFAULT_BRAND_ICON } from "./chart/brandIcon";
  import { safeHref, safeImgSrc } from "../util/url";

  let { block }: { block: ParagraphBlock } = $props();
  const citations = getCitationContext();

  let host = $state<HTMLElement | null>(null);

  /** Wire a fallback-icon error listener to every brand <img> the
   *  rendered HTML produces. Inline `onerror=` would force
   *  'unsafe-inline' in the host CSP — closes core-0id.10 by
   *  attaching the handler from JS instead. Re-runs whenever the
   *  derived `html` changes (Svelte re-renders into the same host). */
  $effect(() => {
    void html; // dependency
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

  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Render `[[c:id]]` citation anchors as numbered superscripts,
   *  `[[e:id]]` entity anchors as hover-tooltip badges, and
   *  `[[b:id]]` brand anchors as logo+name pills. Unknown ids drop
   *  silently. Same shape as the Markdown block's anchor renderer —
   *  keeps the two paths consistent. */
  const html = $derived.by(() => {
    let t = escapeHtml(block.text);
    if (!citations) {
      return t.replace(/\[\[[ceb]:[a-z][a-z0-9_]*\]\]/g, "");
    }
    t = t.replace(
      /\[\[c:([a-z][a-z0-9_]*)\]\]/g,
      (_match, id: string) => {
        const r = citations.resolve(id);
        if (!r) return "";
        return `<sup class="sd-cite"><a href="#sdoc-cite-${id}" data-cite-id="${id}">${r.number}</a></sup>`;
      },
    );
    t = t.replace(
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
    t = t.replace(
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
    return t;
  });
</script>

<p class="text-[14px] leading-relaxed text-fg" bind:this={host}>
  {@html html}
</p>
