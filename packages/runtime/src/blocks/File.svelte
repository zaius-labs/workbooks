<script lang="ts">
  import type { FileBlock } from "../types";
  import { getWorkbookResolver } from "../workbookContext";

  let { block }: { block: FileBlock } = $props();
  const resolver = getWorkbookResolver();

  let downloadUrl = $state<string | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  async function requestDownload() {
    if (downloadUrl || loading) return;
    loading = true;
    error = null;
    try {
      downloadUrl = await resolver.resolveFileUrl(block.fileId);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function fmtSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
</script>

<div
  class="flex items-center gap-3 rounded-[14px] border border-border bg-surface px-4 py-3"
>
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="shrink-0 text-fg-muted"
    aria-hidden="true"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z" />
    <path d="M14 2v6h6" />
  </svg>
  <div class="flex min-w-0 flex-1 flex-col">
    <span class="truncate text-[13.5px] font-medium">{block.name}</span>
    <span class="text-[11.5px] text-fg-muted">
      {block.mimeType} · {fmtSize(block.size)}
    </span>
  </div>
  {#if downloadUrl}
    <a
      href={downloadUrl}
      target="_blank"
      rel="noopener"
      class="rounded-full border border-border bg-surface-soft px-3 py-1.5 text-[12px] font-medium hover:border-border-strong"
    >
      Open
    </a>
  {:else}
    <button
      type="button"
      onclick={requestDownload}
      disabled={loading}
      class="rounded-full border border-border bg-surface-soft px-3 py-1.5 text-[12px] font-medium hover:border-border-strong disabled:opacity-60"
    >
      {loading ? "Signing…" : "Download"}
    </button>
  {/if}
</div>
{#if error}
  <p class="-mt-2 text-[11.5px] text-rose-600">{error}</p>
{/if}
