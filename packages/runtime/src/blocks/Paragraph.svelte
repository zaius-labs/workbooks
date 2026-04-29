<script lang="ts">
  import type { ParagraphBlock } from "../types";
  import {
    CITE_ANCHOR_RE,
    getCitationContext,
  } from "../citationContext";
  import { BRAND_ICON_ONERROR } from "./chart/brandIcon";

  let { block }: { block: ParagraphBlock } = $props();
  const citations = getCitationContext();

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
        const url = encodeURI(r.brand.url);
        return `<a class="sd-brand" href="${url}" target="_blank" rel="noopener noreferrer" data-brand-id="${escapeHtml(id)}"><img class="sd-brand-icon" src="${escapeHtml(r.faviconUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="${escapeHtml(BRAND_ICON_ONERROR)}" /><span class="sd-brand-name">${escapeHtml(r.brand.name)}</span></a>`;
      },
    );
    return t;
  });
</script>

<p class="text-[14px] leading-relaxed text-fg">
  {@html html}
</p>
