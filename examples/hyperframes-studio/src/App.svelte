<script>
  import LeftPanel from "./components/LeftPanel.svelte";
  import Player from "./components/Player.svelte";
  import Timeline from "./components/Timeline.svelte";
  import SettingsModal from "./components/SettingsModal.svelte";
  import RenderModal from "./components/RenderModal.svelte";
  import Splitter from "./components/Splitter.svelte";
  import MenuBar from "./components/MenuBar.svelte";
  import PluginManager from "./components/PluginManager.svelte";
  import SkillManager from "./components/SkillManager.svelte";
  import { env } from "./lib/env.svelte.js";
  import { layout } from "./lib/layout.svelte.js";
  import { mcpBridge, isMcpMode } from "./lib/mcpBridge.svelte.js";
  import { exportProject } from "./lib/exportProject.js";
  import { newProject, openProject, exportHyperframeHtml } from "./lib/projectIO.js";
  // Persistence is the workbook runtime's job — Cmd+S is handled by
  // the SDK's save handler (it serializes <wb-doc> state into the
  // .workbook.html file with its own toast). Nothing to wire here.

  let settingsOpen = $state(false);
  let renderOpen = $state(false);
  let pluginsOpen = $state(false);
  let skillsOpen = $state(false);
  let packaging = $state(false);
  let packageStatus = $state("");

  // Hidden file input drives File > Open Project. Click is triggered
  // programmatically from the menu; the input captures the chosen
  // file and routes through projectIO.openProject which handles both
  // hyperframe.html and .workbook.html shapes.
  let openFileInput;

  async function onNewProject() {
    if (!confirm("Start a new project? Unsaved changes in the current composition will be lost.")) return;
    await newProject();
    packageStatus = "new project ready";
    setTimeout(() => { packageStatus = ""; }, 2000);
  }

  function onOpenProject() {
    openFileInput?.click();
  }

  async function onOpenProjectFileChosen(e) {
    const file = e.target.files?.[0];
    e.target.value = "";  // reset so the same file can be re-opened later
    if (!file) return;
    packageStatus = `opening ${file.name}…`;
    const r = await openProject(file);
    if (r.ok) {
      packageStatus = `opened ${file.name}`;
    } else {
      packageStatus = `open failed: ${r.error}`;
    }
    setTimeout(() => { packageStatus = ""; }, 4000);
  }

  async function onExportHyperframe() {
    packageStatus = "exporting…";
    const r = await exportHyperframeHtml();
    if (r.ok) {
      packageStatus = `exported ${r.filename} (${r.sizeKb} KB)`;
    } else {
      packageStatus = `export failed: ${r.error}`;
    }
    setTimeout(() => { packageStatus = ""; }, 3000);
  }

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

<div class="grid h-screen min-h-0 grid-rows-[34px_minmax(0,1fr)]">
  <header class="flex items-stretch gap-2 px-2 border-b border-border bg-page">
    <!-- File / Edit / Plugins / Skills menus. Phase A.2 places the
         primary application actions here; tabs live inside the
         left panel itself now (LeftPanel.svelte). -->
    <MenuBar
      onNewProject={onNewProject}
      onOpenProject={onOpenProject}
      onExportHyperframe={onExportHyperframe}
      onPackage={onPackage}
      onRender={() => renderOpen = true}
      onSettings={() => settingsOpen = true}
      onPluginManager={() => pluginsOpen = true}
      onSkillManager={() => skillsOpen = true}
    />

    <span class="flex-1"></span>

    <span class="font-mono text-[10px] tabular-nums px-2 py-0.5 rounded-full border self-center"
          class:text-accent={env.satisfied}
          class:border-accent={env.satisfied}
          class:text-fg-muted={!env.satisfied}
          class:border-border={!env.satisfied}
          title={env.satisfied ? `Model: ${env.model}` : "No API key — open settings"}>
      {env.satisfied ? "● connected" : "○ no key"}
    </span>

    {#if packageStatus}
      <span class="font-mono text-[10px] text-fg-faint self-center max-w-[200px] truncate" title={packageStatus}>
        {packageStatus}
      </span>
    {/if}

    <!-- Render stays as a primary CTA in the bar — the menu has it
         too, but the rapid-iteration workflow keeps it one click away. -->
    <button
      onclick={() => renderOpen = true}
      class="h-7 px-3 rounded flex items-center gap-1.5 self-center
             border border-accent bg-accent text-accent-fg
             hover:opacity-90 cursor-pointer transition
             font-mono text-[10px] font-semibold"
      title="Render composition to video"
      aria-label="Render"
    >
      <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <rect x="1.5" y="2" width="10" height="9" rx="1.5"/>
        <path d="M5.5 4.5 L8.5 6.5 L5.5 8.5 Z" fill="currentColor"/>
      </svg>
      render
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
<PluginManager bind:open={pluginsOpen} />
<SkillManager bind:open={skillsOpen} />

<!-- Hidden file input for File > Open Project. Accepts hyperframe.html
     and .workbook.html — projectIO.openProject sniffs the format. -->
<input
  type="file"
  accept=".html,text/html"
  bind:this={openFileInput}
  onchange={onOpenProjectFileChosen}
  style="display: none"
/>

