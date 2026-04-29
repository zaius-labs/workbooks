<script lang="ts">
  import type { VideoBlock } from "../types";
  import { getWorkbookResolver } from "../workbookContext";

  let { block }: { block: VideoBlock } = $props();
  const resolver = getWorkbookResolver();

  let src = $state<string | null>(null);
  let poster = $state<string | null>(null);
  let error = $state<string | null>(null);

  // Resolve both the video and (if present) the poster frame in parallel.
  $effect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [videoUrl, posterUrl] = await Promise.all([
          resolver.resolveFileUrl(block.fileId),
          block.posterFileId
            ? resolver.resolveFileUrl(block.posterFileId)
            : Promise.resolve(null),
        ]);
        if (cancelled) return;
        src = videoUrl;
        if (posterUrl) poster = posterUrl;
      } catch (e) {
        if (!cancelled) error = e instanceof Error ? e.message : String(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  });
</script>

<figure class="flex flex-col gap-2">
  <div
    class="relative overflow-hidden rounded-[14px] border border-border bg-black/90"
  >
    {#if src}
      <!-- Autoplay requires muted per browser policy. `playsinline` keeps
           mobile from going fullscreen. `preload="metadata"` avoids fetching
           full bytes on page load — click-to-play is the common path. -->
      <video
        {src}
        poster={poster ?? undefined}
        controls
        playsinline
        muted={block.autoplay}
        autoplay={block.autoplay}
        preload="metadata"
        class="block h-auto w-full"
      >
        <track kind="captions" />
      </video>
    {:else if error}
      <div
        class="flex min-h-[180px] items-center justify-center p-4 text-center text-[12px] text-rose-700 dark:text-rose-300"
      >
        Video failed to load: {error}
      </div>
    {:else}
      <div
        class="flex min-h-[180px] animate-pulse items-center justify-center p-4 text-[11px] text-fg-subtle"
      >
        Loading video…
      </div>
    {/if}
  </div>
  {#if block.caption}
    <figcaption class="text-[12.5px] text-fg-muted">
      {block.caption}
    </figcaption>
  {/if}
</figure>
