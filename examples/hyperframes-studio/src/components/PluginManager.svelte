<script>
  /**
   * Plugins Manager.
   *
   * Install path: paste a URL → fetch + probe manifest → confirm
   * permissions → embed bytes in the workbook → activate. The URL is
   * remembered for "Update" (re-fetch + replace bytes); the bytes
   * themselves run inline at runtime so the file is fully portable.
   *
   * Per-plugin row: toggle (on/off), Update, Remove.
   *
   * Future v2 (P3): a Browse view that lists plugins from the default
   * registry (zaius-labs/hyperframe-studio-plugins) plus any
   * user-configured custom registries.
   */
  import { plugins } from "../lib/plugins.svelte.js";

  let { open = $bindable(false) } = $props();

  let url = $state("");
  let error = $state("");
  let success = $state("");
  let fileInputEl;

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

  async function onPickFile(ev) {
    error = ""; success = "";
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const code = await file.text();
      const entry = await plugins.installFromCode(code, { sourceLabel: file.name });
      success = `installed ${entry.name}${entry.version ? ` v${entry.version}` : ""} (from file)`;
      setTimeout(() => { success = ""; }, 2200);
    } catch (e) {
      error = e?.message ?? String(e);
    }
  }

  async function onUpdate(id) {
    error = ""; success = "";
    try {
      const entry = await plugins.update(id);
      success = `updated ${entry.name} → v${entry.version}`;
      setTimeout(() => { success = ""; }, 2200);
    } catch (e) {
      error = e?.message ?? String(e);
    }
  }
  async function onToggle(id, ev) {
    error = "";
    try {
      await plugins.setEnabled(id, ev.currentTarget.checked);
    } catch (e) {
      error = e?.message ?? String(e);
    }
  }
  async function onRemove(id) {
    if (!confirm(`Remove plugin '${id}'? Its embedded bytes are deleted; reinstall from URL to recover.`)) return;
    await plugins.remove(id);
  }

  function fmtAge(ts) {
    if (!ts) return "";
    const d = Date.now() - ts;
    if (d < 60_000) return "just now";
    if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
    return `${Math.floor(d / 86_400_000)}d ago`;
  }
</script>

{#if open}
  <div class="modal-overlay" onclick={() => open = false}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <header class="modal-head">
        <h2 class="font-mono text-[12px] font-semibold uppercase tracking-widest text-fg-muted">Plugins</h2>
        <button class="modal-close" onclick={() => open = false} aria-label="Close">×</button>
      </header>

      <div class="modal-body">
        <p class="text-fg-muted font-mono text-[11px] leading-relaxed mb-3">
          Install a plugin by pasting its URL. The studio fetches once,
          embeds the bytes in this workbook, and runs from there — no
          network at runtime. "Update" re-fetches and replaces.
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
        <div class="file-row">
          <span>or install from a local .js file:</span>
          <input
            type="file"
            accept=".js,.mjs,application/javascript,text/javascript"
            bind:this={fileInputEl}
            onchange={onPickFile}
            style="display: none"
          />
          <button class="ghost" onclick={() => fileInputEl?.click()} disabled={plugins.busy}>
            choose file…
          </button>
        </div>

        {#if error}<div class="msg msg-err">{error}</div>{/if}
        {#if success}<div class="msg msg-ok">{success}</div>{/if}

        <h3 class="section-h">Installed</h3>
        {#if plugins.items.length === 0}
          <p class="font-mono text-[10px] text-fg-faint">none yet</p>
        {:else}
          <ul class="plugin-list">
            {#each plugins.items as p (p.id)}
              <li class="plugin-row">
                <label class="plugin-toggle" title="{p.enabled ? 'enabled — click to disable' : 'disabled — click to enable'}">
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    onchange={(ev) => onToggle(p.id, ev)}
                  />
                  <span class="track"></span>
                </label>

                <div class="plugin-meta">
                  <div class="plugin-head">
                    {#if p.icon}<span class="plugin-icon">{p.icon}</span>{/if}
                    <code class="plugin-name">{p.name}</code>
                    {#if p.version}<span class="plugin-version">v{p.version}</span>{/if}
                  </div>
                  {#if p.description}<div class="plugin-desc">{p.description}</div>{/if}
                  <div class="plugin-aux">
                    {#if p.surfaces?.length}<span>surfaces: {p.surfaces.join(", ")}</span>{/if}
                    {#if p.permissions?.length}<span>permissions: {p.permissions.join(", ")}</span>{/if}
                    <span title={`installed ${fmtAge(p.installedAt)}`}>updated {fmtAge(p.updatedAt)}</span>
                  </div>
                  {#if p.source?.url}<code class="plugin-url">{p.source.url}</code>{/if}
                </div>

                <div class="plugin-actions">
                  <button onclick={() => onUpdate(p.id)} disabled={plugins.busy || !p.source?.url} title="Re-fetch URL and replace embedded bytes">update</button>
                  <button onclick={() => onRemove(p.id)} class="danger" title="Uninstall">remove</button>
                </div>
              </li>
            {/each}
          </ul>
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
    width: min(720px, 92vw);
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
  .file-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; margin-top: 6px;
    font: 10px var(--font-mono); color: var(--color-fg-faint);
  }
  .file-row button {
    height: 24px; padding: 0 10px;
    border: 1px solid var(--color-border); border-radius: 4px;
    background: transparent; color: var(--color-fg-muted);
    font: 10px var(--font-mono); cursor: pointer;
  }
  .file-row button:hover:not(:disabled) { color: var(--color-fg); border-color: var(--color-fg); }
  .file-row button:disabled { opacity: 0.4; cursor: not-allowed; }

  .msg { margin-top: 8px; padding: 6px 10px; border-radius: 4px; font: 11px var(--font-mono); }
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
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 10px;
    padding: 10px 0;
    border-bottom: 1px solid var(--color-border);
    align-items: start;
  }
  .plugin-toggle {
    width: 28px; height: 16px;
    position: relative; flex-shrink: 0;
    margin-top: 2px;
  }
  .plugin-toggle input { position: absolute; opacity: 0; pointer-events: none; }
  .plugin-toggle .track {
    position: absolute; inset: 0;
    background: var(--color-border);
    border-radius: 999px;
    cursor: pointer;
    transition: background 100ms ease;
  }
  .plugin-toggle .track::after {
    content: "";
    position: absolute;
    top: 2px; left: 2px;
    width: 12px; height: 12px;
    background: white;
    border-radius: 999px;
    transition: transform 100ms ease;
  }
  .plugin-toggle input:checked ~ .track { background: var(--color-accent); }
  .plugin-toggle input:checked ~ .track::after { transform: translateX(12px); }
  .plugin-meta { font-family: var(--font-mono); font-size: 11px; min-width: 0; }
  .plugin-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .plugin-icon { font-size: 14px; }
  .plugin-name { color: var(--color-fg); font-weight: 600; }
  .plugin-version { color: var(--color-fg-faint); font-size: 10px; }
  .plugin-desc { color: var(--color-fg-muted); font-size: 11px; margin: 4px 0 0; }
  .plugin-aux { display: flex; gap: 12px; flex-wrap: wrap; color: var(--color-fg-faint); font-size: 10px; margin: 4px 0 0; }
  .plugin-url { color: var(--color-fg-faint); font-size: 10px; word-break: break-all; display: block; margin: 4px 0 0; }
  .plugin-actions { display: flex; gap: 4px; flex-shrink: 0; }
  .plugin-actions button {
    height: 24px; padding: 0 10px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-surface);
    color: var(--color-fg-muted);
    font-family: var(--font-mono); font-size: 10px;
    cursor: pointer;
  }
  .plugin-actions button:hover:not(:disabled) { color: var(--color-fg); border-color: var(--color-fg); }
  .plugin-actions button:disabled { opacity: 0.4; cursor: not-allowed; }
  .plugin-actions .danger:hover:not(:disabled) {
    color: rgb(248 113 113);
    border-color: rgba(220, 38, 38, 0.6);
  }
</style>
