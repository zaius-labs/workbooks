<script>
  /**
   * Home view — search bar + cards grid.
   *
   * Card hierarchy:
   *   1. Agent-colored side stripe — instant visual identity
   *      (one dominant cue, scannable across the grid).
   *   2. Filename — large, 14px, the only thing the eye lands on.
   *   3. Meta line — small, dim, "3 saves · 1 path · 2m".
   *   4. Hover-only ↗ icon top-right — quick "open latest"
   *      shortcut without polluting the resting state.
   * Click anywhere on the card body → details view (starmap).
   * Click ↗ → opens the latest copy in the browser.
   */
  import { iconSearch, iconRefresh, iconExternal } from "../lib/icons.js";
  import { ago, basename, agentShort } from "../lib/format.js";

  let { workbooks, discovered = [], onPick, onOpenLatest, onRefresh } = $props();
  let q = $state("");

  let filtered = $derived.by(() => {
    if (!q.trim()) return workbooks;
    const needle = q.toLowerCase();
    return workbooks.filter((w) =>
      (w.workbook_id?.toLowerCase().includes(needle)) ||
      (w.paths_seen ?? []).some((p) => p.toLowerCase().includes(needle))
    );
  });

  // Files Spotlight found on disk that the daemon's never served —
  // i.e. their path doesn't match any paths_seen in the ledger. These
  // appear in a separate "Discovered" section so users can see "I have
  // workbooks on disk Workbooks doesn't know about yet" without
  // confusing them with their actual session history.
  let discoveredFresh = $derived.by(() => {
    if (!discovered?.length) return [];
    const known = new Set();
    for (const w of workbooks) {
      for (const p of w.paths_seen ?? []) known.add(p);
    }
    const needle = q.trim().toLowerCase();
    return discovered.filter((d) => {
      if (known.has(d.path)) return false;
      if (!needle) return true;
      return d.path.toLowerCase().includes(needle);
    });
  });

  function pickById(id) {
    const target = workbooks.find((x) => x.workbook_id === id);
    if (target) onPick(target);
  }
</script>

<header class="bar">
  <div class="input-with-icon">
    <span class="input-icon">{@html iconSearch}</span>
    <input
      type="search"
      placeholder="Search workbooks"
      bind:value={q}
      autocomplete="off"
      spellcheck="false"
    />
  </div>
  <button class="icon" onclick={onRefresh} aria-label="Refresh">{@html iconRefresh}</button>
</header>

<div class="grid-wrap">
  {#if filtered.length === 0}
    <div class="no-match">no workbooks match “{q}”</div>
  {:else}
    <div class="grid">
      {#each filtered as w (w.workbook_id)}
        {@const agent = agentShort(w.latest_agent ?? 'unknown')}
        <div
          class="card stripe-{agent}"
          onclick={() => onPick(w)}
          onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(w); } }}
          role="button"
          tabindex="0"
        >
          <button
            class="quick-open"
            onclick={(e) => { e.stopPropagation(); onOpenLatest(w.latest_path); }}
            title="Open latest copy"
            aria-label="Open latest copy"
          >
            {@html iconExternal}
          </button>
          <div class="name" title={w.latest_path}>
            {basename(w.latest_path) || w.workbook_id.slice(0, 14)}
            {#if w.fork_count > 0}
              <span class="fork-badge tnum" title="{w.fork_count} other workbook{w.fork_count === 1 ? '' : 's'} forked from this">
                ⑂{w.fork_count}
              </span>
            {/if}
          </div>
          {#if w.forked_from}
            <button
              class="lineage"
              onclick={(e) => { e.stopPropagation(); pickById(w.forked_from.parent_workbook_id); }}
              title="forked from {w.forked_from.parent_path ?? w.forked_from.parent_workbook_id}"
            >
              <span class="lineage-glyph">↳</span>
              <span class="lineage-text">forked from {basename(w.forked_from.parent_path) || w.forked_from.parent_workbook_id.slice(0, 12)}</span>
            </button>
          {/if}
          <div class="meta tnum">
            {w.save_count}<span class="dim"> save{w.save_count === 1 ? "" : "s"}</span>
            <span class="dim-sep">·</span>
            {w.paths_seen.length}<span class="dim"> path{w.paths_seen.length === 1 ? "" : "s"}</span>
            <span class="dim-sep">·</span>
            <span class="age">{ago(w.last_save)}</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if discoveredFresh.length > 0}
    <section class="discovered">
      <h3 class="discovered-h">
        <span>Discovered on disk</span>
        <span class="discovered-count tnum">{discoveredFresh.length}</span>
      </h3>
      <p class="discovered-blurb">
        Files Spotlight found that haven't been opened in Workbooks yet.
        Click to open — that's all it takes to wire them up.
      </p>
      <div class="discovered-list">
        {#each discoveredFresh as d (d.path)}
          <button
            class="disc-row"
            onclick={() => onOpenLatest(d.path)}
            title={d.path}
          >
            <span class="disc-name">{basename(d.path)}</span>
            <span class="disc-path">{d.path}</span>
            <span class="disc-meta tnum">
              {#if !d.stamped}<span class="disc-tag">unstamped</span>{/if}
              {ago(d.modified)}
            </span>
          </button>
        {/each}
      </div>
    </section>
  {/if}
</div>

<style>
  .bar {
    display: flex; gap: 6px; align-items: center;
    padding: 4px 18px 16px;
    flex: 0 0 auto;
  }

  .grid-wrap {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 0 18px 24px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 10px;
  }

  /* The card. Three things the eye sees, in order:
   *   1. The colored stripe on the left (agent identity)
   *   2. The big filename
   *   3. A single dim meta line. */
  .card {
    position: relative;
    height: auto;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 8px;
    padding: 14px 16px 14px 18px;
    cursor: pointer;
    transition: background 100ms ease, border-color 100ms ease, transform 80ms ease;
    text-align: left;
    display: flex; flex-direction: column;
    gap: 6px;
    overflow: hidden;
  }
  .card:hover {
    background: var(--surface-2);
    border-color: var(--border);
  }
  .card:active { transform: translateY(0.5px); }

  /* Left-edge stripe — the dominant identity cue. 3px wide,
   * full card height, color by latest agent. */
  .card::before {
    content: "";
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 3px;
    background: var(--c-unknown);
    transition: background 100ms ease, box-shadow 100ms ease;
  }
  .card.stripe-human::before    { background: var(--c-human);   box-shadow: 0 0 12px rgba(88, 166, 255, 0.35); }
  .card.stripe-claude::before   { background: var(--c-claude);  box-shadow: 0 0 12px rgba(247, 129, 102, 0.35); }
  .card.stripe-codex::before    { background: var(--c-codex);   box-shadow: 0 0 12px rgba(86, 211, 100, 0.35); }
  .card.stripe-native::before   { background: var(--c-native);  box-shadow: 0 0 12px rgba(210, 168, 255, 0.35); }
  .card.stripe-unknown::before  { background: var(--c-unknown); }

  .name {
    font-size: 14px;
    font-weight: 500;
    color: var(--fg);
    line-height: 1.25;
    letter-spacing: -0.01em;
    /* Allow up to two lines so a long filename doesn't ellipsize too
     * eagerly, but cap there so cards stay even-height. */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
    padding-right: 24px; /* room for the ↗ */
  }

  .meta {
    font-size: 11px;
    color: var(--fg-muted);
    display: flex; align-items: baseline; gap: 5px;
  }
  .meta .dim { color: var(--fg-faint); }
  .meta .age { color: var(--fg-muted); margin-left: auto; }

  /* Fork-count badge — sits inline with the filename so the
   * "I'm the parent" cue lands at peak attention. Tiny, dim, only
   * visible when fork_count > 0. */
  .fork-badge {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--surface-3);
    color: var(--fg-muted);
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
    vertical-align: 1px;
  }

  /* Lineage line — a clickable "forked from foo.html"
   * caption that navigates to the parent. Sub-meta hierarchy:
   * smaller than name, larger than meta dim, dim color so it
   * doesn't fight the filename for attention. */
  .lineage {
    align-self: flex-start;
    background: transparent;
    border: 0;
    padding: 0;
    margin: 0;
    font-size: 10.5px;
    color: var(--fg-faint);
    cursor: pointer;
    display: inline-flex; align-items: baseline; gap: 4px;
    max-width: 100%;
    transition: color 80ms ease;
  }
  .lineage:hover { color: var(--fg-muted); }
  .lineage-glyph {
    color: var(--c-native);
    opacity: 0.65;
    font-size: 11px;
  }
  .lineage-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  /* Hover-only quick action: top-right ↗ that opens the latest
   * copy in the browser. Resting state is invisible — the card
   * stays clean. */
  .quick-open {
    position: absolute;
    top: 10px; right: 10px;
    width: 22px; height: 22px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--fg-faint);
    border-radius: 4px;
    display: inline-flex; align-items: center; justify-content: center;
    cursor: pointer;
    opacity: 0;
    transition: opacity 100ms ease, background 100ms ease, color 100ms ease;
  }
  .card:hover .quick-open { opacity: 1; }
  .quick-open:hover {
    background: var(--surface-3);
    color: var(--fg);
  }

  .no-match {
    padding: 40px 16px;
    color: var(--fg-faint);
    font-size: 12px;
    text-align: center;
  }

  /* "Discovered on disk" — a calmer, denser list. Not cards — these
   * are files Workbooks doesn't really know about yet, so we
   * deliberately downplay them visually. The user upgrades them to
   * full cards by clicking once (which calls /open and stamps xattr). */
  .discovered { margin-top: 32px; }
  .discovered-h {
    display: flex; align-items: baseline; gap: 8px;
    font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--fg-muted);
    margin: 0 0 4px 0;
  }
  .discovered-count {
    font-size: 10px;
    background: var(--surface-3);
    color: var(--fg-faint);
    padding: 1px 6px;
    border-radius: 8px;
    letter-spacing: normal;
  }
  .discovered-blurb {
    margin: 0 0 10px 0;
    font-size: 11px;
    color: var(--fg-faint);
    line-height: 1.45;
    max-width: 60ch;
  }
  .discovered-list {
    display: flex; flex-direction: column;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    overflow: hidden;
  }
  .disc-row {
    background: transparent; border: 0;
    padding: 8px 12px;
    display: grid;
    grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto;
    gap: 10px;
    align-items: baseline;
    cursor: pointer;
    text-align: left;
    color: var(--fg);
    border-top: 1px solid var(--hairline);
    transition: background 80ms ease;
  }
  .disc-row:first-child { border-top: 0; }
  .disc-row:hover { background: var(--surface-2); }
  .disc-name {
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 28ch;
  }
  .disc-path {
    font-size: 10.5px;
    color: var(--fg-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    direction: rtl; /* keep filename visible if path overflows */
    text-align: left;
  }
  .disc-meta {
    font-size: 10px;
    color: var(--fg-muted);
    display: flex; align-items: baseline; gap: 6px;
  }
  .disc-tag {
    font-size: 9.5px;
    background: var(--surface-3);
    color: var(--fg-faint);
    padding: 1px 5px;
    border-radius: 3px;
    letter-spacing: 0.02em;
  }
</style>
