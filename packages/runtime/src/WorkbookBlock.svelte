<script lang="ts">
  /**
   * WorkbookBlock — the block dispatcher. Looks up the cell's component in
   * the registry and renders it with the appropriate props.
   *
   * Display blocks receive `{ block }`. Step blocks additionally receive
   * `{ blockId, runState }` for run-state coordination.
   *
   * The dispatcher is intentionally permissive: if a block kind is missing
   * from the registry (e.g. an exported workbook opened standalone has no
   * `file` provider), we render a placeholder instead of crashing. The
   * placeholder is plain text describing what's missing — readable but
   * non-interactive.
   */
  import type { WorkbookBlock as WorkbookBlockT, RunState } from "./types";
  import {
    defaultBlockRegistry,
    type BlockRegistry,
  } from "./blockRegistry";

  let {
    block,
    blockId,
    runState,
    registry = defaultBlockRegistry,
  }: {
    block: WorkbookBlockT;
    blockId?: string;
    runState?: RunState;
    registry?: BlockRegistry;
  } = $props();

  // Map block.kind to registry key. The kind discriminator from
  // @shinymono/shared uses snake_case ("embedding_3d") which matches our
  // registry keys directly.
  const Component = $derived(
    (registry as Record<string, unknown>)[block.kind] as
      | (typeof defaultBlockRegistry)[keyof typeof defaultBlockRegistry]
      | undefined,
  );

  // Step blocks need extra props beyond `block`. Easier to special-case
  // them here than to thread runState through every component.
  const isStep = $derived(block.kind === "step");
</script>

{#if Component}
  {#if isStep}
    {@const StepComponent = Component as typeof defaultBlockRegistry.step}
    <StepComponent {block} {blockId} {runState} />
  {:else}
    <Component {block} />
  {/if}
{:else}
  <!-- Block kind has no registry entry — usually a coupled block opened
       outside its host (e.g. a `file` block in a portable .workbook with no
       Convex client). Show a readable placeholder. -->
  <div class="workbook-block-missing rounded-md border border-dashed border-fg-muted/30 px-3 py-2 text-sm text-fg-muted">
    <strong>Block kind <code>{block.kind}</code> not available in this runtime.</strong>
    <br />
    Open this workbook in Signal to render it interactively.
  </div>
{/if}
