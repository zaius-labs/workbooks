<script>
  import { composition } from "../lib/composition.svelte.js";

  // Anchored popover for editing a clip's exact start/duration/end.
  // Shift+click on a clip → parent opens us with `clip` and an
  // anchor point in viewport coords. We commit via patchClip and
  // close on Apply, Esc, or outside click.
  let { clip = null, anchor = null, onClose } = $props();

  let startStr = $state("");
  let durStr = $state("");
  let endStr = $state("");
  let dirty = $state({}); // which field user last touched

  $effect(() => {
    if (!clip) return;
    startStr = clip.start.toFixed(2);
    durStr = clip.duration.toFixed(2);
    endStr = (clip.start + clip.duration).toFixed(2);
    dirty = {};
  });

  // Mirror inputs as the user types so end + start + duration stay
  // consistent. The "dirty" flag picks which two of the three the
  // user is treating as authoritative.
  function onStartInput(v) {
    startStr = v;
    dirty.start = true;
    if (dirty.end) {
      const s = parseFloat(v), e = parseFloat(endStr);
      if (Number.isFinite(s) && Number.isFinite(e)) durStr = (e - s).toFixed(2);
    } else {
      const s = parseFloat(v), d = parseFloat(durStr);
      if (Number.isFinite(s) && Number.isFinite(d)) endStr = (s + d).toFixed(2);
    }
  }
  function onDurInput(v) {
    durStr = v;
    dirty.dur = true;
    const s = parseFloat(startStr), d = parseFloat(v);
    if (Number.isFinite(s) && Number.isFinite(d)) endStr = (s + d).toFixed(2);
  }
  function onEndInput(v) {
    endStr = v;
    dirty.end = true;
    const s = parseFloat(startStr), e = parseFloat(v);
    if (Number.isFinite(s) && Number.isFinite(e)) durStr = (e - s).toFixed(2);
  }

  function apply() {
    const start = parseFloat(startStr);
    const duration = parseFloat(durStr);
    if (!Number.isFinite(start) || !Number.isFinite(duration)) return;
    if (duration < 0.05) return;
    composition.patchClip(clip.id, { start: Math.max(0, start), duration });
    onClose?.();
  }

  function onKey(e) {
    if (e.key === "Escape") onClose?.();
    if (e.key === "Enter") apply();
  }

  let popoverEl;
  function onWindowDown(e) {
    if (popoverEl && !popoverEl.contains(e.target)) onClose?.();
  }
  $effect(() => {
    if (!clip) return;
    // Defer one tick so the same pointerdown that opened us doesn't
    // immediately close us via the outside-click handler.
    const t = setTimeout(() => window.addEventListener("pointerdown", onWindowDown), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", onWindowDown);
      window.removeEventListener("keydown", onKey);
    };
  });
</script>

{#if clip && anchor}
  <div
    bind:this={popoverEl}
    role="dialog"
    aria-label="Edit clip range"
    class="fixed z-50 bg-surface text-fg border border-border-2 rounded-lg shadow-2xl p-3 w-64 font-mono text-[12px]"
    style="left: {Math.min(anchor.x, (window.innerWidth || 1200) - 280)}px; top: {Math.min(anchor.y + 12, (window.innerHeight || 800) - 240)}px;"
  >
    <div class="flex items-baseline justify-between mb-2 pb-2 border-b border-border">
      <span class="text-fg-muted text-[10px] uppercase tracking-wider">edit range</span>
      <span class="text-accent">{clip.id}</span>
    </div>

    <div class="space-y-2">
      <label class="block">
        <span class="text-[10px] uppercase tracking-wider text-fg-muted">start (s)</span>
        <input
          type="number" step="0.05" min="0"
          value={startStr}
          oninput={(e) => onStartInput(e.currentTarget.value)}
          class="w-full mt-0.5 px-2 py-1 bg-page border border-border rounded text-fg
                 focus:outline-1 focus:outline-accent focus:border-accent"
        />
      </label>
      <label class="block">
        <span class="text-[10px] uppercase tracking-wider text-fg-muted">duration (s)</span>
        <input
          type="number" step="0.05" min="0.05"
          value={durStr}
          oninput={(e) => onDurInput(e.currentTarget.value)}
          class="w-full mt-0.5 px-2 py-1 bg-page border border-border rounded text-fg
                 focus:outline-1 focus:outline-accent focus:border-accent"
        />
      </label>
      <label class="block">
        <span class="text-[10px] uppercase tracking-wider text-fg-muted">end (s)</span>
        <input
          type="number" step="0.05" min="0"
          value={endStr}
          oninput={(e) => onEndInput(e.currentTarget.value)}
          class="w-full mt-0.5 px-2 py-1 bg-page border border-border rounded text-fg
                 focus:outline-1 focus:outline-accent focus:border-accent"
        />
      </label>
    </div>

    <div class="flex justify-end gap-2 mt-3 pt-2 border-t border-border">
      <button
        onclick={onClose}
        class="px-3 py-1 rounded border border-border bg-page text-fg-muted hover:text-fg hover:border-border-2 cursor-pointer"
      >cancel</button>
      <button
        onclick={apply}
        class="px-3 py-1 rounded border border-accent bg-accent text-accent-fg font-semibold hover:opacity-90 cursor-pointer"
      >apply</button>
    </div>
  </div>
{/if}
