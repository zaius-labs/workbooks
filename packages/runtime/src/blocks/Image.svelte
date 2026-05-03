<script lang="ts">
  import type { ImageBlock } from "../types";
  import { getWorkbookResolver } from "../workbookContext";

  let { block }: { block: ImageBlock } = $props();
  const resolver = getWorkbookResolver();

  // Eagerly resolve on mount — unlike File.svelte (download behind a click), we
  // want the image visible as soon as the block lands in the canvas.
  let src = $state<string | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = await resolver.resolveFileUrl(block.fileId);
        if (!cancelled) src = url;
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
    class="relative overflow-hidden rounded-[14px] border border-border bg-surface-soft"
  >
    {#if src}
      <img
        {src}
        alt={block.alt}
        style:max-height={block.maxHeight ? `${block.maxHeight}px` : undefined}
        class="block h-auto w-full"
        loading="lazy"
      />
    {:else if error}
      <div
        class="flex min-h-[180px] items-center justify-center p-4 text-center text-[12px] text-rose-700"
      >
        Image failed to load: {error}
      </div>
    {:else}
      <div
        class="flex min-h-[180px] animate-pulse items-center justify-center p-4 text-[11px] text-fg-subtle"
      >
        Loading image…
      </div>
    {/if}
  </div>
  {#if block.caption}
    <figcaption class="text-[12.5px] text-fg-muted">
      {block.caption}
    </figcaption>
  {/if}
</figure>
