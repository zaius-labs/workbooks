<script>
  import { assets, fmtBytes } from "../lib/assets.svelte.js";
  import { composition } from "../lib/composition.svelte.js";

  let inputEl;
  let dragHover = $state(false);
  let importing = $state(false);
  let errors = $state([]);
  let lastAdded = $state([]);

  async function importFiles(files) {
    if (!files?.length) return;
    importing = true;
    errors = [];
    try {
      const result = await assets.addFromFiles(files);
      lastAdded = result.added.map((a) => a.id);
      errors = result.errors;
      // Clear pulse highlight after a beat.
      setTimeout(() => { lastAdded = []; }, 1200);
    } finally {
      importing = false;
    }
  }

  function onPick(ev) {
    importFiles(ev.currentTarget.files);
    ev.currentTarget.value = "";
  }
  function onDrop(ev) {
    ev.preventDefault();
    dragHover = false;
    importFiles(ev.dataTransfer?.files ?? []);
  }
  function onDragOver(ev) {
    if (!ev.dataTransfer) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
    dragHover = true;
  }
  function onDragLeave() { dragHover = false; }

  // URL import — paste an image/video/audio URL (Google Drive,
  // S3, anywhere). Asset is flagged `linked: true` so the recipient's
  // browser fetches at playback rather than carrying the bytes inline.
  let urlInput = $state("");
  let urlBusy = $state(false);
  let urlError = $state("");
  async function onAddUrl() {
    const u = urlInput.trim();
    if (!u) return;
    urlBusy = true;
    urlError = "";
    try {
      const item = await assets.addFromUrl(u);
      lastAdded = [item.id];
      urlInput = "";
      setTimeout(() => { lastAdded = []; }, 1200);
    } catch (e) {
      urlError = e?.message ?? String(e);
    } finally {
      urlBusy = false;
    }
  }
  function onUrlKey(ev) {
    if (ev.key === "Enter") onAddUrl();
  }

  function insertOnTimeline(asset) {
    const dur = asset.duration ?? 3;
    composition.addMediaClip({
      kind: asset.kind === "image" || asset.kind === "svg" ? "img" : asset.kind,
      src: asset.dataUrl,
      start: composition.totalDuration,
      duration: dur,
      trackIndex: asset.kind === "audio" ? 2 : 1,
      label: asset.name,
    });
  }
  function copyDataUrl(asset) {
    navigator.clipboard?.writeText(asset.dataUrl).catch(() => {});
  }
  function startDragAsset(ev, asset) {
    if (!ev.dataTransfer) return;
    ev.dataTransfer.setData("application/x-hyperframes-asset", JSON.stringify({ id: asset.id, name: asset.name, kind: asset.kind }));
    ev.dataTransfer.setData("text/plain", asset.dataUrl);
    ev.dataTransfer.effectAllowed = "copy";
  }
</script>

<section class="flex flex-col min-h-0 flex-1">
  <!-- Library body — drop target spans the whole scrollable region. -->
  <div
    class="flex-1 min-h-0 overflow-y-auto px-4 py-3"
    class:drag-target={dragHover}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
  >
    {#if assets.items.length === 0}
      <button
        onclick={() => inputEl?.click()}
        class="w-full h-full min-h-[220px] rounded-lg border-2 border-dashed border-border flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-accent hover:bg-page transition-colors"
        class:border-accent={dragHover}
        class:bg-page={dragHover}
      >
        <svg width="28" height="28" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" class="text-fg-faint">
          <path d="M16 22 V8"/>
          <path d="M10 14 L16 8 L22 14"/>
          <path d="M4 22 V26 H28 V22"/>
        </svg>
        <div class="text-center space-y-0.5">
          <div class="font-mono text-[12px] text-fg">drop files here</div>
          <div class="font-mono text-[10px] text-fg-faint">image · video · audio · svg · 50 MB max</div>
        </div>
      </button>
    {:else}
      <div class="grid grid-cols-2 gap-2.5">
        {#each assets.items as a (a.id)}
          <div
            class="asset-card group relative bg-page border border-border rounded-md overflow-hidden flex flex-col"
            class:just-added={lastAdded.includes(a.id)}
            draggable="true"
            ondragstart={(ev) => startDragAsset(ev, a)}
          >
            <div class="aspect-video bg-black flex items-center justify-center overflow-hidden border-b border-border">
              {#if a.kind === "image" || a.kind === "svg"}
                <img src={a.dataUrl} alt={a.name} class="max-w-full max-h-full object-contain" />
              {:else if a.kind === "video"}
                <video src={a.dataUrl} class="max-w-full max-h-full object-contain" muted preload="metadata"></video>
              {:else if a.kind === "audio"}
                <div class="text-fg-faint flex flex-col items-center gap-1">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4">
                    <path d="M3 9 L8 9 L13 4 V20 L8 15 L3 15 Z" fill="currentColor"/>
                  </svg>
                  <span class="font-mono text-[10px]">audio</span>
                </div>
              {/if}
            </div>
            <div class="p-2 flex flex-col gap-1 flex-1">
              <div class="font-mono text-[11px] text-fg truncate" title={a.name}>{a.name}</div>
              <div class="font-mono text-[10px] text-fg-faint flex items-center justify-between">
                <span>
                  {a.kind}{#if a.linked} · linked{:else} · {fmtBytes(a.size)}{/if}
                </span>
                {#if a.duration}<span class="tabular-nums">{a.duration.toFixed(1)}s</span>{/if}
              </div>
              <div class="flex gap-1 mt-auto pt-1.5">
                <button
                  onclick={() => insertOnTimeline(a)}
                  class="flex-1 h-6 rounded border border-accent bg-accent text-accent-fg font-mono text-[10px] font-semibold hover:opacity-90 cursor-pointer"
                  title="Add to timeline at end"
                >insert</button>
                <button
                  onclick={() => copyDataUrl(a)}
                  class="h-6 px-1.5 rounded border border-border bg-surface text-fg-muted hover:text-fg hover:border-border-2 font-mono text-[10px] cursor-pointer"
                  title="Copy data URL"
                >copy</button>
                <button
                  onclick={() => assets.remove(a.id)}
                  class="h-6 px-1.5 rounded border border-border bg-surface text-fg-muted hover:text-red-300 hover:border-red-900 font-mono text-[10px] cursor-pointer"
                  title="Remove"
                >×</button>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    {#if errors.length}
      <div class="mt-3 font-mono text-[11px] text-amber-300 border border-amber-900 bg-amber-950/30 px-3 py-2 rounded leading-relaxed">
        <div class="font-semibold mb-1">Skipped:</div>
        {#each errors as e}<div>· {e}</div>{/each}
      </div>
    {/if}
  </div>

  <!-- Footer: persistent action bar at the bottom of the panel.
       Two routes for adding assets:
         1. + add files: drag-and-drop or pick local files (embedded
            as base64 — cheap to author, large in saved file).
         2. URL: paste any http(s) image/video/audio URL — linked
            external (cheap saved file, depends on URL availability). -->
  <div class="border-t border-border px-4 py-2.5 flex flex-col gap-2 flex-shrink-0">
    <div class="flex items-center gap-2">
      <input
        type="text"
        bind:value={urlInput}
        placeholder="paste an image / video / audio URL"
        onkeydown={onUrlKey}
        disabled={urlBusy}
        class="flex-1 h-7 px-2 rounded border border-border bg-page text-fg font-mono text-[11px] outline-none focus:border-accent placeholder:text-fg-faint"
      />
      <button
        onclick={onAddUrl}
        disabled={urlBusy || !urlInput.trim()}
        class="px-2.5 h-7 rounded font-mono text-[11px] border border-border bg-surface text-fg-muted hover:text-fg hover:border-border-2 cursor-pointer disabled:opacity-40"
        title="Add a URL-linked asset (Google Drive, S3, anywhere). Bytes never load into the studio; the artifact fetches them at playback."
      >
        {urlBusy ? "linking…" : "link"}
      </button>
    </div>
    {#if urlError}
      <div class="font-mono text-[10px] text-red-300">{urlError}</div>
    {/if}
    <div class="flex items-center justify-between gap-2">
      <span class="font-mono text-[10px] text-fg-faint">
        files = embedded · URL = linked
      </span>
      <input
        bind:this={inputEl}
        type="file"
        multiple
        accept="image/*,video/*,audio/*,.svg"
        onchange={onPick}
        class="hidden"
      />
      <button
        onclick={() => inputEl?.click()}
        disabled={importing}
        class="px-3 h-7 rounded font-mono text-[11px] font-semibold border border-accent bg-accent text-accent-fg hover:opacity-90 cursor-pointer disabled:opacity-50"
      >
        {importing ? "importing…" : "+ add files"}
      </button>
    </div>
  </div>
</section>

<style>
  .drag-target {
    outline: 2px solid var(--color-accent);
    outline-offset: -8px;
    border-radius: 8px;
  }
  .asset-card.just-added {
    animation: pulse-in 1s ease-out;
  }
  @keyframes pulse-in {
    0%   { box-shadow: 0 0 0 0 var(--color-accent); }
    50%  { box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-accent) 40%, transparent); }
    100% { box-shadow: 0 0 0 0 transparent; }
  }
</style>
