<script>
  import { composition } from "../lib/composition.svelte.js";
  import { layout, ASPECT_PRESETS } from "../lib/layout.svelte.js";
  import { renderComposition, downloadBlob, downloadAsHtml, hasWebCodecs } from "../lib/render.js";

  let { open = $bindable(false) } = $props();

  let dialogEl;
  let phase = $state("idle"); // idle | loading-rasterizer | mounting-iframe | recording | finalizing | done | error
  let progress = $state({ frame: 0, totalFrames: 0, percent: 0 });
  let resultBlob = $state(null);
  let resultUrl = $state(null);
  let errorMsg = $state("");
  let abortCtrl = null;

  // Resolution: pick from the active aspect's preset by default.
  let activePreset = $derived(
    ASPECT_PRESETS.find((p) => p.id === layout.aspect) ?? ASPECT_PRESETS[0]
  );
  let width = $state(0);
  let height = $state(0);
  let fps = $state(30);

  // Sync resolution to the current aspect when the modal opens, but
  // let the user override after.
  $effect(() => {
    if (!open) return;
    width  = activePreset.render.w;
    height = activePreset.render.h;
  });

  $effect(() => {
    if (!dialogEl) return;
    if (open && !dialogEl.open) {
      reset();
      dialogEl.showModal();
    }
    if (!open && dialogEl.open) dialogEl.close();
  });

  function reset() {
    phase = "idle";
    progress = { frame: 0, totalFrames: 0, percent: 0 };
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultBlob = null;
    resultUrl = null;
    errorMsg = "";
    abortCtrl = null;
  }

  function close() {
    if (phase === "recording" || phase === "loading-rasterizer" || phase === "mounting-iframe") {
      // Don't dismiss mid-render — cancel first.
      cancel();
      return;
    }
    open = false;
  }

  function cancel() {
    abortCtrl?.abort();
  }

  async function startRender() {
    reset();
    abortCtrl = new AbortController();
    phase = "loading-rasterizer";
    try {
      const blob = await renderComposition({
        width, height, fps,
        signal: abortCtrl.signal,
        onPhase: (p) => { phase = p; },
        onProgress: (p) => { progress = p; },
      });
      resultBlob = blob;
      resultUrl = URL.createObjectURL(blob);
      phase = "done";
    } catch (e) {
      if (abortCtrl?.signal.aborted) {
        phase = "idle";
      } else {
        errorMsg = e?.message ?? String(e);
        phase = "error";
      }
    }
  }

  function saveResult() {
    if (!resultBlob) return;
    const aspect = layout.aspect.replace(":", "x");
    downloadBlob(resultBlob, `hyperframes-${aspect}-${width}x${height}-${fps}fps-${Date.now()}.webm`);
  }

  let durationLabel = $derived(`${composition.totalDuration.toFixed(1)}s`);
  let frameCount = $derived(Math.max(1, Math.ceil(composition.totalDuration * fps)));
  let etaLabel = $derived.by(() => {
    // Render speed depends on rasterization cost. Empirically html2canvas
    // is ~50–150ms per frame at 1080p. Estimate at 100ms/frame.
    const ms = frameCount * 100;
    if (ms < 60000) return `~${Math.round(ms / 1000)}s`;
    return `~${Math.round(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  });

  let phaseLabel = $derived(({
    "idle":               "ready",
    "loading-rasterizer": "loading rasterizer…",
    "mounting-iframe":    "preparing render stage…",
    "recording":          "rendering frames",
    "finalizing":         "finalizing webm…",
    "done":               "done",
    "error":              "error",
  })[phase] ?? phase);

  function onKey(e) { if (e.key === "Escape") close(); }
</script>

<dialog
  bind:this={dialogEl}
  onclose={() => { open = false; reset(); }}
  onkeydown={onKey}
  class="bg-surface text-fg rounded-lg border border-border shadow-2xl
         backdrop:bg-black/60 backdrop:backdrop-blur-sm
         w-[min(560px,calc(100vw-32px))] p-0"
>
  <div class="flex items-center justify-between px-5 py-3 border-b border-border">
    <div class="flex items-center gap-2">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="text-accent">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/>
        <path d="M6.5 5.5 L10.5 8 L6.5 10.5 Z" fill="currentColor"/>
      </svg>
      <h3 class="font-mono text-[12px] uppercase tracking-wider text-fg-muted m-0 font-semibold">
        render composition
      </h3>
    </div>
    <button
      onclick={close}
      class="text-fg-muted hover:text-fg cursor-pointer text-base leading-none bg-transparent border-0 p-1"
      aria-label="Close"
    >×</button>
  </div>

  <div class="p-5 space-y-5">
    {#if phase === "idle" || phase === "error"}
      <!-- Aspect / resolution row -->
      <div class="space-y-2">
        <label class="block font-mono text-[11px] uppercase tracking-wider text-fg-muted">
          aspect ratio
        </label>
        <div class="flex flex-wrap gap-2">
          {#each ASPECT_PRESETS as a}
            <button
              onclick={() => { layout.setAspect(a.id); width = a.render.w; height = a.render.h; }}
              class="font-mono text-[11px] px-3 py-1.5 rounded border cursor-pointer transition-colors"
              class:bg-accent={layout.aspect === a.id}
              class:text-accent-fg={layout.aspect === a.id}
              class:border-accent={layout.aspect === a.id}
              class:text-fg-muted={layout.aspect !== a.id}
              class:border-border={layout.aspect !== a.id}
              class:hover:text-fg={layout.aspect !== a.id}
              class:hover:bg-page={layout.aspect !== a.id}
              title={a.hint}
            >{a.label} · {a.render.w}×{a.render.h}</button>
          {/each}
        </div>
      </div>

      <!-- Resolution + FPS -->
      <div class="grid grid-cols-3 gap-3">
        <label class="space-y-1">
          <span class="block font-mono text-[10px] uppercase tracking-wider text-fg-muted">width</span>
          <input
            type="number" min="240" max="3840" step="2"
            value={width}
            oninput={(e) => width = +e.currentTarget.value}
            class="w-full bg-page border border-border rounded px-2 py-1.5 font-mono text-[12px] text-fg
                   focus:outline-1 focus:outline-accent focus:border-accent"
          />
        </label>
        <label class="space-y-1">
          <span class="block font-mono text-[10px] uppercase tracking-wider text-fg-muted">height</span>
          <input
            type="number" min="240" max="3840" step="2"
            value={height}
            oninput={(e) => height = +e.currentTarget.value}
            class="w-full bg-page border border-border rounded px-2 py-1.5 font-mono text-[12px] text-fg
                   focus:outline-1 focus:outline-accent focus:border-accent"
          />
        </label>
        <label class="space-y-1">
          <span class="block font-mono text-[10px] uppercase tracking-wider text-fg-muted">fps</span>
          <select
            value={fps}
            onchange={(e) => fps = +e.currentTarget.value}
            class="w-full bg-page border border-border rounded px-2 py-1.5 font-mono text-[12px] text-fg
                   focus:outline-1 focus:outline-accent focus:border-accent cursor-pointer"
          >
            <option value={24}>24</option>
            <option value={30}>30</option>
            <option value={60}>60</option>
          </select>
        </label>
      </div>

      <div class="font-mono text-[11px] text-fg-faint flex items-center justify-between border-t border-border pt-3">
        <span>{frameCount} frames · {durationLabel} · ~{etaLabel} render time</span>
        <span class:text-accent={hasWebCodecs()} class:text-amber-400={!hasWebCodecs()}>
          {hasWebCodecs() ? "WebM · VP9 · WebCodecs" : "WebM · VP8 · MediaRecorder"}
        </span>
      </div>

      {#if !hasWebCodecs()}
        <div class="font-mono text-[10px] text-amber-400 border border-amber-900 bg-amber-950/30 px-3 py-2 rounded leading-relaxed">
          ⚠ This browser is missing WebCodecs. Falling back to MediaRecorder, which records in wall-clock time — slow rasterization will stretch the output duration. For frame-accurate output, use Chrome/Edge 94+ or Safari 16.4+.
        </div>
      {/if}

      {#if phase === "error"}
        <div class="font-mono text-[11px] text-red-300 border border-red-900 bg-red-950/40 px-3 py-2 rounded leading-relaxed">
          {errorMsg}
        </div>
      {/if}
    {:else if phase === "done"}
      <!-- Result preview -->
      <video src={resultUrl} controls autoplay loop class="w-full rounded border border-border bg-black"></video>
      <div class="font-mono text-[11px] text-fg-faint flex items-center justify-between">
        <span>{width}×{height} · {fps}fps · {(resultBlob.size / 1024 / 1024).toFixed(1)} MB</span>
        <button
          onclick={reset}
          class="text-fg-muted hover:text-fg cursor-pointer underline underline-offset-2"
        >render again</button>
      </div>
    {:else}
      <!-- Render progress -->
      <div class="space-y-3">
        <div class="font-mono text-[12px] text-fg flex items-center gap-2">
          <span class="inline-block h-2 w-2 rounded-full bg-accent animate-pulse"></span>
          {phaseLabel}
        </div>
        <div class="h-2 rounded-full bg-page border border-border overflow-hidden">
          <div
            class="h-full bg-accent transition-[width] duration-100"
            style="width: {progress.percent}%;"
          ></div>
        </div>
        <div class="font-mono text-[11px] text-fg-faint flex items-center justify-between">
          <span>frame {progress.frame} / {progress.totalFrames || frameCount}</span>
          <span class="tabular-nums">{progress.percent.toFixed(1)}%</span>
        </div>
      </div>
    {/if}

    <!-- Footer actions -->
    <div class="flex items-center justify-between pt-3 border-t border-border">
      <button
        onclick={downloadAsHtml}
        class="font-mono text-[11px] text-fg-muted hover:text-fg cursor-pointer underline underline-offset-2"
        title="Skip the renderer — save the composition as a standalone HTML file you can render with HyperFrames CLI"
      >or download .html ↓</button>

      <div class="flex gap-2">
        {#if phase === "idle" || phase === "error"}
          <button
            onclick={close}
            class="px-3 py-1.5 rounded border border-border bg-page text-fg-muted hover:text-fg hover:border-border-2 cursor-pointer font-mono text-[12px]"
          >cancel</button>
          <button
            onclick={startRender}
            class="px-3 py-1.5 rounded border border-accent bg-accent text-accent-fg font-mono text-[12px] font-semibold hover:opacity-90 cursor-pointer"
          >start render</button>
        {:else if phase === "done"}
          <button
            onclick={close}
            class="px-3 py-1.5 rounded border border-border bg-page text-fg-muted hover:text-fg hover:border-border-2 cursor-pointer font-mono text-[12px]"
          >done</button>
          <button
            onclick={saveResult}
            class="px-3 py-1.5 rounded border border-accent bg-accent text-accent-fg font-mono text-[12px] font-semibold hover:opacity-90 cursor-pointer"
          >save .webm</button>
        {:else}
          <button
            onclick={cancel}
            class="px-3 py-1.5 rounded border border-border bg-page text-fg-muted hover:text-fg hover:border-border-2 cursor-pointer font-mono text-[12px]"
          >cancel render</button>
        {/if}
      </div>
    </div>
  </div>
</dialog>

<style>
  dialog { margin: auto; max-height: calc(100vh - 32px); overflow: visible; }
  dialog:not([open]) { display: none !important; }
</style>
