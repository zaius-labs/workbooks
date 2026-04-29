<script>
  import ChatPanel from "./ChatPanel.svelte";
  import AssetsPanel from "./AssetsPanel.svelte";
  import MCPPanel from "./MCPPanel.svelte";
  import { layout } from "../lib/layout.svelte.js";

  // The active tab is driven from the global header
  // (see App.svelte's <header> nav). This component is just the
  // panel container — all panels stay mounted and inactive ones
  // are CSS-hidden, so chat streaming / asset state / MCP form
  // values survive a tab swap.
</script>

<section class="flex flex-col min-h-0 flex-1">
  <div class="flex-1 flex flex-col min-h-0" class:hidden={layout.leftTab !== "chat"}>
    <ChatPanel />
  </div>
  <div class="flex-1 flex flex-col min-h-0" class:hidden={layout.leftTab !== "assets"}>
    <AssetsPanel />
  </div>
  <div class="flex-1 flex flex-col min-h-0" class:hidden={layout.leftTab !== "mcp"}>
    <MCPPanel />
  </div>
</section>

<style>
  .hidden { display: none !important; }
</style>
