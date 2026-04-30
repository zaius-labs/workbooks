<script>
  import LeftPanel from "./components/LeftPanel.svelte";
  import Player from "./components/Player.svelte";
  import Timeline from "./components/Timeline.svelte";
  import SettingsModal from "./components/SettingsModal.svelte";
  import RenderModal from "./components/RenderModal.svelte";
  import Splitter from "./components/Splitter.svelte";
  import { env } from "./lib/env.svelte.js";
  import { layout } from "./lib/layout.svelte.js";
  import { assets } from "./lib/assets.svelte.js";
  import { agent } from "./lib/agent.svelte.js";
  import { mcpBridge, isMcpMode } from "./lib/mcpBridge.svelte.js";
  import { exportProject } from "./lib/exportProject.js";
  // Persistence is the workbook runtime's job — Cmd+S is handled by
  // the SDK's save handler (it serializes <wb-doc> state into the
  // .workbook.html file with its own toast). Nothing to wire here.

  let settingsOpen = $state(false);
  let renderOpen = $state(false);
  let packaging = $state(false);
  let packageStatus = $state("");

  async function onPackage() {
    if (packaging) return;
    packaging = true;
    packageStatus = "packaging…";
    const r = await exportProject();
    if (r.ok) {
      packageStatus = `${r.assetCount} asset${r.assetCount === 1 ? "" : "s"} · ${r.filename}`;
      setTimeout(() => { packageStatus = ""; }, 3000);
    } else {
      packageStatus = `error: ${r.error}`;
      setTimeout(() => { packageStatus = ""; }, 5000);
    }
    packaging = false;
  }
  // Mount the MCP global on first paint so an external host can
  // introspect tools immediately. Idempotent if called twice.
  mcpBridge.mount();

  // When the page is opened with #mcp the external host is in
  // charge — chat UI is irrelevant. Force the left tab to MCP so
  // the human watching sees activity instead of the chat.
  const mcpMode = isMcpMode();
  if (mcpMode && layout.leftTab === "chat") layout.setLeftTab("mcp");

  $effect(() => {
    // Don't nudge the settings modal in MCP mode — the external
    // host owns the conversation, and pushing a key dialog over
    // the live activity log just gets in the way.
    if (mcpMode) return;
    if (!env.satisfied && !sessionStorage.getItem("hf.settings.nudged")) {
      sessionStorage.setItem("hf.settings.nudged", "1");
      settingsOpen = true;
    }
  });

  // Re-clamp persisted sizes on viewport resize so a window dragged
  // smaller doesn't leave the chat column wider than the screen.
  $effect(() => {
    const onResize = () => {
      layout.setChatWidth(layout.chatWidth);
      layout.setTimelineHeight(layout.timelineHeight);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });
</script>

<div class="grid h-screen min-h-0 grid-rows-[44px_minmax(0,1fr)]">
  <header class="flex items-stretch gap-1 px-2 border-b border-border bg-page">
    <!-- Workspace tabs — drive which panel renders on the left. Live
         in the global header so they read as primary navigation, not
         as in-column controls. The chat tab is hidden in MCP mode
         (#mcp) since an external host is driving the workbook. -->
    {#if !mcpMode}
      <button
        onclick={() => layout.setLeftTab("chat")}
        class="nav-tab"
        class:active={layout.leftTab === "chat"}
        aria-pressed={layout.leftTab === "chat"}
        title="Chat with the agent"
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 3.5h10v6H8l-2.5 2v-2H2z"/>
        </svg>
        <span>chat</span>
        {#if agent.busy}<span class="nav-dot" aria-label="agent busy"></span>{/if}
      </button>
    {/if}
    <button
      onclick={() => layout.setLeftTab("assets")}
      class="nav-tab"
      class:active={layout.leftTab === "assets"}
      aria-pressed={layout.leftTab === "assets"}
      title="Asset library"
    >
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2 2 H8 L9.5 4 H12 V11.5 H2 Z"/>
      </svg>
      <span>assets</span>
      {#if assets.items.length > 0}
        <span class="nav-count">{assets.items.length}</span>
      {/if}
    </button>
    <button
      onclick={() => layout.setLeftTab("mcp")}
      class="nav-tab"
      class:active={layout.leftTab === "mcp"}
      aria-pressed={layout.leftTab === "mcp"}
      title="Expose this workbook as an MCP server"
    >
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="3" width="10" height="8" rx="1.2"/>
        <path d="M5 6.5h4M5 8.5h2.5"/>
      </svg>
      <span>mcp</span>
    </button>
    <button
      onclick={() => layout.setLeftTab("history")}
      class="nav-tab"
      class:active={layout.leftTab === "history"}
      aria-pressed={layout.leftTab === "history"}
      title="Edit log — Prolly Tree commit chain"
    >
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="7" cy="3" r="1.2"/>
        <circle cx="7" cy="7" r="1.2"/>
        <circle cx="7" cy="11" r="1.2"/>
        <path d="M7 4.2 L7 5.8"/>
        <path d="M7 8.2 L7 9.8"/>
      </svg>
      <span>history</span>
    </button>

    <span class="flex-1"></span>

    <span class="font-mono text-[11px] tabular-nums px-2 py-0.5 rounded-full border self-center mr-1"
          class:text-accent={env.satisfied}
          class:border-accent={env.satisfied}
          class:text-fg-muted={!env.satisfied}
          class:border-border={!env.satisfied}
          title={env.satisfied ? `Model: ${env.model}` : "No API key — open settings"}>
      {env.satisfied ? "● connected" : "○ no key"}
    </span>

    <!-- Autosave indicator removed — Cmd+S is handled by the SDK
         save handler now (with its own toast); state lives in the
         <wb-doc> element inside the .workbook.html file rather than
         a debounced IDB write. -->


    <!-- Package · download project as .workbook.zip with extracted assets -->
    <button
      onclick={onPackage}
      disabled={packaging}
      class="h-8 px-2.5 rounded flex items-center gap-1.5 self-center
             border border-border bg-surface text-fg-muted
             hover:text-fg hover:border-border-2 hover:bg-surface-2 cursor-pointer transition
             disabled:opacity-50 disabled:cursor-wait
             font-mono text-[11px]"
      title="Download project as .workbook.zip (composition + assets, content-addressed)"
      aria-label="Package and download"
    >
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2.5 4.5 L7 2 L11.5 4.5 L11.5 9.5 L7 12 L2.5 9.5 Z"/>
        <path d="M2.5 4.5 L7 7 L11.5 4.5"/>
        <path d="M7 7 L7 12"/>
      </svg>
      {packaging ? "packaging…" : "package"}
    </button>
    {#if packageStatus}
      <span class="font-mono text-[10px] text-fg-faint self-center max-w-[200px] truncate" title={packageStatus}>
        {packageStatus}
      </span>
    {/if}

    <!-- Render · primary CTA, accent-coloured -->
    <button
      onclick={() => renderOpen = true}
      class="h-8 px-3 rounded flex items-center gap-1.5 self-center
             border border-accent bg-accent text-accent-fg
             hover:opacity-90 cursor-pointer transition
             font-mono text-[11px] font-semibold"
      title="Render composition to video"
      aria-label="Render"
    >
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <rect x="1.5" y="2" width="10" height="9" rx="1.5"/>
        <path d="M5.5 4.5 L8.5 6.5 L5.5 8.5 Z" fill="currentColor"/>
      </svg>
      render
    </button>

    <!-- Settings · proper gear (replaces the sun-shaped placeholder) -->
    <button
      onclick={() => settingsOpen = true}
      class="h-8 w-8 rounded flex items-center justify-center self-center
             border border-border bg-surface text-fg-muted
             hover:text-fg hover:border-border-2 hover:bg-surface-2 cursor-pointer transition"
      title="AI settings"
      aria-label="Open settings"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    </button>
  </header>

  <div class="flex min-h-0 min-w-0">
    <!-- Left: chat. Fixed-width column, the splitter to its right
         resizes it. flex-shrink: 0 so it never gets squashed below
         min by accident. -->
    <div class="flex flex-col min-h-0 border-r border-border"
         style="width: {layout.chatWidth}px; flex-shrink: 0;">
      <LeftPanel />
    </div>

    <Splitter
      axis="vertical"
      label="Resize chat panel"
      onDrag={(dx) => layout.setChatWidth(layout.chatWidth + dx)}
    />

    <!-- Right: stage. Fills remaining width. Player flexes; timeline
         is a fixed-height row at the bottom whose height the second
         splitter resizes. -->
    <section class="flex flex-col min-h-0 min-w-0 flex-1 bg-page">
      <div class="flex-1 flex flex-col min-h-0 min-w-0">
        <Player />
      </div>

      <Splitter
        axis="horizontal"
        label="Resize timeline"
        onDrag={(dy) => layout.setTimelineHeight(layout.timelineHeight - dy)}
      />

      <div class="flex flex-col min-h-0"
           style="height: {layout.timelineHeight}px; flex-shrink: 0;">
        <Timeline />
      </div>
    </section>
  </div>
</div>

<SettingsModal bind:open={settingsOpen} />
<RenderModal bind:open={renderOpen} />

<style>
  .nav-tab {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 0 12px;
    background: transparent;
    border: 0;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-fg-muted);
    transition: color 120ms ease, border-color 120ms ease;
    white-space: nowrap;
    /* Pull the underline flush to the header's bottom border so the
     * active tab visually merges with the panel beneath it. */
    margin-bottom: -1px;
  }
  .nav-tab:hover { color: var(--color-fg); }
  .nav-tab.active {
    color: var(--color-fg);
    border-bottom-color: var(--color-accent);
  }
  .nav-count {
    display: inline-block;
    padding: 0 6px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-accent) 22%, transparent);
    color: var(--color-accent);
    font-feature-settings: "tnum";
    font-size: 10px;
  }
  .nav-dot {
    width: 6px; height: 6px; border-radius: 999px;
    background: var(--color-accent);
    animation: nav-pulse 1.2s ease-in-out infinite;
  }
  @keyframes nav-pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.35; }
  }
</style>
