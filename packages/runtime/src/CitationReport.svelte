<script lang="ts">
  /**
   * Bottom-of-report citation widget. Renders:
   *   - Two-axis score summary (Sources / Own-work) — never collapses
   *     to one number on purpose; strong sources + weak model is a
   *     meaningful state and the user should see it as such.
   *   - Tier breakdown bar showing where citations come from
   *   - Top cited domains
   *   - Bibliography list (numbered, in reading order from the
   *     citation context — only refs that were actually anchored)
   *   - Glossary, when present
   *
   * Doesn't compute the score itself — reads citationScore off the
   * doc. The scorer is C5/C6 (separate pass).
   */
  import type {
    CitationScore,
    GlossaryEntry,
    Reference,
    WorkbookDocument,
  } from "./types";
  import type { CitationContext } from "./citationContext";

  let {
    doc,
    citations,
  }: {
    doc: WorkbookDocument;
    citations: CitationContext;
  } = $props();

  const refById = $derived(
    new Map((doc.references ?? []).map((r) => [r.id, r])),
  );
  const claimById = $derived(
    new Map((doc.claims ?? []).map((c) => [c.id, c])),
  );
  /** References in numbering order — only the ones that got anchored
   *  by claims in the doc. */
  const orderedRefs = $derived.by((): Array<{ number: number; ref: Reference; claimId: string }> => {
    const out: Array<{ number: number; ref: Reference; claimId: string }> = [];
    const seen = new Set<string>();
    for (const { claimId, number } of citations.ordered()) {
      const claim = claimById.get(claimId);
      if (!claim) continue;
      for (const refId of claim.references) {
        if (seen.has(refId)) continue;
        seen.add(refId);
        const ref = refById.get(refId);
        if (ref) out.push({ number, ref, claimId });
      }
    }
    return out;
  });

  /** Aggregate domain → count for the "top sources" panel. */
  const topDomains = $derived.by((): Array<{ domain: string; count: number }> => {
    const counts = new Map<string, number>();
    for (const r of doc.references ?? []) {
      if (!r.url) continue;
      try {
        const u = new URL(r.url);
        counts.set(u.hostname, (counts.get(u.hostname) ?? 0) + 1);
      } catch {
        /* ignore malformed URLs */
      }
    }
    return [...counts.entries()]
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  });

  /** Tier breakdown — proportional bar segments per tier. */
  const tierBreakdown = $derived.by((): Array<{ tier: string; count: number; pct: number }> => {
    const counts = new Map<string, number>();
    for (const r of doc.references ?? []) {
      const t = r.tier ?? "unknown";
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
    /* Stable order: most-credible-evidence first. */
    const order: string[] = [
      "peer-reviewed",
      "official-data",
      "established-outlet",
      "industry-blog",
      "forum-social",
      "unknown",
    ];
    return order
      .filter((t) => counts.has(t))
      .map((tier) => ({
        tier,
        count: counts.get(tier) ?? 0,
        pct: ((counts.get(tier) ?? 0) / total) * 100,
      }));
  });

  function tierColor(tier: string): string {
    switch (tier) {
      case "peer-reviewed":
        return "var(--color-brand-azure)";
      case "official-data":
        return "var(--color-brand-violet)";
      case "established-outlet":
        return "var(--color-brand-magenta)";
      case "industry-blog":
        return "var(--color-brand-amber)";
      case "forum-social":
        return "var(--color-brand-coral)";
      default:
        return "var(--color-fg-subtle)";
    }
  }

  function fmtPct(v: number): string {
    return `${Math.round(v * 100)}%`;
  }

  function fmtScore(v: number | undefined): string {
    if (v == null) return "—";
    return v.toFixed(2);
  }

  function fmtAuthors(authors?: string[]): string {
    if (!authors || authors.length === 0) return "";
    if (authors.length <= 3) return authors.join(", ");
    return `${authors.slice(0, 3).join(", ")}, et al.`;
  }

  const score: CitationScore | undefined = $derived(doc.citationScore);
  const glossary: GlossaryEntry[] = $derived(doc.glossary ?? []);
</script>

<section
  class="mt-6 flex flex-col gap-5 rounded-[18px] border border-border bg-surface p-5"
  aria-label="Citations"
>
  <header class="flex items-center gap-2">
    <span
      class="rounded-full border border-border bg-surface-soft px-2 py-0.5 text-[10px] uppercase tracking-wider text-fg-muted"
    >
      Citations
    </span>
    <h2 class="text-[15px] font-semibold tracking-tight">References &amp; quality</h2>
  </header>

  {#if score}
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <!-- Sources score -->
      <div
        class="flex flex-col gap-2 rounded-[14px] border border-border bg-surface-soft p-4"
      >
        <div class="flex items-baseline justify-between gap-2">
          <span class="text-[11px] uppercase tracking-wider text-fg-muted">
            Sources
          </span>
          <span class="text-[18px] font-semibold tracking-tight">
            {fmtScore(score.sources.coverage)}
          </span>
        </div>
        <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
          <span class="text-fg-muted">Coverage</span>
          <span class="text-right font-mono">{fmtPct(score.sources.coverage)}</span>
          <span class="text-fg-muted">Avg tier</span>
          <span class="text-right font-mono"
            >{fmtScore(score.sources.averageTier)}</span
          >
          {#if score.sources.primaryPercent != null}
            <span class="text-fg-muted">Primary %</span>
            <span class="text-right font-mono"
              >{fmtPct(score.sources.primaryPercent)}</span
            >
          {/if}
          {#if score.sources.averageCorroboration != null}
            <span class="text-fg-muted">Avg corroboration</span>
            <span class="text-right font-mono"
              >{score.sources.averageCorroboration.toFixed(1)}×</span
            >
          {/if}
          {#if score.sources.averageRecencyDays != null}
            <span class="text-fg-muted">Avg recency</span>
            <span class="text-right font-mono"
              >{Math.round(score.sources.averageRecencyDays)}d</span
            >
          {/if}
        </div>
      </div>

      <!-- Own-work score -->
      <div
        class="flex flex-col gap-2 rounded-[14px] border border-border bg-surface-soft p-4"
      >
        <div class="flex items-baseline justify-between gap-2">
          <span class="text-[11px] uppercase tracking-wider text-fg-muted">
            Model
          </span>
          <span class="text-[18px] font-semibold tracking-tight">
            {fmtScore(score.ownWork?.overall)}
          </span>
        </div>
        {#if score.ownWork?.machines && score.ownWork.machines.length > 0}
          <div class="flex flex-col gap-1.5 text-[12px]">
            {#each score.ownWork.machines as m (m.id)}
              <div class="flex items-baseline justify-between gap-2">
                <span class="font-mono text-fg-muted">{m.id}</span>
                <span class="text-right">
                  <span
                    class="font-mono"
                    style:color={m.margin >= 0
                      ? "var(--color-brand-azure)"
                      : "var(--color-brand-coral)"}
                  >
                    {m.value.toFixed(3)}
                  </span>
                  <span class="text-fg-muted">{m.metric}</span>
                  {#if m.margin >= 0}
                    <span class="text-[10px] text-fg-muted">+{m.margin.toFixed(2)}</span>
                  {:else}
                    <span class="text-[10px] text-fg-muted">{m.margin.toFixed(2)}</span>
                  {/if}
                </span>
              </div>
            {/each}
          </div>
        {:else}
          <p class="text-[12px] text-fg-muted">
            No machines in this report.
          </p>
        {/if}
      </div>
    </div>

    {#if tierBreakdown.length > 0}
      <div class="flex flex-col gap-2">
        <span class="text-[11px] uppercase tracking-wider text-fg-muted">
          Tier breakdown
        </span>
        <div
          class="flex h-2 overflow-hidden rounded-full border border-border"
          role="img"
          aria-label="Tier breakdown"
        >
          {#each tierBreakdown as t (t.tier)}
            <span
              class="h-full"
              style:width={`${t.pct}%`}
              style:background={tierColor(t.tier)}
              title={`${t.tier}: ${t.count} (${Math.round(t.pct)}%)`}
            ></span>
          {/each}
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          {#each tierBreakdown as t (t.tier)}
            <span class="inline-flex items-center gap-1 text-fg-muted">
              <span
                class="h-1.5 w-1.5 rounded-full"
                style:background={tierColor(t.tier)}
              ></span>
              {t.tier}
              <span class="font-mono">{t.count}</span>
            </span>
          {/each}
        </div>
      </div>
    {/if}
  {/if}

  {#if topDomains.length > 0}
    <div class="flex flex-col gap-2">
      <span class="text-[11px] uppercase tracking-wider text-fg-muted">
        Top sources
      </span>
      <ul class="flex flex-col gap-1 text-[12px]">
        {#each topDomains as d (d.domain)}
          <li class="flex items-baseline justify-between gap-3">
            <span class="font-mono text-fg">{d.domain}</span>
            <span class="font-mono text-fg-muted">{d.count}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if orderedRefs.length > 0}
    <div class="flex flex-col gap-2">
      <span class="text-[11px] uppercase tracking-wider text-fg-muted">
        References
      </span>
      <ol class="flex flex-col gap-1.5 text-[12.5px]">
        {#each orderedRefs as { number, ref } (ref.id)}
          <li
            id={`sdoc-cite-${ref.id}`}
            class="flex items-start gap-2"
          >
            <span class="w-6 shrink-0 text-right font-mono text-fg-muted">{number}.</span>
            <span class="flex flex-col">
              <span>
                {#if ref.url}
                  <a
                    href={ref.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="underline decoration-fg-muted underline-offset-2 hover:decoration-fg"
                    >{ref.title}</a
                  >
                {:else}
                  {ref.title}
                {/if}
              </span>
              <span class="text-[11px] text-fg-muted">
                {#if ref.authors && ref.authors.length}{fmtAuthors(ref.authors)} · {/if}
                {#if ref.publisher}{ref.publisher} · {/if}
                {#if ref.publishedAt}{ref.publishedAt}{/if}
                {#if ref.tier} · <span class="font-mono">{ref.tier}</span>{/if}
              </span>
            </span>
          </li>
        {/each}
      </ol>
    </div>
  {/if}

  {#if glossary.length > 0}
    <div class="flex flex-col gap-2">
      <span class="text-[11px] uppercase tracking-wider text-fg-muted">
        Glossary
      </span>
      <dl class="grid grid-cols-1 gap-2 text-[12.5px] sm:grid-cols-2">
        {#each glossary as g (g.term)}
          <div class="flex flex-col">
            <dt class="font-semibold">{g.term}</dt>
            <dd class="text-fg-muted">{g.definition}</dd>
          </div>
        {/each}
      </dl>
    </div>
  {/if}
</section>
