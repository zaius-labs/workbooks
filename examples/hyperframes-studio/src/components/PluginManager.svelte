<script>
  /**
   * Plugins Manager — install runtime extensions from any URL.
   *
   * v1 scope: ephemeral install per session. Future v2 persists URLs
   * in the workbook so plugins auto-load when the .workbook.html is
   * opened elsewhere.
   *
   * Trust: plugins run in the studio's context. Installing one is
   * opt-in (paste a URL). For most users the path is:
   * https://raw.githubusercontent.com/<org>/<repo>/<ref>/<file>.js
   * where the file is a deliberately-published module.
   */
  import { plugins } from "../lib/plugins.svelte.js";

  let { open = $bindable(false) } = $props();

  let url = $state("");
  let error = $state("");
  let success = $state("");

  async function onInstall() {
    error = ""; success = "";
    try {
      const entry = await plugins.install(url.trim());
      success = `installed ${entry.name}${entry.version ? ` v${entry.version}` : ""}`;
      url = "";
      setTimeout(() => { success = ""; }, 2200);
    } catch (e) {
      error = e?.message ?? String(e);
    }
  }
  function onKey(ev) { if (ev.key === "Enter") onInstall(); }
</script>

{#if open}
  <div class="modal-overlay" onclick={() => open = false}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <header class="modal-head">
        <h2 class="font-mono text-[12px] font-semibold uppercase tracking-widest text-fg-muted">Plugins Manager</h2>
        <button class="modal-close" onclick={() => open = false} aria-label="Close">×</button>
      </header>

      <div class="modal-body">
        <p class="text-fg-muted font-mono text-[11px] leading-relaxed mb-3">
          Install a plugin by pasting its URL. The file must export a default
          function that registers tools, hooks, or panels via the studio's
          plugin API.
        </p>

        <div class="install-row">
          <input
            type="url"
            placeholder="https://raw.githubusercontent.com/.../plugin.js"
            bind:value={url}
            onkeydown={onKey}
            disabled={plugins.busy}
          />
          <button
            onclick={onInstall}
            disabled={plugins.busy || !url.trim()}
          >
            {plugins.busy ? "installing…" : "install"}
          </button>
        </div>

        {#if error}<div class="msg msg-err">{error}</div>{/if}
        {#if success}<div class="msg msg-ok">{success}</div>{/if}

        <h3 class="section-h">Installed</h3>
        {#if plugins.installed.length === 0}
          <p class="font-mono text-[10px] text-fg-faint">none yet</p>
        {:else}
          <ul class="plugin-list">
            {#each plugins.installed as p (p.url)}
              <li class="plugin-row">
                <div class="plugin-meta">
                  <code class="plugin-name">{p.name}</code>
                  {#if p.version}<span class="plugin-version">v{p.version}</span>{/if}
                  {#if p.description}<span class="plugin-desc">{p.description}</span>{/if}
                </div>
                <code class="plugin-url">{p.url}</code>
                <button
                  class="plugin-remove"
                  onclick={() => plugins.remove(p.url)}
                  title="Remove from list (already-registered hooks live until reload)"
                >×</button>
              </li>
            {/each}
          </ul>
          <p class="hint">
            Removing only hides the plugin from this list — its registered tools/hooks
            stay active until reload.
          </p>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-overlay {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex; align-items: center; justify-content: center;
    z-index: 100;
  }
  .modal {
    width: min(680px, 92vw);
    max-height: 86vh;
    background: var(--color-page);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
    display: flex; flex-direction: column;
  }
  .modal-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border-bottom: 1px solid var(--color-border);
  }
  .modal-close {
    width: 24px; height: 24px;
    background: transparent; border: 0; color: var(--color-fg-muted);
    cursor: pointer; font-size: 20px; line-height: 1;
  }
  .modal-close:hover { color: var(--color-fg); }
  .modal-body { padding: 16px; overflow-y: auto; }

  .install-row { display: flex; gap: 8px; }
  .install-row input {
    flex: 1; height: 28px; padding: 0 10px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-surface);
    color: var(--color-fg);
    font-family: var(--font-mono); font-size: 11px;
    outline: none;
  }
  .install-row input:focus { border-color: var(--color-accent); }
  .install-row button {
    height: 28px; padding: 0 14px;
    border: 1px solid var(--color-accent);
    border-radius: 4px;
    background: var(--color-accent);
    color: var(--color-accent-fg);
    font-family: var(--font-mono); font-size: 11px; font-weight: 600;
    cursor: pointer;
  }
  .install-row button:disabled { opacity: 0.4; cursor: wait; }

  .msg {
    margin-top: 8px;
    padding: 6px 10px; border-radius: 4px;
    font-family: var(--font-mono); font-size: 11px;
  }
  .msg-err { color: rgb(248 113 113); border: 1px solid rgba(220, 38, 38, 0.4); background: rgba(127, 29, 29, 0.18); }
  .msg-ok { color: rgb(74 222 128); border: 1px solid rgba(34, 197, 94, 0.4); background: rgba(20, 83, 45, 0.18); }

  .section-h {
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--color-fg-muted);
    margin: 18px 0 6px;
  }
  .plugin-list { list-style: none; padding: 0; margin: 0; }
  .plugin-row {
    display: grid; grid-template-columns: 1fr auto;
    gap: 4px 10px;
    padding: 8px 0;
    border-bottom: 1px solid var(--color-border);
    font-family: var(--font-mono); font-size: 11px;
  }
  .plugin-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; grid-column: 1 / 2; }
  .plugin-name { color: var(--color-fg); font-weight: 600; }
  .plugin-version { color: var(--color-fg-faint); font-size: 10px; }
  .plugin-desc { color: var(--color-fg-muted); font-size: 10px; }
  .plugin-url { grid-column: 1 / 2; color: var(--color-fg-faint); font-size: 10px; word-break: break-all; }
  .plugin-remove {
    grid-column: 2; grid-row: 1 / 3;
    align-self: start;
    width: 22px; height: 22px;
    background: transparent; border: 0; color: var(--color-fg-muted);
    cursor: pointer; font-size: 14px; line-height: 1;
  }
  .plugin-remove:hover { color: rgb(248 113 113); }
  .hint { font: 10px var(--font-mono); color: var(--color-fg-faint); margin-top: 8px; }
</style>
