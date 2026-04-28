<script lang="ts">
  import type { WorkbookDocument, RunState } from "@shinymono/shared";
  import WorkbookBlock from "./WorkbookBlock.svelte";
  import CitationReport from "./CitationReport.svelte";
  import {
    buildCitationContext,
    setCitationContext,
  } from "./citationContext";
  import { defaultBlockRegistry, type BlockRegistry } from "./blockRegistry";

  /* `blockIds` is the per-block stable id from sbookBlocks rows, in
   * lockstep with `doc.blocks`. `runStates` is the parallel run-state
   * for step blocks. Both optional because Workbook is also used by the
   * legacy session-report viewer, which has no row-backed state.
   *
   * `registry` lets the consumer inject coupled blocks (file/image/video/
   * input/concept) that need runtime data fetching. Default registry has
   * the package's display blocks only — coupled blocks render a
   * "not available in this runtime" placeholder when no registry is
   * provided.
   */
  let {
    doc,
    blockIds,
    runStates,
    registry = defaultBlockRegistry,
  }: {
    doc: WorkbookDocument;
    blockIds?: string[];
    runStates?: Array<RunState | undefined>;
    registry?: BlockRegistry;
  } = $props();

  /* Build the context fresh per render so claim numbering stays in
   * lockstep with the rendered blocks. setContext must be called from
   * a script context (not inside an if/each), so we always set; the
   * context is a no-op for docs without citations. */
  const citations = $derived(buildCitationContext(doc));
  $effect.root(() => {
    setCitationContext(citations);
  });

  /* Show the bottom-of-report widget when the doc has any citation
   * infrastructure — references, glossary, claims, or a precomputed
   * score. Reports without any of these render unchanged. */
  const hasCitations = $derived(
    (doc.references && doc.references.length > 0) ||
      (doc.glossary && doc.glossary.length > 0) ||
      (doc.claims && doc.claims.length > 0) ||
      doc.citationScore != null,
  );
</script>

<article class="flex flex-col gap-4">
  {#if doc.title}
    <h1
      class="text-[22px] font-semibold tracking-tight text-fg"
    >
      {doc.title}
    </h1>
  {/if}
  {#if doc.tldr}
    <p
      class="text-[15px] leading-relaxed text-fg-muted"
    >
      {doc.tldr}
    </p>
  {/if}
  {#each doc.blocks as block, i (i)}
    <WorkbookBlock
      {block}
      blockId={blockIds?.[i]}
      runState={runStates?.[i]}
      {registry}
    />
  {/each}

  {#if hasCitations}
    <CitationReport {doc} {citations} />
  {/if}
</article>
