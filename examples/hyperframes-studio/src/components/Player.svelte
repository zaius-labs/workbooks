<script>
  import { onMount, onDestroy } from "svelte";
  import { composition } from "../lib/composition.svelte.js";
  import { layout, ASPECT_PRESETS } from "../lib/layout.svelte.js";
  let frameEl;
  let containerEl;

  // Compute the largest box with the chosen aspect ratio that fits
  // inside the container. Pure-CSS aspect-ratio + max-height/width
  // works in flex parents that have a definite cross-axis size, but
  // our parent's height comes from a flex chain with min-h-0 — that
  // resolves to 0 in some Chromium minor versions, which collapses
  // the canvas. ResizeObserver gives us the actual container box,
  // so we set explicit width/height on the frame and never rely on
  // browser intrinsic-sizing heuristics.
  let frameW = $state(0);
  let frameH = $state(0);

  function recomputeFrame() {
    if (!containerEl) return;
    const { clientWidth: cw, clientHeight: ch } = containerEl;
    if (cw <= 0 || ch <= 0) return;
    const a = ASPECT_PRESETS.find((p) => p.id === layout.aspect) ?? ASPECT_PRESETS[0];
    const ar = a.w / a.h;
    let w = cw, h = cw / ar;
    if (h > ch) { h = ch; w = ch * ar; }
    frameW = Math.floor(w);
    frameH = Math.floor(h);
  }

  function onMessage(ev) {
    if (ev.source !== frameEl?.contentWindow) return;
    const m = ev.data || {};
    if (m.type === "tick") {
      composition.curTime = m.t;
    } else if (m.type === "ended") {
      composition.playing = false;
    } else if (m.type === "ready") {
      composition.curTime = 0;
    }
  }
  let ro;
  onMount(() => {
    window.addEventListener("message", onMessage);
    if (containerEl) {
      recomputeFrame();
      ro = new ResizeObserver(recomputeFrame);
      ro.observe(containerEl);
    }
  });
  onDestroy(() => {
    window.removeEventListener("message", onMessage);
    ro?.disconnect();
  });
  // Re-fit whenever the user picks a new aspect.
  $effect(() => { void layout.aspect; recomputeFrame(); });

  let srcdoc = $derived(composition.html ? composition.buildSrcdoc() : "");

  function send(msg) { frameEl?.contentWindow?.postMessage(msg, "*"); }

  function play() {
    if (composition.playing) {
      composition.playing = false;
      send({ type: "pause" });
    } else {
      composition.playing = true;
      // If we hit the end, the iframe restarts on play.
      send({ type: "play" });
    }
  }
  function restart() {
    composition.curTime = 0;
    composition.playing = false;
    send({ type: "restart" });
  }

  function fmtTime(s) {
    if (!Number.isFinite(s) || s < 0) return "0:00.0";
    const m = Math.floor(s / 60);
    const sec = s - m * 60;
    return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
  }

  // Spacebar = play/pause, R = restart. Only when player area is focused
  // OR when no input/textarea is active.
  function onKey(e) {
    const tag = (document.activeElement?.tagName ?? "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (e.key === " ") { e.preventDefault(); play(); }
    else if (e.key === "r" || e.key === "R") restart();
  }
  onMount(() => window.addEventListener("keydown", onKey));
  onDestroy(() => window.removeEventListener("keydown", onKey));
</script>

<div
  bind:this={containerEl}
  class="relative bg-page p-4 flex items-center justify-center min-h-0 min-w-0 overflow-hidden flex-1"
>
  <!-- Aspect-ratio picker overlay (top-right of preview area). -->
  <div class="absolute top-3 right-3 z-10 flex items-center gap-1 p-1 rounded-lg
              bg-surface/80 backdrop-blur border border-border shadow-lg">
    {#each ASPECT_PRESETS as a}
      <button
        onclick={() => layout.setAspect(a.id)}
        class="font-mono text-[11px] px-2 py-1 rounded cursor-pointer transition-colors"
        class:bg-accent={layout.aspect === a.id}
        class:text-accent-fg={layout.aspect === a.id}
        class:text-fg-muted={layout.aspect !== a.id}
        class:hover:text-fg={layout.aspect !== a.id}
        title={a.hint}
        aria-pressed={layout.aspect === a.id}
      >{a.label}</button>
    {/each}
  </div>

  <div
    class="bg-black border border-border-2 rounded-md overflow-hidden shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
    style="width: {frameW}px; height: {frameH}px;"
  >
    {#key composition.revision}
      <iframe
        bind:this={frameEl}
        srcdoc={srcdoc}
        sandbox="allow-scripts"
        title="HyperFrames preview"
        class="w-full h-full block bg-black"
        referrerpolicy="no-referrer"
      ></iframe>
    {/key}
  </div>
</div>

<div class="flex items-center gap-3 px-4 py-3 border-t border-border">
  <button
    onclick={play}
    class="h-10 w-10 rounded-full flex items-center justify-center cursor-pointer
           border border-accent bg-accent text-accent-fg
           hover:opacity-90 active:scale-95 transition"
    title={composition.playing ? "Pause (space)" : "Play (space)"}
    aria-label={composition.playing ? "Pause" : "Play"}
  >
    {#if composition.playing}
      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="2" y="1" width="3.5" height="12" rx="0.5"/><rect x="8.5" y="1" width="3.5" height="12" rx="0.5"/></svg>
    {:else}
      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M3 1.5 L12 7 L3 12.5 Z"/></svg>
    {/if}
  </button>

  <button
    onclick={restart}
    class="h-9 w-9 rounded-full flex items-center justify-center cursor-pointer
           border border-border bg-surface text-fg
           hover:bg-surface-2 hover:border-border-2 active:scale-95 transition"
    title="Restart (R)"
    aria-label="Restart"
  >
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2 7a5 5 0 1 0 1.46-3.54"/>
      <polyline points="2,2 2,4 4,4"/>
    </svg>
  </button>

  <span class="font-mono text-[13px] text-fg tabular-nums">
    {fmtTime(composition.curTime)}
    <span class="text-fg-faint"> / {fmtTime(composition.totalDuration)}</span>
  </span>

  <span class="flex-1"></span>

  <span class="font-mono text-[11px] text-fg-faint tabular-nums">
    {composition.clips.length} clip{composition.clips.length === 1 ? "" : "s"}
  </span>
</div>
