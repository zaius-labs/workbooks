<script>
  import { composition } from "../lib/composition.svelte.js";
  import { layout, ZOOM_PRESETS } from "../lib/layout.svelte.js";
  import RangeEditorPopover from "./RangeEditorPopover.svelte";
  import { timelineClipActions } from "../lib/pluginApi.svelte.js";

  let rangeEditor = $state(null); // { clip, anchor: {x, y} }

  // Selection model. Plain click on a clip replaces; Cmd/Ctrl+click
  // toggles in/out of the multi-set. Backspace or Delete removes
  // every selected clip (when focus isn't in an input/textarea).
  // Click on empty timeline area clears the selection. Shift+click
  // is reserved for the existing RangeEditor popover.
  let selectedIds = $state(new Set());
  function isMultiSelectKey(ev) {
    return ev.metaKey || ev.ctrlKey;
  }

  let trackEl;
  let dragging = $state(false);
  let hoverX = $state(null);

  let total = $derived(Math.max(composition.totalDuration, 0.001));
  let trackPxWidth = $derived(total * layout.pps);
  let playheadPx = $derived(composition.curTime * layout.pps);
  let hoverTime = $derived(hoverX === null ? null : Math.max(0, Math.min(total, hoverX / layout.pps)));

  // Hybrid lane assignment: explicit data-track-index pinned, others
  // greedy-packed into the lowest non-colliding lane.
  function clipsOverlap(a, b) {
    return a.start < b.start + b.duration - 1e-9
        && b.start < a.start + a.duration - 1e-9;
  }
  let lanes = $derived.by(() => {
    const explicit = [];
    const unindexed = [];
    for (const c of composition.clips) {
      if (Number.isFinite(c.trackIndex)) explicit.push(c);
      else unindexed.push(c);
    }
    const maxExplicit = explicit.reduce((m, c) => Math.max(m, c.trackIndex), -1);
    const out = Array.from({ length: maxExplicit + 1 }, () => []);
    for (const c of explicit) out[c.trackIndex].push(c);
    for (const lane of out) lane.sort((a, b) => a.start - b.start);
    for (const c of unindexed) {
      let placed = false;
      for (const lane of out) {
        if (!lane.some((l) => clipsOverlap(l, c))) {
          lane.push(c);
          lane.sort((a, b) => a.start - b.start);
          placed = true;
          break;
        }
      }
      if (!placed) out.push([c]);
    }
    return out;
  });

  function postSeek(t) {
    composition.curTime = t;
    const frame = document.querySelector("iframe[title='HyperFrames preview']");
    frame?.contentWindow?.postMessage({ type: "seek", value: t }, "*");
  }

  function clientToTime(clientX) {
    if (!trackEl) return 0;
    const r = trackEl.getBoundingClientRect();
    const x = Math.max(0, Math.min(trackPxWidth, clientX - r.left));
    return x / layout.pps;
  }

  function onPointerDown(ev) {
    if (ev.button !== 0) return;
    trackEl.setPointerCapture(ev.pointerId);
    dragging = true;
    composition.playing = false;
    const frame = document.querySelector("iframe[title='HyperFrames preview']");
    frame?.contentWindow?.postMessage({ type: "pause" }, "*");
    postSeek(clientToTime(ev.clientX));
  }
  function onPointerMove(ev) {
    if (!trackEl) return;
    const r = trackEl.getBoundingClientRect();
    hoverX = Math.max(0, Math.min(trackPxWidth, ev.clientX - r.left));
    if (dragging) postSeek(clientToTime(ev.clientX));
  }
  function onPointerUp(ev) {
    if (dragging) {
      dragging = false;
      try { trackEl.releasePointerCapture(ev.pointerId); } catch {}
    }
  }
  function onPointerLeave() { hoverX = null; }

  // Ruler tick step picks a value that gives ~6-12 visible labels at
  // the current zoom. Once pps × step ≥ ~80px, labels won't pile up.
  let tickStep = $derived.by(() => {
    const minPxPerLabel = 80;
    const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    for (const c of candidates) if (c * layout.pps >= minPxPerLabel) return c;
    return 300;
  });
  let ticks = $derived.by(() => {
    const out = [];
    for (let s = 0; s <= total + 1e-9; s += tickStep) {
      out.push({ t: s, x: s * layout.pps });
    }
    return out;
  });

  function fmtTime(s) {
    if (!Number.isFinite(s)) return "0:00";
    if (s < 60 && tickStep < 1) return s.toFixed(1) + "s";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s - m * 60);
    return `${m}:${String(sec).padStart(2, "0")}`;
  }
  function fmtTimeFine(s) {
    if (!Number.isFinite(s)) return "0.0s";
    return `${s.toFixed(2)}s`;
  }

  let zoomPct = $derived(Math.round((layout.pps / 100) * 100));

  // First-run hint banner. Same localStorage key as upstream
  // HyperFrames Studio so a user who's already dismissed it there
  // won't see it again here.
  const HINT_KEY = "hf-studio-timeline-editor-hint-dismissed";
  let hintDismissed = $state(
    typeof localStorage !== "undefined" && localStorage.getItem(HINT_KEY) === "1"
  );
  function dismissHint() {
    hintDismissed = true;
    try { localStorage.setItem(HINT_KEY, "1"); } catch {}
  }

  // ─── Drop import ────────────────────────────────────────────
  // Drag image/video/audio files onto the track → resolve drop
  // coords to {start, track} via pps + lane height, read each
  // file as a data URL, append to composition. Other MIME types
  // get a flash error.
  let dropFlash = $state(null); // { kind: "ok" | "err", text }
  let dragHover = $state(false);

  function dropTimeFromEvent(ev) {
    const rect = trackEl.getBoundingClientRect();
    const x = Math.max(0, ev.clientX - rect.left);
    const y = Math.max(0, ev.clientY - rect.top);
    return {
      start: Math.max(0, +(x / layout.pps).toFixed(2)),
      // lane = (y - ruler-height) / lane-step. Ruler is ~20px;
      // ignore negatives (drop on the ruler treated as lane 0).
      trackIndex: Math.max(0, Math.floor((y - 24) / LANE_STEP_PX)),
    };
  }

  async function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  async function durationFromMediaUrl(url, kind) {
    if (kind === "img") return 3; // images don't have a natural duration
    return new Promise((resolve) => {
      const el = document.createElement(kind === "video" ? "video" : "audio");
      el.preload = "metadata";
      el.src = url;
      el.onloadedmetadata = () => resolve(Math.max(0.5, +(el.duration || 3).toFixed(2)));
      el.onerror = () => resolve(3);
      // 3s safety in case the loadedmetadata event never fires.
      setTimeout(() => resolve(3), 3000);
    });
  }

  function classifyFile(file) {
    if (!file?.type) return null;
    if (file.type.startsWith("image/")) return "img";
    if (file.type.startsWith("video/")) return "video";
    if (file.type.startsWith("audio/")) return "audio";
    return null;
  }

  function flash(kind, text) {
    dropFlash = { kind, text };
    setTimeout(() => { dropFlash = null; }, 2400);
  }

  async function onDragOver(ev) {
    if (!ev.dataTransfer) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
    dragHover = true;
  }
  function onDragLeave() { dragHover = false; }

  async function onDrop(ev) {
    ev.preventDefault();
    dragHover = false;
    const files = Array.from(ev.dataTransfer?.files ?? []);
    if (!files.length) return;
    let { start, trackIndex } = dropTimeFromEvent(ev);
    let added = 0;
    for (const file of files) {
      const kind = classifyFile(file);
      if (!kind) continue;
      const url = await readFileAsDataUrl(file);
      const duration = await durationFromMediaUrl(url, kind);
      composition.addMediaClip({
        kind, src: url, start, duration, trackIndex,
        label: file.name,
      });
      // Append next dropped file immediately after this one on the
      // same lane, mirroring how upstream Studio handles multi-drop.
      start = +(start + duration).toFixed(2);
      added += 1;
    }
    if (added) flash("ok", `Added ${added} clip${added === 1 ? "" : "s"}`);
    else flash("err", "Only image, video, and audio files can be dropped");
  }

  // ─── Edge trim ──────────────────────────────────────────────
  // Pointer-drag on a 18px-wide handle at either edge of a clip.
  // Right handle: extends/shrinks duration. Left handle: moves
  // start AND adjusts playbackStart (media in-point) by the same
  // delta so visible content doesn't shift. Constraints:
  //   - min duration 0.05s (HyperFrames Studio's floor)
  //   - max end clamped to next clip on the same lane (no overlap)
  //   - left edge clamped to ≥ 0 and ≤ start + duration - minDur
  // Updates flush through composition.patchClip — the iframe
  // remounts on each pointermove, which is fine at 60Hz for short
  // documents but may need throttling for huge ones.
  const MIN_DUR = 0.05;
  let trimming = $state(null); // { id, edge, startStart, startDur, startPS, originX, lane }

  function nextClipStart(c) {
    // Find clips on the same lane (whether explicit or via packing)
    // that start at or after c. Used to clamp the right edge so a
    // trim doesn't push past the neighbor.
    for (const lane of lanes) {
      if (!lane.includes(c)) continue;
      const sorted = [...lane].sort((a, b) => a.start - b.start);
      const i = sorted.indexOf(c);
      if (i >= 0 && i + 1 < sorted.length) return sorted[i + 1].start;
    }
    return Infinity;
  }

  function onTrimStart(ev, clip, edge) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const target = ev.currentTarget;
    target.setPointerCapture(ev.pointerId);
    composition.playing = false;
    const frame = document.querySelector("iframe[title='HyperFrames preview']");
    frame?.contentWindow?.postMessage({ type: "pause" }, "*");
    trimming = {
      id: clip.id,
      edge,
      startStart: clip.start,
      startDur: clip.duration,
      startPS: clip.playbackStart ?? 0,
      originX: ev.clientX,
      maxEnd: nextClipStart(clip),
    };
  }
  function onTrimMove(ev) {
    if (!trimming) return;
    const dx = ev.clientX - trimming.originX;
    const dt = dx / layout.pps;
    if (trimming.edge === "end") {
      const maxDur = trimming.maxEnd - trimming.startStart;
      const newDur = Math.min(maxDur, Math.max(MIN_DUR, trimming.startDur + dt));
      composition.patchClip(trimming.id, { duration: newDur });
    } else {
      // Left edge: shrink duration, advance start, AND advance
      // playbackStart by the same delta so the visible media frame
      // doesn't jump.
      const minStart = 0;
      const maxStart = trimming.startStart + trimming.startDur - MIN_DUR;
      const newStart = Math.min(maxStart, Math.max(minStart, trimming.startStart + dt));
      const consumedDt = newStart - trimming.startStart;
      const newDur = trimming.startDur - consumedDt;
      const newPS = Math.max(0, trimming.startPS + consumedDt);
      composition.patchClip(trimming.id, { start: newStart, duration: newDur, playbackStart: newPS });
    }
  }
  function onTrimEnd(ev) {
    if (!trimming) return;
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch {}
    trimming = null;
  }

  // ─── Move ───────────────────────────────────────────────────
  // Pointerdown on a clip body (NOT on a handle) starts a move
  // drag. Horizontal delta retimes; vertical delta swaps lanes.
  // The lane step is the visual lane height + the row gap (h-9
  // is 36, space-y-1 is 4). Time snaps to 2 decimals; lane snaps
  // to whole steps. No ripple — siblings don't budge.
  const LANE_STEP_PX = 40;
  let moving = $state(null);

  function findLaneIndex(clip) {
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i].includes(clip)) return i;
    }
    return 0;
  }

  function onClipPointerDown(ev, clip) {
    if (ev.button !== 0) return;
    if (ev.shiftKey) {
      ev.preventDefault();
      ev.stopPropagation();
      rangeEditor = { clip, anchor: { x: ev.clientX, y: ev.clientY } };
      return;
    }
    ev.stopPropagation();
    // Selection bookkeeping happens here AND on pointer-up: down
    // tentatively selects (so the next move is over the right clip
    // even if no drag happens), up commits. Cmd/Ctrl+click toggles
    // without affecting other selections.
    if (isMultiSelectKey(ev)) {
      const next = new Set(selectedIds);
      if (next.has(clip.id)) next.delete(clip.id);
      else next.add(clip.id);
      selectedIds = next;
    } else if (!selectedIds.has(clip.id)) {
      // Replace selection only if the clip wasn't already selected;
      // otherwise leave the multi-selection intact so a drag can
      // move the whole group later (group-drag is a future feature).
      selectedIds = new Set([clip.id]);
    }
    if (!clip.caps?.canMove) return;
    ev.preventDefault();
    ev.currentTarget.setPointerCapture(ev.pointerId);
    composition.playing = false;
    const frame = document.querySelector("iframe[title='HyperFrames preview']");
    frame?.contentWindow?.postMessage({ type: "pause" }, "*");
    moving = {
      id: clip.id,
      originX: ev.clientX,
      originY: ev.clientY,
      startStart: clip.start,
      startLane: findLaneIndex(clip),
      moved: false,
    };
  }
  function onClipPointerMove(ev) {
    if (!moving) return;
    const dx = ev.clientX - moving.originX;
    const dy = ev.clientY - moving.originY;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2 && !moving.moved) return;
    moving.moved = true;
    const dt = Math.round((dx / layout.pps) * 100) / 100;
    const dlane = Math.round(dy / LANE_STEP_PX);
    const newStart = Math.max(0, +(moving.startStart + dt).toFixed(2));
    const newTrack = Math.max(0, moving.startLane + dlane);
    composition.patchClip(moving.id, { start: newStart, trackIndex: newTrack });
  }
  function onClipPointerUp(ev) {
    if (!moving) return;
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch {}
    moving = null;
  }

  // Click empty timeline area → clear selection. Bound on the lanes
  // wrapper; clip pointer-down stops propagation so this only fires
  // for genuine empty-area clicks.
  function onLanesPointerDown(ev) {
    if (ev.button !== 0) return;
    if (ev.shiftKey || isMultiSelectKey(ev)) return;
    if (selectedIds.size > 0) selectedIds = new Set();
  }

  // Backspace / Delete deletes every selected clip. Skip when focus
  // is in an editable element so the studio's chat / inputs / etc.
  // continue to behave normally.
  function isEditableTarget(target) {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (target.isContentEditable) return true;
    return false;
  }
  function onWindowKeydown(ev) {
    if (ev.key !== "Backspace" && ev.key !== "Delete") return;
    if (selectedIds.size === 0) return;
    if (isEditableTarget(ev.target)) return;
    ev.preventDefault();
    const ids = [...selectedIds];
    selectedIds = new Set();
    for (const id of ids) composition.removeClipById(id);
  }

  $effect(() => {
    window.addEventListener("keydown", onWindowKeydown);
    return () => window.removeEventListener("keydown", onWindowKeydown);
  });
</script>

<style>
  .studio-row {
    background: var(--color-studio-row-bg);
    border: 1px solid var(--color-studio-ruler-border);
    border-radius: 4px;
    overflow: hidden;
  }
  .studio-clip {
    background: var(--color-studio-clip-bg);
    border: 1px solid var(--color-studio-clip-border);
    border-radius: var(--studio-clip-radius);
    box-shadow: var(--color-studio-clip-shadow);
    transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
    /* Clip body owns its own pointerdown for drag-to-move. The
     * track-level scrubber sees pointerdowns landing in row gaps,
     * not on a clip; clips stopPropagation. */
    cursor: grab;
    user-select: none;
  }
  .studio-clip.moving {
    cursor: grabbing;
    background: var(--color-studio-clip-bg-drag);
    border-color: var(--color-studio-clip-border-active);
    box-shadow: var(--color-studio-clip-shadow-drag);
    z-index: 3;
  }
  .studio-row:hover .studio-clip {
    background: var(--color-studio-clip-bg-hover);
    border-color: var(--color-studio-clip-border-hover);
    box-shadow: var(--color-studio-clip-shadow-hover);
  }
  .studio-clip.trimming {
    background: var(--color-studio-clip-bg-active);
    border-color: var(--color-studio-clip-border-active);
    box-shadow: var(--color-studio-clip-shadow-drag);
  }

  /* Edge trim handles. 18px wide gradient overlay on each edge.
   * cursor: col-resize. Reveal opacity on hover/trim so the clip
   * face stays clean at rest. Render above the clip's text so the
   * pointer-events grab works. */
  .trim-handle {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 18px;
    cursor: col-resize;
    opacity: 0;
    transition: opacity 100ms ease;
    z-index: 2;
  }
  .trim-handle-start {
    left: 0;
    background: linear-gradient(90deg,
      color-mix(in srgb, var(--color-studio-accent) 30%, transparent) 0%,
      color-mix(in srgb, var(--color-studio-accent) 13%, transparent) 42%,
      transparent 100%);
  }
  .trim-handle-end {
    right: 0;
    background: linear-gradient(270deg,
      color-mix(in srgb, var(--color-studio-accent) 30%, transparent) 0%,
      color-mix(in srgb, var(--color-studio-accent) 13%, transparent) 42%,
      transparent 100%);
  }
  .studio-clip:hover .trim-handle,
  .studio-clip.trimming .trim-handle {
    opacity: 1;
  }
  .drag-hover {
    box-shadow: inset 0 0 0 2px var(--color-studio-accent);
    background: color-mix(in srgb, var(--color-studio-accent) 4%, transparent);
  }

  /* Role-tinted clip backgrounds. Authors set data-timeline-role
   * on a clip element and the timeline picks a hue. Anything not
   * in this list falls back to the default accent. */
  .studio-clip[data-role="caption"]   { --color-studio-clip-bg: color-mix(in srgb, #38bdf8 18%, transparent); --color-studio-clip-border: color-mix(in srgb, #38bdf8 60%, transparent); }
  .studio-clip[data-role="voiceover"] { --color-studio-clip-bg: color-mix(in srgb, #a78bfa 18%, transparent); --color-studio-clip-border: color-mix(in srgb, #a78bfa 60%, transparent); }
  .studio-clip[data-role="overlay"]   { --color-studio-clip-bg: color-mix(in srgb, #fb7185 18%, transparent); --color-studio-clip-border: color-mix(in srgb, #fb7185 60%, transparent); }
  .studio-clip[data-role="b-roll"]    { --color-studio-clip-bg: color-mix(in srgb, #4ade80 18%, transparent); --color-studio-clip-border: color-mix(in srgb, #4ade80 60%, transparent); }
  .studio-clip[data-role="audio"]     { --color-studio-clip-bg: color-mix(in srgb, #facc15 18%, transparent); --color-studio-clip-border: color-mix(in srgb, #facc15 60%, transparent); }

  /* Selected clip — visual prominence above hover/trim states.
   * Solid accent border + glow so multi-selection reads at a
   * glance. The variant is data-role-aware (the role-coloured
   * background still wins) so a selected b-roll clip stays green
   * but gains the selection border. */
  .studio-clip.selected {
    border-color: var(--color-accent);
    box-shadow:
      inset 0 0 0 1px var(--color-accent),
      0 0 0 1px color-mix(in srgb, var(--color-accent) 60%, transparent),
      0 0 12px color-mix(in srgb, var(--color-accent) 32%, transparent);
    color: var(--color-fg);
  }
  .studio-clip.selected:hover {
    /* Hover doesn't change the selected accent — keeps the cue stable. */
    border-color: var(--color-accent);
  }

  /* Plugin-registered clip action row — only rendered when one
   * clip is selected (see {#if} above). Sits above the clip body
   * with a subtle drop shadow so it reads as its own toolbar. */
  .clip-actions {
    position: absolute;
    top: -22px;
    right: 0;
    display: flex;
    gap: 2px;
    z-index: 5;
    pointer-events: auto;
  }
  .clip-actions button {
    height: 20px; min-width: 20px;
    padding: 0 6px;
    background: var(--color-fg);
    color: white;
    border: 0;
    border-radius: 3px;
    font: 10px var(--font-mono);
    cursor: pointer;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
    transition: opacity 100ms ease;
  }
  .clip-actions button:hover { opacity: 0.85; }
</style>

<RangeEditorPopover
  clip={rangeEditor?.clip}
  anchor={rangeEditor?.anchor}
  onClose={() => rangeEditor = null}
/>

<div class="border-t border-border bg-page h-full flex flex-col select-none min-h-0">
  <!-- Header -->
  <div class="flex items-center justify-between px-4 py-2 border-b border-border flex-shrink-0">
    <h4 class="font-mono text-[10px] uppercase tracking-wider text-fg-muted m-0 font-semibold">
      timeline
      <span class="text-fg-faint normal-case tracking-normal font-normal ml-2">
        {composition.clips.length} clip{composition.clips.length === 1 ? "" : "s"}
        · {lanes.length} lane{lanes.length === 1 ? "" : "s"}
      </span>
    </h4>

    <div class="flex items-center gap-3">
      <span class="font-mono text-[10px] text-fg-faint tabular-nums hidden sm:inline">
        drag to scrub · ←/→ nudge
      </span>
      <!-- Zoom controls -->
      <div class="flex items-center gap-1 font-mono text-[10px]">
        <button
          onclick={() => layout.zoomBy(-1)}
          disabled={layout.pps <= ZOOM_PRESETS[0] * 100 + 1e-3}
          class="h-6 w-6 rounded border border-border bg-surface text-fg-muted hover:text-fg hover:border-border-2 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
          title="Zoom out"
          aria-label="Zoom out"
        >−</button>
        <button
          onclick={() => layout.setZoom(1)}
          class="px-2 h-6 rounded border border-border bg-surface text-fg-muted hover:text-fg hover:border-border-2 cursor-pointer tabular-nums"
          title="Reset zoom"
        >{zoomPct}%</button>
        <button
          onclick={() => layout.zoomBy(+1)}
          disabled={layout.pps >= ZOOM_PRESETS[ZOOM_PRESETS.length - 1] * 100 - 1e-3}
          class="h-6 w-6 rounded border border-border bg-surface text-fg-muted hover:text-fg hover:border-border-2 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
          title="Zoom in"
          aria-label="Zoom in"
        >+</button>
      </div>
    </div>
  </div>

  {#if !hintDismissed}
    <div class="flex items-start gap-2 px-4 py-2 border-b border-border bg-surface text-fg-muted font-mono text-[11px] flex-shrink-0">
      <span class="text-accent mt-0.5">●</span>
      <span class="flex-1 leading-relaxed">
        Drag clips to retime, drag edges to trim, <strong class="text-fg">Shift+click</strong> to edit a range exactly. Trim handles only show on clips Studio can patch safely.
      </span>
      <button
        onclick={dismissHint}
        class="text-fg-faint hover:text-fg cursor-pointer px-1 leading-none"
        aria-label="Dismiss hint"
        title="Dismiss"
      >×</button>
    </div>
  {/if}

  {#if dropFlash}
    <div
      class="absolute right-4 top-2 z-40 px-3 py-1.5 rounded font-mono text-[11px] border shadow-lg"
      class:border-accent={dropFlash.kind === "ok"}
      class:text-accent={dropFlash.kind === "ok"}
      class:bg-surface={dropFlash.kind === "ok"}
      class:border-red-500={dropFlash.kind === "err"}
      class:text-red-300={dropFlash.kind === "err"}
      class:bg-red-950={dropFlash.kind === "err"}
    >
      {dropFlash.text}
    </div>
  {/if}

  <!-- Scrollable timeline body -->
  <div
    class="flex-1 min-h-0 overflow-auto px-4 py-3 relative"
    class:drag-hover={dragHover}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
  >
    <div
      bind:this={trackEl}
      role="slider"
      tabindex="0"
      aria-valuemin="0"
      aria-valuemax={total}
      aria-valuenow={composition.curTime}
      aria-label="Composition scrubber"
      class="relative cursor-col-resize touch-none"
      style="width: {Math.max(trackPxWidth, 1)}px;"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      onpointerleave={onPointerLeave}
      onkeydown={(e) => {
        if (e.key === "ArrowLeft")  { e.preventDefault(); postSeek(Math.max(0, composition.curTime - (e.shiftKey ? 1 : 0.1))); }
        if (e.key === "ArrowRight") { e.preventDefault(); postSeek(Math.min(total, composition.curTime + (e.shiftKey ? 1 : 0.1))); }
      }}
    >
      <!-- Ruler -->
      <div class="relative h-5 mb-1">
        {#each ticks as tk}
          <div
            class="absolute top-0 bottom-0 flex flex-col items-start"
            style="left: {tk.x}px; transform: translateX(-0.5px);"
          >
            <div class="w-px h-2 bg-fg-faint"></div>
            <div class="font-mono text-[9px] text-fg-faint tabular-nums mt-0.5 -translate-x-1/2 whitespace-nowrap">
              {fmtTime(tk.t)}
            </div>
          </div>
        {/each}
      </div>

      <!-- Clip lanes -->
      <div class="relative space-y-1 mt-3" onpointerdown={onLanesPointerDown}>
        {#each lanes as lane, li (li)}
          <div class="studio-row relative h-9">
            {#each lane as c, i (c.id + ":" + i)}
              <div
                title={`${c.id}${c.role ? ` · ${c.role}` : ""}${c.group ? ` · ${c.group}` : ""}\n${c.start.toFixed(2)}s → ${(c.start + c.duration).toFixed(2)}s\n${c.label}\n\nClick to select · Cmd/Ctrl+click to multi-select · Backspace to delete`}
                class="studio-clip absolute top-0.5 bottom-0.5 font-mono text-[11px] leading-7 px-2.5 truncate text-fg"
                class:trimming={trimming?.id === c.id}
                class:moving={moving?.id === c.id}
                class:selected={selectedIds.has(c.id)}
                data-role={c.role || null}
                style="left: {c.start * layout.pps}px; width: {Math.max(2, c.duration * layout.pps)}px;"
                onpointerdown={(ev) => onClipPointerDown(ev, c)}
                onpointermove={onClipPointerMove}
                onpointerup={onClipPointerUp}
                onpointercancel={onClipPointerUp}
              >
                <span class="opacity-60 mr-1 pointer-events-none">{c.id}</span><span class="pointer-events-none">{c.label}</span>

                {#if c.caps?.canTrimStart}
                  <div
                    class="trim-handle trim-handle-start"
                    onpointerdown={(ev) => onTrimStart(ev, c, "start")}
                    onpointermove={onTrimMove}
                    onpointerup={onTrimEnd}
                    onpointercancel={onTrimEnd}
                    aria-label={`Trim start of ${c.id}`}
                    role="slider"
                    tabindex="-1"
                  ></div>
                {/if}
                {#if c.caps?.canTrimEnd}
                  <div
                    class="trim-handle trim-handle-end"
                    onpointerdown={(ev) => onTrimStart(ev, c, "end")}
                    onpointermove={onTrimMove}
                    onpointerup={onTrimEnd}
                    onpointercancel={onTrimEnd}
                    aria-label={`Trim end of ${c.id}`}
                    role="slider"
                    tabindex="-1"
                  ></div>
                {/if}

                <!-- Plugin-registered clip actions. Visible only
                     when exactly ONE clip is selected and that clip
                     is THIS one. Each plugin's `when` predicate
                     filters the action set. Pointer events stop
                     here so the parent's drag/select gesture
                     doesn't fire when clicking an action button. -->
                {#if selectedIds.size === 1 && selectedIds.has(c.id) && timelineClipActions.length > 0}
                  <div class="clip-actions">
                    {#each timelineClipActions as action (action.pluginId + ":" + action.label)}
                      {#if !action.when || action.when(c)}
                        <button
                          type="button"
                          onpointerdown={(ev) => ev.stopPropagation()}
                          onclick={(ev) => {
                            ev.stopPropagation();
                            try {
                              const r = action.onClick(c);
                              if (r && typeof r.then === "function") r.catch((e) => console.warn(`clip action ${action.pluginId}:`, e));
                            } catch (e) { console.warn(`clip action ${action.pluginId}:`, e); }
                          }}
                          title={action.label + " · " + action.pluginId}
                          aria-label={action.label}
                        >{action.icon ?? action.label.slice(0, 2)}</button>
                      {/if}
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/each}
        {#if !composition.clips.length}
          <div class="studio-row h-9 flex items-center justify-center font-mono text-[11px] text-fg-faint">
            no clips · ask the agent to add a scene
          </div>
        {/if}

        <!-- Playhead -->
        <div
          class="absolute top-[-12px] bottom-[-2px] pointer-events-none"
          style="left: {playheadPx}px;"
        >
          <div class="absolute top-0 bottom-0 w-0.5 -translate-x-1/2 bg-accent"
               style="box-shadow: 0 0 8px color-mix(in srgb, var(--color-accent) 70%, transparent);"></div>
          <div class="absolute -top-1.5 left-0 -translate-x-1/2 w-3 h-3 rounded-full bg-accent border-2 border-page"
               style="box-shadow: 0 0 8px color-mix(in srgb, var(--color-accent) 60%, transparent);"></div>
        </div>

        <!-- Hover indicator -->
        {#if hoverX !== null && !dragging}
          <div
            class="absolute top-[-12px] bottom-[-2px] pointer-events-none"
            style="left: {hoverX}px;"
          >
            <div class="absolute top-0 bottom-0 w-px -translate-x-1/2 bg-fg-muted/40"></div>
            <div class="absolute -top-5 -translate-x-1/2 px-1.5 py-0.5 rounded bg-fg text-page font-mono text-[10px] tabular-nums whitespace-nowrap">
              {fmtTimeFine(hoverTime)}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>
