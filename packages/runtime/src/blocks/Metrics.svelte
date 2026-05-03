<script lang="ts">
  import type { MetricGroupBlock } from "../types";
  import Metric from "./Metric.svelte";

  let { block }: { block: MetricGroupBlock } = $props();
</script>

<div class="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
  {#each block.metrics as m, i (i)}
    <Metric block={{ kind: "metric", ...m }} />
  {/each}
</div>
