<script>
  /**
   * Detail view: at-a-glance facts on the left, starmap of saves
   * on the right. Click a node in the map → that save's facts
   * replace the latest's on the left. The map is genuinely
   * navigable: pannable, zoomable, with curved edges between
   * saves on the same path and dotted leaps when the workbook
   * jumped to a different file.
   */
  import Starmap from "./Starmap.svelte";
  import {
    agentName, agentShort, agoLong, basename, fmtBytes,
    fmtDelta, fmtGap, homeify,
  } from "../lib/format.js";
  import { iconExternal, iconCopy } from "../lib/icons.js";

  let { summary, openPath, fetchHistory, onPickById, onBack } = $props();

  let history = $state(null);
  let selectedSaveIdx = $state(null);
  let loading = $state(true);

  $effect(() => {
    loading = true;
    fetchHistory(summary.workbook_id).then((h) => {
      history = h;
      selectedSaveIdx = h?.saves?.length ? h.saves.length - 1 : null;
      loading = false;
    }).catch(() => { loading = false; });
  });

  let selectedSave = $derived(
    history && selectedSaveIdx != null ? history.saves[selectedSaveIdx] : null
  );
  let prevSave = $derived(
    history && selectedSaveIdx != null && selectedSaveIdx > 0
      ? history.saves[selectedSaveIdx - 1]
      : null
  );

  let editedSentence = $derived.by(() => {
    if (!selectedSave) return "";
    return `${agentName(selectedSave.agent)}, ${agoLong(selectedSave.ts)}.`;
  });
  let positionSentence = $derived.by(() => {
    if (!selectedSave || !history) return "";
    const total = history.saves.length;
    const pos = selectedSaveIdx + 1;
    if (!prevSave) return total === 1 ? "First save." : `Save ${pos} of ${total}.`;
    const gap = fmtGap(selectedSave.ts, prevSave.ts);
    const delta = fmtDelta(selectedSave.size, prevSave.size);
    return [`Save ${pos} of ${total}`, gap, delta].filter(Boolean).join(" · ") + ".";
  });

  let copyFlash = $state("");
  function copy(text, label) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text);
    copyFlash = label;
    setTimeout(() => { copyFlash = ""; }, 1200);
  }
</script>

{#if loading}
  <main class="empty"><div class="loader">loading…</div></main>
{:else if !history}
  <main class="empty"><div class="loader">no history</div></main>
{:else}
  <div class="layout">
    <aside class="left">
      <header class="left-head">
        <div class="dot lg agent-{agentShort(selectedSave?.agent)}"></div>
        <h1 class="filename">{basename(selectedSave?.file_path) || summary.workbook_id}</h1>
      </header>

      <p class="lede">{editedSentence}</p>
      <p class="position">{positionSentence}</p>

      {#if summary.forked_from}
        <button
          class="lineage-pill"
          onclick={() => onPickById?.(summary.forked_from.parent_workbook_id)}
          title="open the parent workbook"
        >
          <span class="lineage-glyph">↳</span>
          <span class="lineage-label">forked from</span>
          <span class="lineage-name mono">{basename(summary.forked_from.parent_path) || summary.forked_from.parent_workbook_id.slice(0, 12)}</span>
        </button>
      {/if}
      {#if summary.fork_count > 0}
        <div class="lineage-pill static">
          <span class="lineage-glyph fork-glyph">⑂</span>
          <span class="lineage-label">spawned</span>
          <span class="lineage-name tnum">{summary.fork_count} fork{summary.fork_count === 1 ? "" : "s"}</span>
        </div>
      {/if}

      <div class="actions">
        <button class="primary" onclick={() => openPath(selectedSave.file_path)}>
          <span>Open this copy</span>
          <span class="ext">{@html iconExternal}</span>
        </button>
      </div>

      <div class="hairline"></div>

      <dl class="kv">
        <dt>edited by</dt>
        <dd>{agentName(selectedSave?.agent)}</dd>

        <dt>at</dt>
        <dd class="path-cell mono" title={selectedSave?.file_path}>{homeify(selectedSave?.file_path ?? "")}</dd>

        <dt>size</dt>
        <dd>{fmtBytes(selectedSave?.size)}</dd>

        <dt>workbook</dt>
        <dd>
          <button class="copyable mono" onclick={() => copy(history.workbook_id, "id copied")}>
            {history.workbook_id}
          </button>
        </dd>

        <dt>sha</dt>
        <dd>
          <button class="copyable mono" onclick={() => copy(selectedSave.file_sha256, "sha copied")}>
            {selectedSave.file_sha256.slice(0, 16)}…
          </button>
        </dd>
      </dl>

      {#if copyFlash}
        <div class="flash">{copyFlash}</div>
      {/if}

      {#if history.paths_seen.length > 1}
        <div class="hairline"></div>
        <div class="paths-cap">
          <span class="label-cap">Other copies on this Mac</span>
          <span class="count tnum">{history.paths_seen.length - 1}</span>
        </div>
        <ul class="paths">
          {#each history.paths_seen.filter((p) => p !== selectedSave?.file_path) as p (p)}
            <li>
              <button class="path-btn" onclick={() => openPath(p)}>
                <span class="path-text mono" title={p}>{homeify(p)}</span>
                <span class="ext">{@html iconExternal}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </aside>

    <div class="hairline-v"></div>

    <section class="right">
      <Starmap
        {history}
        bind:selectedIdx={selectedSaveIdx}
      />
    </section>
  </div>
{/if}

<style>
  main.empty {
    flex: 1 1 auto;
    display: flex; align-items: center; justify-content: center;
  }
  .loader { color: var(--fg-faint); font-size: 12px; }

  .layout {
    flex: 1 1 auto;
    display: grid;
    grid-template-columns: 320px 1px minmax(0, 1fr);
    overflow: hidden;
  }

  .left {
    display: flex; flex-direction: column;
    overflow-y: auto;
    padding: 18px 18px 24px;
    background: var(--surface-1);
  }
  .left-head {
    display: flex; align-items: flex-start; gap: 10px;
    margin-bottom: 12px;
  }
  .left-head .dot { margin-top: 5px; }
  .filename {
    margin: 0;
    font-size: 16px;
    font-weight: 500;
    color: var(--fg);
    letter-spacing: -0.01em;
    word-break: break-all;
    line-height: 1.3;
  }
  .lede {
    margin: 0;
    color: var(--fg-muted);
    font-size: 12.5px;
    line-height: 1.5;
  }
  .position {
    margin: 4px 0 14px;
    color: var(--fg-faint);
    font-size: 11.5px;
  }

  /* Lineage pill — surfaces fork relationships on the details
   * panel. Two flavors: clickable "forked from <parent>" (jumps
   * to the parent) and static "spawned N forks" indicator. */
  .lineage-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 9px;
    margin: 0 0 6px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 11px;
    color: var(--fg-muted);
    cursor: pointer;
    transition: background 80ms ease, color 80ms ease, border-color 80ms ease;
  }
  .lineage-pill:hover { background: var(--surface-3); color: var(--fg); border-color: var(--fg-faint); }
  .lineage-pill.static { cursor: default; }
  .lineage-pill.static:hover { background: var(--surface-2); color: var(--fg-muted); border-color: var(--border); }
  .lineage-glyph { color: var(--c-native); }
  .fork-glyph { color: var(--c-codex); }
  .lineage-label { color: var(--fg-faint); font-size: 10.5px; }
  .lineage-name { font-size: 11px; }

  .actions { display: flex; }
  .actions .primary { width: 100%; }
  .ext { display: inline-flex; opacity: 0.7; margin-left: 6px; }

  .hairline {
    height: 1px; background: var(--hairline);
    margin: 16px 0;
  }
  .hairline-v { background: var(--hairline); }

  .kv {
    margin: 0;
    display: grid;
    grid-template-columns: 70px 1fr;
    gap: 8px 12px;
    font-size: 11.5px;
  }
  .kv dt { margin: 0; color: var(--fg-faint); text-transform: lowercase; }
  .kv dd { margin: 0; color: var(--fg); word-break: break-all; }
  .path-cell { color: var(--fg-muted) !important; font-size: 10.5px; line-height: 1.4; }
  .copyable {
    background: transparent; border: 0; padding: 0; height: auto;
    color: var(--fg);
    font-size: inherit;
    cursor: pointer;
    text-align: left;
    word-break: break-all;
  }
  .copyable:hover { background: transparent; color: var(--fg); }
  .copyable:active { color: var(--c-codex); }

  .flash {
    margin-top: 8px;
    font-size: 10.5px;
    color: var(--c-codex);
  }

  .paths-cap {
    display: flex; align-items: baseline; justify-content: space-between;
    margin-bottom: 6px;
  }
  .count { font-size: 10px; color: var(--fg-faint); }
  .paths {
    list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 3px;
  }
  .path-btn {
    width: 100%;
    height: 24px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 5px;
    padding: 0 8px;
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px;
    cursor: pointer;
    transition: background 80ms ease, border-color 80ms ease;
  }
  .path-btn:hover { background: var(--surface-2); border-color: var(--border); }
  .path-text {
    font-size: 10.5px;
    color: var(--fg-muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    flex: 1 1 auto;
    text-align: left;
  }
  .path-btn:hover .path-text { color: var(--fg); }
  .path-btn .ext { color: var(--fg-faint); opacity: 0; transition: opacity 80ms; }
  .path-btn:hover .ext { opacity: 1; }

  .right {
    background: var(--bg);
    overflow: hidden;
    position: relative;
  }
</style>
