<script lang="ts">
  import type { CodeBlock } from "../types";
  let { block }: { block: CodeBlock } = $props();
</script>

<figure class="flex flex-col gap-1.5">
  <span
    class="self-start rounded-full border border-border bg-surface-soft px-2 py-0.5 text-[10px] uppercase tracking-wider text-fg-muted"
  >
    {block.language || "code"}
  </span>
  <pre
    class="overflow-x-auto rounded-[14px] border border-border bg-surface-soft px-4 py-3 text-[12.5px] leading-snug"
  ><code>{block.text}</code></pre>
</figure>
