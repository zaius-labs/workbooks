<script lang="ts">
  /* Step block renderer (epic core-6vr / B4 + C1.i3).
   *
   * B4 shipped the spec-only shell. C1.i3 adds the run-state status pill
   * and lets the play button enable when the step is replayable
   * (stale / error). Action execution itself still lands in C2 — clicks
   * are no-op until then; the button just stops looking dormant for
   * states where action is meaningful. */

  import type { StepBlock, RunState } from "../types";

  let {
    block,
    runState,
  }: { block: StepBlock; runState?: RunState } = $props();

  const actionLabel = $derived(
    block.action.kind === "agent_turn"
      ? "Agent turn"
      : block.action.kind === "machine_call"
        ? "Machine call"
        : block.action.kind === "widget_call"
          ? "Widget call"
          : block.action.kind === "connection_fetch"
            ? "Connection fetch"
            : block.action.kind === "replay"
              ? "Replay step"
              : block.action.kind === "loop"
                ? "Loop"
                : "Step",
  );

  const triggerLabel = $derived(
    block.trigger.kind === "manual"
      ? "Manual"
      : block.trigger.kind === "auto_on_input"
        ? "Auto"
        : block.trigger.kind === "cron"
          ? `Cron · ${block.trigger.expr}`
          : block.trigger.kind === "after"
            ? `After ${block.trigger.upstreamBlockId}`
            : "—",
  );

  const gates = $derived(block.gates ?? []);

  /* Status pill palette. Semantic colors only on STATE per the project's
   * monochromatic chrome convention — emerald=ok, amber=processing or
   * warning, blue=in-flight, rose=error, mono for idle/stale baseline. */
  type PillStyle = { bg: string; text: string; label: string };
  const pill = $derived<PillStyle>(
    !runState
      ? { bg: "bg-surface", text: "text-fg-muted", label: "Idle" }
      : runState.status === "idle"
        ? { bg: "bg-surface", text: "text-fg-muted", label: "Idle" }
        : runState.status === "queued"
          ? {
              bg: "bg-amber-50 dark:bg-amber-700/15",
              text: "text-amber-700 dark:text-amber-200",
              label: "Queued",
            }
          : runState.status === "running"
            ? {
                bg: "bg-sky-50 dark:bg-sky-700/15",
                text: "text-sky-700 dark:text-sky-200",
                label: "Running",
              }
            : runState.status === "done"
              ? {
                  bg: "bg-emerald-50 dark:bg-emerald-700/15",
                  text: "text-emerald-700 dark:text-emerald-200",
                  label: "Done",
                }
              : runState.status === "error"
                ? {
                    bg: "bg-rose-50 dark:bg-rose-700/15",
                    text: "text-rose-700 dark:text-rose-200",
                    label: "Error",
                  }
                : {
                    bg: "bg-amber-50 dark:bg-amber-700/15",
                    text: "text-amber-700 dark:text-amber-200",
                    label: "Stale",
                  },
  );

  /* Play button is replayable when the step is stale (upstream changed)
   * or errored (worth retrying). Idle blocks should also be playable
   * once C2 wires execution; for now they stay disabled with the
   * Phase-C deferral tooltip. Running/queued never enable. */
  const playable = $derived(
    runState?.status === "stale" || runState?.status === "error",
  );
  const playLabel = $derived(playable ? "Replay" : "Play");
  const playTitle = $derived(
    playable
      ? "Step execution lands in Phase C — button will activate then"
      : "Step execution lands in Phase C",
  );
</script>

<div
  class="flex items-start gap-3 rounded-[14px] border border-border bg-surface-soft px-4 py-3"
>
  <div class="flex-1 min-w-0">
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-[14px] font-medium text-fg">{block.label}</span>
      <span
        class="rounded-md px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide {pill.bg} {pill.text}"
      >
        {pill.label}
      </span>
      <span
        class="rounded-md border border-border px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-fg-muted"
      >
        {actionLabel}
      </span>
      <span class="text-[11px] text-fg-muted">{triggerLabel}</span>
    </div>
    {#if gates.length > 0}
      <div class="mt-1.5 flex flex-wrap gap-1">
        {#each gates as gate (gate)}
          <span
            class="rounded-md bg-surface px-1.5 py-0.5 text-[11px] text-fg-muted"
            title="Gate evaluation lands in Phase D"
          >
            gate · {gate}
          </span>
        {/each}
      </div>
    {/if}
    {#if runState?.status === "error" && runState.error}
      <div class="mt-1.5 text-[12px] text-rose-700 dark:text-rose-300">
        {runState.error}
      </div>
    {/if}
  </div>
  <button
    type="button"
    disabled
    title={playTitle}
    class="cursor-not-allowed rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] text-fg-muted opacity-60"
  >
    {playLabel}
  </button>
</div>
