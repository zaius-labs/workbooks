<script lang="ts">
  /* Machine block render shell (epic core-6vr / B2).
   *
   * Phase B is render-only: shows the pinned machine + version + mode
   * with a disabled inference action. Real mounting of the existing
   * inference UI from /machines/[slug] lands in Phase C alongside step
   * actions that share the same machineInfer ingress + binding
   * resolver. */

  import type { MachineBlock, Binding } from "../types";

  let { block }: { block: MachineBlock } = $props();

  /* Bindings render as the upstream pointer; literal ids/versions
   * render directly. Phase C resolves Bindings against upstream
   * block run.output via the shared binding-resolver helper. */
  function bindingLabel(v: string | number | Binding): string {
    if (typeof v === "object" && v && "from" in v) {
      return `${v.from} · ${v.path}`;
    }
    return String(v);
  }

  const modeLabel = $derived(
    block.mode === "predict"
      ? "Predict"
      : block.mode === "classify"
        ? "Classify"
        : block.mode === "search"
          ? "Search"
          : "Embed",
  );
</script>

<div
  class="flex items-start gap-3 rounded-[14px] border border-border bg-surface-soft px-4 py-3"
>
  <div class="flex-1 min-w-0">
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-[14px] font-medium text-fg">
        {block.title ?? "Machine"}
      </span>
      <span
        class="rounded-md border border-border px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-fg-muted"
      >
        {modeLabel}
      </span>
    </div>
    <div class="mt-1 text-[12px] text-fg-muted">
      <span>machine · {bindingLabel(block.machineId)}</span>
      <span class="mx-1.5">·</span>
      <span>v{bindingLabel(block.machineVersion)}</span>
    </div>
  </div>
  <button
    type="button"
    disabled
    title="Machine inference UI lands in Phase C"
    class="cursor-not-allowed rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] text-fg-muted opacity-60"
  >
    Run
  </button>
</div>
