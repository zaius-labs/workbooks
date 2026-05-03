<script lang="ts">
  /* Input block renderer (epic core-6vr / B3).
   *
   * Render-only at the structural level — but B3's acceptance asks that
   * the user-facing value persist to body.value with valueChangedAt on
   * every change. So this component does call back through the
   * api.sbookBlocks.setBlockValue mutation when an sbook context is
   * available. Outside a sbook (e.g., legacy session-report viewer
   * passing the doc through), persistence degrades to local-state-only.
   *
   * Phase B does NOT include the connection-listing query or the R2
   * upload pipeline; those variants render an enabled-looking control
   * but their persistence is the same scalar writeback. The connection
   * picker's options-list integration lands in Phase C alongside step
   * actions that consume the chosen connection. */

  import type { InputBlock } from "../types";
  import { getWorkbookResolver } from "../workbookContext";

  let { block, blockId }: { block: InputBlock; blockId?: string } = $props();

  const resolver = getWorkbookResolver();

  // Local mirror so the input feels live before the mutation round-trips.
  // Initialized from block.value so re-renders after persistence land
  // on the same value the row holds.
  let localValue = $state<unknown>(block.value);

  async function persist(next: unknown) {
    localValue = next;
    // Skip persistence when blockId wasn't plumbed through (caller didn't
    // have one). The resolver no-ops gracefully when the workbook is
    // read-only (exported file viewed standalone).
    if (!blockId) return;
    try {
      await resolver.setInputValue(blockId, next);
    } catch (err) {
      // Swallow — input persistence shouldn't crash the canvas. A more
      // visible error surface lands when run-state is wired in C1.
      console.error("input persist failed", err);
    }
  }

  function onScalarChange(e: Event) {
    const t = e.currentTarget as HTMLInputElement;
    if (block.schema.kind !== "scalar") return;
    const raw = t.value;
    const next: unknown =
      block.schema.type === "number"
        ? raw === ""
          ? undefined
          : Number(raw)
        : block.schema.type === "boolean"
          ? t.checked
          : raw;
    void persist(next);
  }

  function onEnumChange(e: Event) {
    const t = e.currentTarget as HTMLSelectElement;
    void persist(t.value);
  }
</script>

<div
  class="rounded-[14px] border border-border bg-surface-soft px-4 py-3"
>
  {#if block.label}
    <label class="mb-1.5 block text-[12px] font-medium text-fg-muted">
      {block.label}
    </label>
  {/if}

  {#if block.schema.kind === "scalar"}
    {#if block.schema.type === "boolean"}
      <input
        type="checkbox"
        checked={Boolean(localValue)}
        onchange={onScalarChange}
        class="h-4 w-4 rounded border-border"
      />
    {:else}
      <input
        type={block.schema.type === "number" ? "number" : "text"}
        value={localValue ?? ""}
        oninput={onScalarChange}
        class="w-full rounded-md border border-border bg-surface px-2 py-1 text-[14px] text-fg outline-none focus:border-border-strong"
      />
    {/if}
  {:else if block.schema.kind === "enum"}
    <select
      value={(localValue as string) ?? ""}
      onchange={onEnumChange}
      class="w-full rounded-md border border-border bg-surface px-2 py-1 text-[14px] text-fg outline-none focus:border-border-strong"
    >
      <option value="" disabled>Pick one</option>
      {#each block.schema.options as opt (opt)}
        <option value={opt}>{opt}</option>
      {/each}
    </select>
  {:else if block.schema.kind === "connection"}
    <button
      type="button"
      class="w-full rounded-md border border-dashed border-border bg-surface px-2 py-2 text-left text-[13px] text-fg-muted"
      title="Connection picker lands in Phase C"
    >
      {localValue ? `Connection · ${String(localValue)}` : `Pick a ${block.schema.providers.join(" / ")} connection`}
    </button>
  {:else if block.schema.kind === "file"}
    <button
      type="button"
      class="w-full rounded-md border border-dashed border-border bg-surface px-2 py-2 text-left text-[13px] text-fg-muted"
      title="File picker lands in Phase C"
    >
      {localValue ? `File · ${String(localValue)}` : `Upload a file${block.schema.accept?.length ? ` (${block.schema.accept.join(", ")})` : ""}`}
    </button>
  {/if}
</div>
