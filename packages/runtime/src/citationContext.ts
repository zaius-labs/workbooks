/**
 * Citation context — surfaces the doc's references / claims to inline
 * renderers (Markdown.svelte, Paragraph.svelte) so they can resolve
 * `[[c:<id>]]` anchors to numbered superscripts without prop-drilling.
 *
 * Numbering rule: each unique claim id picks up its number on FIRST
 * APPEARANCE in the rendered document. The same id reused later
 * renders the same number. Order matches reading order, which is
 * what the bibliography list at the bottom uses.
 *
 * The context is set by Workbook.svelte once per render and read by every
 * inline-rendering block. When the doc has no claims/references the
 * resolver returns null and the inline renderer drops the anchor
 * gracefully (so legacy reports without citations render identically).
 */
import { getContext, setContext } from "svelte";
import type {
  Brand,
  Claim,
  Entity,
  Reference,
  WorkbookDocument,
} from "./types";
import { DEFAULT_BRAND_ICON } from "./blocks/chart/brandIcon";

const KEY = Symbol("sdoc:citations");

export type ResolvedCitation = {
  /** 1-based reading-order number — what we render in the superscript. */
  number: number;
  claim?: Claim;
  /** Resolved references (deduped, in document order). */
  references: Reference[];
};

export type CitationContext = {
  /** Resolve a `[[c:id]]` anchor. Returns null when the id isn't
   *  registered — inline renderer drops the token. */
  resolve(claimId: string): ResolvedCitation | null;
  /** Iterate every claim id in numbering order. Used by the bottom-of-
   *  report widget to render the bibliography. */
  ordered(): { claimId: string; number: number }[];
  /** Resolve a `[[e:id]]` entity anchor. Returns null when the id
   *  isn't registered. Entities are NOT numbered — they render as
   *  inline badges with hover tooltips, not as superscripts. */
  resolveEntity(entityId: string): Entity | null;
  /** Resolve a `[[b:id]]` brand anchor. Returns the Brand record + a
   *  computed favicon URL. Falls back to a domain-derived favicon
   *  when the brand doesn't carry an explicit faviconUrl. */
  resolveBrand(brandId: string): { brand: Brand; faviconUrl: string } | null;
};

/** Build a context for `doc`. Call once per Workbook render and pass to
 *  setCitationContext below. */
export function buildCitationContext(doc: WorkbookDocument): CitationContext {
  const claimById = new Map<string, Claim>();
  for (const c of doc.claims ?? []) claimById.set(c.id, c);
  const refById = new Map<string, Reference>();
  for (const r of doc.references ?? []) refById.set(r.id, r);
  const entityById = new Map<string, Entity>();
  for (const e of doc.entities ?? []) entityById.set(e.id, e);
  const brandById = new Map<string, Brand>();
  for (const b of doc.brands ?? []) brandById.set(b.id, b);

  /* Numbering happens lazily — the first call to resolve(id) for an
   * unseen id assigns it the next number. This means anchors that
   * never appear in any rendered block don't get numbered, which is
   * what we want (the bibliography only lists what's actually cited). */
  const numbering = new Map<string, number>();
  const order: string[] = [];

  return {
    resolve(claimId) {
      const claim = claimById.get(claimId);
      const refIds = claim?.references ?? [];
      const refs: Reference[] = [];
      for (const id of refIds) {
        const r = refById.get(id);
        if (r) refs.push(r);
      }
      let n = numbering.get(claimId);
      if (n == null) {
        n = numbering.size + 1;
        numbering.set(claimId, n);
        order.push(claimId);
      }
      return { number: n, claim, references: refs };
    },
    ordered() {
      return order.map((claimId) => ({
        claimId,
        number: numbering.get(claimId) ?? 0,
      }));
    },
    resolveEntity(entityId) {
      return entityById.get(entityId) ?? null;
    },
    resolveBrand(brandId) {
      const brand = brandById.get(brandId);
      if (!brand) return null;
      return { brand, faviconUrl: faviconFor(brand) };
    },
  };
}

/** Derive a favicon URL for a brand. Prefers the brand's explicit
 *  faviconUrl; otherwise pulls from Google's free favicon service which
 *  requires no auth and caches at the edge. The agent can always
 *  override per-brand (custom logo, brandfetch URL, etc.). */
function faviconFor(brand: Brand): string {
  if (brand.faviconUrl) return brand.faviconUrl;
  try {
    const host = new URL(brand.url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  } catch {
    /* Bad URL — fall back to the briefcase icon so the badge has a
     * visible glyph. The renderer also uses onerror to swap to this
     * URI when a remote favicon fails to load at runtime. */
    return DEFAULT_BRAND_ICON;
  }
}

export function setCitationContext(ctx: CitationContext): void {
  setContext(KEY, ctx);
}

/** Read the context. Returns null when no Workbook parent has set one
 *  (e.g. previewing a single block in isolation). */
export function getCitationContext(): CitationContext | null {
  return (getContext(KEY) as CitationContext | undefined) ?? null;
}

/** Inline anchor regex — recognized in Markdown / Paragraph text:
 *    [[c:my_claim_id]]   citation anchor → numbered superscript
 *    [[e:my_entity_id]]  entity anchor → hover-tooltip badge
 *    [[b:my_brand_id]]   brand anchor → logo + name pill
 *  ids match the snake_case form used by the BitPlan ids. */
export const CITE_ANCHOR_RE = /\[\[c:([a-z][a-z0-9_]*)\]\]/g;
export const ENTITY_ANCHOR_RE = /\[\[e:([a-z][a-z0-9_]*)\]\]/g;
export const BRAND_ANCHOR_RE = /\[\[b:([a-z][a-z0-9_]*)\]\]/g;
