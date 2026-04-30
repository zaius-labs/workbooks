<script>
  import {
    detectWorkbookPath, detectSlug,
    claudeCodeCommand, claudeDesktopJson, cursorJson, codexJson, installPrompt,
  } from "../lib/mcp.js";
  import { mcpBridge, isMcpMode } from "../lib/mcpBridge.svelte.js";

  // Two operating shapes:
  //   1. Static info (default) — page opened normally. Surface
  //      reduced to the two snippets a user actually copies: the
  //      one-liner install command, and the LLM-handoff prompt.
  //      Advanced JSON configs collapse behind a disclosure.
  //   2. Live (#mcp) — show what the connected host is doing.
  //      Drop the install copy entirely; user already wired it up.

  const inMcpMode = isMcpMode();
  const path = detectWorkbookPath();
  const slug = detectSlug();
  let copied = $state("");
  let advanced = $state(false);

  const primary = {
    install: claudeCodeCommand({ slug, path }),
    prompt:  installPrompt({ slug, path }),
  };
  const advancedSnippets = [
    { id: "claude-desktop", label: "Claude Desktop", body: claudeDesktopJson({ slug, path }) },
    { id: "cursor",         label: "Cursor",         body: cursorJson({ slug, path }) },
    { id: "codex",          label: "Codex",          body: codexJson({ slug, path }) },
  ];

  async function copy(id, body) {
    try {
      await navigator.clipboard.writeText(body);
      copied = id;
      setTimeout(() => { if (copied === id) copied = ""; }, 1400);
    } catch {}
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, "0")).join(":");
  }
  function summarize(args) {
    if (!args || (typeof args === "object" && !Object.keys(args).length)) return "{}";
    try {
      const s = JSON.stringify(args);
      return s.length > 80 ? s.slice(0, 79) + "…" : s;
    } catch { return ""; }
  }
  let statusLabel = $derived(({
    idle: "● idle", working: "● working", editing: "✎ editing",
    rendering: "▶ rendering", error: "⚠ error",
  })[mcpBridge.status] ?? mcpBridge.status);
</script>

<section class="flex flex-col min-h-0 flex-1">
  <div class="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-5">

    {#if inMcpMode}
      <!-- ─── Live mode ─────────────────────────────────────── -->
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="font-mono text-[11px]"
                class:text-accent={mcpBridge.connected}
                class:text-fg-faint={!mcpBridge.connected}>
            {mcpBridge.connected ? `● ${mcpBridge.clientName ?? "host"}` : "○ no host"}
          </span>
          <span class="font-mono text-[11px]"
                class:text-accent={mcpBridge.status === "editing" || mcpBridge.status === "working"}
                class:text-amber-300={mcpBridge.status === "rendering"}
                class:text-red-300={mcpBridge.status === "error"}
                class:text-fg-muted={mcpBridge.status === "idle"}>
            {statusLabel}
          </span>
        </div>

        <div class="border border-border rounded bg-page max-h-[60vh] overflow-y-auto">
          {#if mcpBridge.activity.length === 0}
            <div class="font-mono text-[11px] text-fg-faint px-3 py-3 text-center">
              waiting for tool calls…
            </div>
          {:else}
            {#each mcpBridge.activity as e (e.id)}
              <details class="border-b border-border last:border-b-0">
                <summary class="cursor-pointer px-3 py-1.5 flex items-center gap-2 font-mono text-[11px]">
                  <span class="text-fg-faint tabular-nums">{fmtTime(e.ts)}</span>
                  <span class:text-accent={e.ok} class:text-red-300={!e.ok}>
                    {e.ok ? "→" : "✕"}
                  </span>
                  <span class="text-fg font-semibold">{e.name}</span>
                  <span class="text-fg-faint flex-1 truncate">{summarize(e.args)}</span>
                  <span class="text-fg-faint tabular-nums">{e.durationMs}ms</span>
                </summary>
                <div class="px-3 py-2 border-t border-border bg-surface space-y-1.5">
                  <pre class="m-0 font-mono text-[11px] text-fg whitespace-pre-wrap break-all max-h-32 overflow-auto">{JSON.stringify(e.args, null, 2)}</pre>
                  <pre class="m-0 font-mono text-[11px] whitespace-pre-wrap break-all max-h-40 overflow-auto"
                       class:text-fg={e.ok} class:text-red-300={!e.ok}>{e.result}</pre>
                </div>
              </details>
            {/each}
          {/if}
        </div>

        {#if mcpBridge.activity.length}
          <button
            onclick={() => mcpBridge.clearLog()}
            class="font-mono text-[10px] text-fg-faint hover:text-fg cursor-pointer underline underline-offset-2"
          >clear log</button>
        {/if}
      </div>

    {:else}
      <!-- ─── Static info / install mode ─────────────────────── -->
      <p class="text-[12px] text-fg-muted leading-relaxed">
        Configure your AI client to host this workbook as an MCP server.
        Tool calls (<code class="text-accent">get_composition</code>,
        <code class="text-accent">set_composition</code>,
        <code class="text-accent">patch_clip</code>, …) are routed through the
        same surface the in-app agent uses.
      </p>

      <!-- Primary: one-liner install command -->
      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <span class="font-mono text-[10px] uppercase tracking-wider text-fg-muted">install command</span>
          <button
            onclick={() => copy("install", primary.install)}
            class="px-2 py-0.5 rounded font-mono text-[10px] cursor-pointer
                   border border-accent bg-accent text-accent-fg hover:opacity-90"
          >{copied === "install" ? "✓ copied" : "copy"}</button>
        </div>
        <pre class="m-0 p-2.5 rounded border border-border bg-page font-mono text-[11px] leading-relaxed text-fg whitespace-pre-wrap break-all">{primary.install}</pre>
      </div>

      <!-- Primary: hand-off prompt for any LLM client -->
      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <span class="font-mono text-[10px] uppercase tracking-wider text-fg-muted">or paste to an LLM</span>
          <button
            onclick={() => copy("prompt", primary.prompt)}
            class="px-2 py-0.5 rounded font-mono text-[10px] cursor-pointer
                   border border-border text-fg-muted hover:text-fg hover:border-border-2"
          >{copied === "prompt" ? "✓ copied" : "copy"}</button>
        </div>
      </div>

      <!-- Advanced: collapse JSON configs behind a single disclosure -->
      <details bind:open={advanced} class="border-t border-border pt-3">
        <summary class="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-fg-muted hover:text-fg list-none flex items-center gap-1.5">
          <span class="arrow" class:open={advanced}>▸</span>
          advanced · json configs
        </summary>
        <div class="mt-3 space-y-3">
          {#each advancedSnippets as s (s.id)}
            <div class="border border-border rounded overflow-hidden bg-page">
              <div class="flex items-center justify-between px-2.5 py-1 border-b border-border bg-surface-2">
                <span class="font-mono text-[11px] text-fg">{s.label}</span>
                <button
                  onclick={() => copy(s.id, s.body)}
                  class="px-2 py-0.5 rounded font-mono text-[10px] cursor-pointer
                         border border-border text-fg-muted hover:text-fg hover:border-border-2"
                >{copied === s.id ? "✓" : "copy"}</button>
              </div>
              <pre class="m-0 p-2.5 font-mono text-[10px] leading-relaxed text-fg whitespace-pre max-h-40 overflow-auto">{s.body}</pre>
            </div>
          {/each}
        </div>
      </details>

      <p class="text-[10px] text-fg-faint font-mono leading-relaxed pt-1">
        Append <code class="text-accent">#mcp</code> to the URL for a live activity view.
      </p>
    {/if}

  </div>
</section>

<style>
  details > summary { user-select: none; }
  .arrow {
    display: inline-block;
    transition: transform 120ms ease;
    color: var(--color-fg-faint);
  }
  .arrow.open { transform: rotate(90deg); }
  details > summary::-webkit-details-marker { display: none; }
</style>
