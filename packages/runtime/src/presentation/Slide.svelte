<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { getPresentationContext } from "./context";

  let {
    class: className = "",
    children,
  }: {
    class?: string;
    children?: import("svelte").Snippet;
  } = $props();

  const api = getPresentationContext();
  const id = Symbol("workbook-slide");
  let index = $state(-1);
  const active = $derived(api.printMode || api.current === index);

  onMount(() => {
    index = api.register(id);
  });

  onDestroy(() => {
    api.unregister(id);
  });
</script>

<section
  class={`workbook-slide ${className}`}
  class:active
  data-slide-index={index}
  aria-hidden={!active}
>
  <div class="workbook-slide-inner">
    {@render children?.()}
  </div>
</section>
