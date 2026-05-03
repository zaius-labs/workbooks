<script lang="ts">
  /**
   * <Cell> — declarative cell registration.
   *
   * Strict superset of <wb-cell> custom elements: anything
   *   <wb-cell language="polars" reads="csv">SELECT ...</wb-cell>
   * works as
   *   <Cell language="polars" reads="csv">SELECT ...</Cell>
   * plus typed props, slot props, runes-based reactivity, scoped CSS.
   *
   * Source can come from either:
   *   - the `source` prop (string), useful when the source is dynamic
   *   - the children slot (text), idiomatic for static cells
   *
   * If both are supplied, `source` wins. Children-as-source is captured
   * AT MOUNT and then on every $effect tick by re-reading the template's
   * textContent — works for static authoring (the common case). For
   * fully reactive source string, use the `source` prop instead.
   *
   * The component renders nothing visible by default — it's a behavioral
   * primitive. Pair with <Output for="..."> to render output. Or take
   * over via the `result` snippet:
   *
   *   <Cell id="x" language="polars">
   *     SELECT 1
   *     {#snippet result(state)}
   *       <MyCustomViz data={state.output} />
   *     {/snippet}
   *   </Cell>
   *
   * For composability: `useCell(id)` exposes the same reactive state
   * to any descendant.
   */

  import { onDestroy, tick } from "svelte";
  import type { Snippet } from "svelte";
  import { requireAuthoringContext } from "./context";
  import type { CellLanguage, Cell as CellSpec } from "../wasmBridge";
  import type { CellState } from "../reactiveExecutor";

  type Props = {
    id: string;
    language?: CellLanguage;
    reads?: string | string[];
    provides?: string | string[];
    source?: string;
    spec?: unknown;
    children?: Snippet;
    running?: Snippet<[CellState]>;
    error?: Snippet<[CellState]>;
    result?: Snippet<[CellState]>;
  };

  let {
    id,
    language = "rhai",
    reads,
    provides,
    source: sourceProp,
    spec,
    children,
    running,
    error: errorSnippet,
    result,
  }: Props = $props();

  const ctx = requireAuthoringContext("Cell");

  // ---- source resolution -------------------------------------------------

  // textCarrier is a hidden <template> we render children into, then read
  // textContent from. The DOM read isn't reactive — the $effect below
  // depends on `tick()` after children change to ensure the DOM has
  // rendered the latest snippet.
  let textCarrier = $state<HTMLTemplateElement | undefined>(undefined);
  let childSource = $state("");

  $effect(() => {
    // Re-read after Svelte has flushed any pending children updates.
    const carrier = textCarrier;
    if (!carrier) return;
    void tick().then(() => {
      // carrier.content lives in the template's `.content` document
      // fragment. Reading its textContent is cheap and avoids
      // descendents being part of the rendered DOM tree.
      childSource = carrier.content
        ? carrier.content.textContent?.trim() ?? ""
        : carrier.textContent?.trim() ?? "";
    });
  });

  const resolvedSource = $derived(
    sourceProp !== undefined ? sourceProp : childSource,
  );

  // ---- normalize reads/provides -----------------------------------------

  function toArray(v: string | string[] | undefined): string[] {
    if (!v) return [];
    if (Array.isArray(v)) return v.filter((s) => s.length > 0);
    return v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  // ---- registration with the DAG ----------------------------------------

  $effect(() => {
    const cell: CellSpec = {
      id,
      language,
      source: resolvedSource,
      dependsOn: toArray(reads),
      provides: toArray(provides),
      spec,
    };
    ctx.registerCell(cell);
  });

  onDestroy(() => {
    ctx.unregisterCell(id);
  });

  // ---- reactive state for slots ----------------------------------------

  const cellState = $derived(ctx.getCellState(id));
</script>

{#if children && sourceProp === undefined}
  <template bind:this={textCarrier}>{@render children()}</template>
{/if}

{#if cellState}
  {#if cellState.status === "running" && running}
    {@render running(cellState)}
  {:else if cellState.status === "error" && errorSnippet}
    {@render errorSnippet(cellState)}
  {:else if cellState.status === "ok" && result}
    {@render result(cellState)}
  {/if}
{/if}
