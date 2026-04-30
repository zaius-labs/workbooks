<script>
  /**
   * Skills Manager — drag-and-drop markdown files to add new skills
   * the agent can load via `load_skill("user/<name>")`. User skills
   * persist into the .workbook.html file (file-as-database) — share
   * the file, recipient gets your skills.
   *
   * The vendored skills bundled with the studio are listed read-only
   * for reference; users can't remove or replace them, only add.
   */
  import { userSkills } from "../lib/userSkills.svelte.js";
  import { listSkills } from "../lib/skills.js";

  let { open = $bindable(false) } = $props();

  let dragHover = $state(false);
  let busy = $state(false);
  let error = $state("");
  let success = $state("");

  const vendored = listSkills();

  async function importFiles(fileList) {
    error = "";
    success = "";
    busy = true;
    let added = 0;
    for (const f of fileList) {
      if (!/\.md$/i.test(f.name)) {
        error = `${f.name}: only .md files are accepted`;
        continue;
      }
      try {
        await userSkills.addFromFile(f);
        added++;
      } catch (e) {
        error = `${f.name}: ${e?.message ?? e}`;
      }
    }
    if (added > 0) {
      success = `added ${added} skill${added === 1 ? "" : "s"}`;
      setTimeout(() => { success = ""; }, 2200);
    }
    busy = false;
  }

  function onDrop(ev) {
    ev.preventDefault();
    dragHover = false;
    importFiles(ev.dataTransfer?.files ?? []);
  }
  function onDragOver(ev) {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    dragHover = true;
  }
  function onDragLeave() { dragHover = false; }
</script>

{#if open}
  <div class="modal-overlay" onclick={() => open = false}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <header class="modal-head">
        <h2 class="font-mono text-[12px] font-semibold uppercase tracking-widest text-fg-muted">Skills Manager</h2>
        <button class="modal-close" onclick={() => open = false} aria-label="Close">×</button>
      </header>

      <div class="modal-body">
        <p class="text-fg-muted font-mono text-[11px] leading-relaxed mb-3">
          Drop markdown files here to add new skills the agent can load.
          Skills live in this file — share the workbook, recipient gets the skills.
        </p>

        <div
          class="drop-zone"
          class:hover={dragHover}
          ondrop={onDrop}
          ondragover={onDragOver}
          ondragleave={onDragLeave}
        >
          <svg width="22" height="22" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" class="text-fg-faint">
            <path d="M16 22 V8"/>
            <path d="M10 14 L16 8 L22 14"/>
            <path d="M4 22 V26 H28 V22"/>
          </svg>
          <div class="font-mono text-[12px] text-fg">drop .md files here</div>
          <div class="font-mono text-[10px] text-fg-faint">1 MB max per file</div>
        </div>

        {#if error}<div class="msg msg-err">{error}</div>{/if}
        {#if success}<div class="msg msg-ok">{success}</div>{/if}

        <h3 class="section-h">User skills</h3>
        {#if userSkills.items.length === 0}
          <p class="font-mono text-[10px] text-fg-faint">none yet</p>
        {:else}
          <ul class="skill-list">
            {#each userSkills.items as s (s.name)}
              <li class="skill-row">
                <code class="skill-key">user/{s.name}</code>
                <span class="skill-meta">{(s.content.length / 1024).toFixed(1)} KB</span>
                <button
                  class="skill-remove"
                  onclick={() => userSkills.remove(s.name)}
                  aria-label={`Remove user/${s.name}`}
                >×</button>
              </li>
            {/each}
          </ul>
        {/if}

        <h3 class="section-h">Bundled skills (read-only)</h3>
        <ul class="skill-list">
          {#each vendored as s (s.key)}
            <li class="skill-row">
              <code class="skill-key">{s.key}</code>
              <span class="skill-meta">{s.description}</span>
            </li>
          {/each}
        </ul>
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
    width: min(640px, 92vw);
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
  .drop-zone {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px;
    padding: 28px 12px;
    border: 2px dashed var(--color-border);
    border-radius: 8px;
    background: var(--color-surface);
    transition: border-color 120ms ease, background 120ms ease;
    margin-bottom: 12px;
  }
  .drop-zone.hover { border-color: var(--color-accent); background: var(--color-page); }
  .msg {
    margin-top: 8px;
    padding: 6px 10px;
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 11px;
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
  .skill-list { list-style: none; padding: 0; margin: 0; }
  .skill-row {
    display: flex; align-items: center; gap: 10px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--color-border);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .skill-key { color: var(--color-fg); min-width: 220px; }
  .skill-meta { color: var(--color-fg-faint); flex: 1; font-size: 10px; }
  .skill-remove {
    width: 20px; height: 20px;
    background: transparent; border: 0; color: var(--color-fg-muted);
    cursor: pointer; font-size: 14px; line-height: 1;
  }
  .skill-remove:hover { color: rgb(248 113 113); }
</style>
