<script>
  // History panel — newest-first commit log from the Prolly Tree
  // edit chain. Each commit = one significant edit (composition save,
  // asset add/remove, agent turn). Entries are grouped by day,
  // colour-coded by event type, and revertable to past composition
  // states.

  import {
    readLog,
    readCommit,
    onHistoryChange,
    onCursorChange,
    setCursor,
    getCursor,
  } from "../lib/historyBackend.svelte.js";
  import { layout } from "../lib/layout.svelte.js";
  import { composition } from "../lib/composition.svelte.js";
  import { onMount, onDestroy } from "svelte";

  let entries = $state([]);
  let loading = $state(false);
  let error = $state("");
  let undoingHash = $state("");
  // Cursor state — synced from historyBackend via subscription.
  // null means "follows HEAD" (which is entries[0]).
  let cursorHash = $state(null);

  // The commit the user is currently AT — cursor if set, else HEAD.
  let currentHash = $derived(cursorHash ?? entries[0]?.hash ?? "");
  // Index of currentHash in `entries` (newest-first); everything
  // BEFORE this index is "redo space" — newer than where we are.
  let currentIdx = $derived(entries.findIndex((e) => e.hash === currentHash));

  // Reactive "now" — ticks every second so relative timestamps refresh
  // smoothly. Without this, fmtRelative is frozen until something else
  // triggers re-render.
  let now = $state(Date.now());
  let nowTimer;
  let unsubHistory;
  let unsubCursor;
  onMount(() => {
    nowTimer = setInterval(() => { now = Date.now(); }, 1_000);
    unsubHistory = onHistoryChange(() => {
      if (layout.leftTab === "history") refresh();
    });
    cursorHash = getCursor();
    unsubCursor = onCursorChange(() => {
      cursorHash = getCursor();
    });
  });
  onDestroy(() => {
    if (nowTimer) clearInterval(nowTimer);
    unsubHistory?.();
    unsubCursor?.();
  });

  function refresh() {
    loading = true;
    error = "";
    readLog()
      .then((log) => {
        entries = log;
        // Sync `now` to the wall clock at the moment we received the
        // log so a freshly-recorded commit doesn't briefly read as
        // "in the future" against a stale tick.
        now = Date.now();
        loading = false;
      })
      .catch((e) => {
        error = e?.message ?? String(e);
        loading = false;
      });
  }

  // Refetch on tab focus + after revert.
  $effect(() => {
    if (layout.leftTab === "history") refresh();
  });

  // ─── Time formatting ────────────────────────────────────────────

  function fmtRelative(ms, currentNow) {
    if (!Number.isFinite(ms) || ms <= 0) return "";
    const ago = currentNow - ms;
    if (ago < -60_000) return "in the future";
    if (ago < 10_000) return "just now";
    if (ago < 60_000) return `${Math.floor(ago / 1000)}s ago`;
    if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`;
    if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)}h ago`;
    if (ago < 604_800_000) return `${Math.floor(ago / 86_400_000)}d ago`;
    const d = new Date(ms);
    const sameYear = d.getFullYear() === new Date(currentNow).getFullYear();
    return sameYear
      ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function fmtAbsolute(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "";
    return new Date(ms).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }

  function dayBucket(ms, currentNow) {
    if (!Number.isFinite(ms) || ms <= 0) return "earlier";
    const d = new Date(ms);
    const today = new Date(currentNow);
    today.setHours(0, 0, 0, 0);
    const startOfDay = new Date(d);
    startOfDay.setHours(0, 0, 0, 0);
    const dayDiff = Math.round((today - startOfDay) / 86_400_000);
    if (dayDiff === 0) return "today";
    if (dayDiff === 1) return "yesterday";
    if (dayDiff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
    const sameYear = d.getFullYear() === today.getFullYear();
    return sameYear
      ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function shortHash(h) {
    if (!h || typeof h !== "string") return "";
    return h.slice(0, 7);
  }

  // ─── Event-type classification ──────────────────────────────────
  //
  // Reads the commit message to infer what KIND of edit produced
  // this entry. Drives the per-row icon + accent colour. Not
  // structural — purely cosmetic, the audit chain itself doesn't
  // know the difference.

  function classifyEntry(e) {
    const msg = e.message ?? "";
    if (msg.startsWith("revert to ")) return "revert";
    if (msg.startsWith("composition")) return "composition";
    if (msg.startsWith("add asset") || msg.startsWith("remove asset")) return "asset";
    if (/turn \(/.test(msg)) return "turn";
    if (msg === "hyperframes session start") return "init";
    return "other";
  }

  /** Extract the source-hash prefix from a "revert to abc1234"
   *  message — used to render the inline link target. */
  function revertSourceShort(msg) {
    const m = /^revert to ([0-9a-f]+)/.exec(msg ?? "");
    return m ? m[1] : null;
  }

  // ─── Grouped derivation ─────────────────────────────────────────
  //
  // Build [{label, items: CommitInfo[]}] groups partitioned by
  // day-bucket. The first occurrence of a day in the log starts a
  // group; subsequent same-day entries fold in. Entries are already
  // newest-first from prollyLog, so groups are naturally ordered
  // today → yesterday → earlier.

  let groups = $derived.by(() => {
    if (!entries.length) return [];
    const out = [];
    let cur = null;
    for (const e of entries) {
      const label = dayBucket(e.timestamp_ms, now);
      if (!cur || cur.label !== label) {
        cur = { label, items: [] };
        out.push(cur);
      }
      cur.items.push(e);
    }
    return out;
  });

  let isEmpty = $derived(!loading && !error && entries.length === 0);

  // ─── Undo (cursor move) ─────────────────────────────────────────
  //
  // Click an entry → cursor moves there, composition state
  // materializes from that commit's leaf. The chain is unchanged;
  // entries newer than cursor render dimmed as "redo space."
  //
  // The destructive part comes later: the next real edit (made
  // while cursor != HEAD) calls prollyTruncateTo() before
  // appending, so the redo space is physically dropped from the
  // chain bytes. This matches Cmd+Z / Cmd+Y semantics — redo
  // works until you commit a new edit, then redo space is gone.

  async function moveCursorTo(hash) {
    undoingHash = hash;
    try {
      const snapshot = await readCommit(hash);
      const html = snapshot?.["composition"];
      if (typeof html !== "string") {
        error = "No composition state recorded at that commit";
        return;
      }
      // suppressAudit: true so this is a pure cursor-move, not a
      // new commit. The chain stays put; only the live state
      // materializes from the cursor.
      composition.set(html, undefined, { suppressAudit: true });
      setCursor(hash);
    } catch (e) {
      error = e?.message ?? String(e);
    } finally {
      undoingHash = "";
    }
  }

  /** "Release" the cursor back to HEAD — matches "redo to latest"
   *  semantics. Materializes the composition state at the newest
   *  commit and clears the cursor. */
  async function redoToHead() {
    const head = entries[0]?.hash;
    if (!head) return;
    await moveCursorTo(head);
    setCursor(null); // back to "follow HEAD"
  }
</script>

<section class="flex flex-col min-h-0 flex-1 bg-page">
  <header class="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
    <div class="flex items-center gap-2">
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="text-fg-muted">
        <circle cx="7" cy="3" r="1.2"/>
        <circle cx="7" cy="7" r="1.2"/>
        <circle cx="7" cy="11" r="1.2"/>
        <path d="M7 4.2 L7 5.8"/>
        <path d="M7 8.2 L7 9.8"/>
      </svg>
      <h3 class="font-mono text-[11px] uppercase tracking-wider text-fg-muted m-0 font-semibold">
        edit log
      </h3>
    </div>
    <div class="flex items-center gap-2">
      {#if cursorHash && currentIdx > 0}
        <button
          type="button"
          class="hist-redo"
          title="Jump to the newest commit"
          onclick={redoToHead}
        >
          ↥ latest
        </button>
      {/if}
      {#if entries.length > 0}
        <span class="font-mono text-[10px] text-fg-faint tabular-nums">
          {currentIdx >= 0 ? `${entries.length - currentIdx}/${entries.length}` : `${entries.length}`}
        </span>
      {/if}
    </div>
  </header>

  <div class="flex-1 min-h-0 overflow-y-auto">
    {#if loading && entries.length === 0}
      <div class="px-3 py-4 font-mono text-[11px] text-fg-faint">loading…</div>
    {:else if error}
      <div class="px-3 py-4 font-mono text-[11px] text-red-400">{error}</div>
    {:else if isEmpty}
      <div class="px-3 py-6 font-mono text-[11px] text-fg-faint leading-relaxed">
        <div>No edits recorded yet.</div>
        <div class="mt-2 text-fg-subtle">
          Every composition save, asset change, or agent turn appends a
          cryptographically-chained entry here.
        </div>
      </div>
    {:else}
      {#each groups as g (g.label)}
        <div class="px-3 pt-3 pb-1 font-mono text-[10px] uppercase tracking-wider text-fg-faint sticky top-0 bg-page z-[1] border-b border-border-subtle">
          {g.label}
        </div>
        <ul class="font-mono text-[11px]">
          {#each g.items as e (e.hash)}
            {@const kind = classifyEntry(e)}
            {@const globalIdx = entries.indexOf(e)}
            {@const isCurrent = e.hash === currentHash}
            {@const isInRedo = currentIdx >= 0 && globalIdx < currentIdx}
            <li
              class="hist-row group relative flex items-start gap-2 px-3 py-2 border-l-2 hover:bg-surface transition-colors cursor-pointer"
              class:hist-composition={kind === "composition"}
              class:hist-asset={kind === "asset"}
              class:hist-turn={kind === "turn"}
              class:hist-init={kind === "init"}
              class:hist-other={kind === "other"}
              class:is-current={isCurrent}
              class:is-redo={isInRedo}
              onclick={() => moveCursorTo(e.hash)}
              role="button"
              tabindex="0"
              onkeydown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  moveCursorTo(e.hash);
                }
              }}
            >
              <span class="hist-glyph mt-1 flex-shrink-0" aria-hidden="true"></span>

              <div class="min-w-0 flex-1">
                <div class="flex items-baseline justify-between gap-2">
                  <span class="text-fg truncate" title={e.message}>
                    {e.message || "(no message)"}
                  </span>
                  <span
                    class="text-fg-faint tabular-nums flex-shrink-0"
                    title={fmtAbsolute(e.timestamp_ms)}
                  >
                    {fmtRelative(e.timestamp_ms, now)}
                  </span>
                </div>
                <div class="mt-0.5 flex items-center gap-2 text-fg-subtle text-[10px]">
                  <span class="tabular-nums" title={`commit ${e.hash}`}>
                    {shortHash(e.hash)}
                  </span>
                  {#if isCurrent}
                    <span class="hist-head-badge">current</span>
                  {:else if isInRedo}
                    <span class="hist-redo-badge" title="Newer than your current position. Editing now will discard this.">redo</span>
                  {/if}
                  <span class="flex-1"></span>
                  {#if undoingHash === e.hash}
                    <span class="text-fg-faint italic">moving…</span>
                  {/if}
                </div>
              </div>
            </li>
          {/each}
        </ul>
      {/each}
    {/if}
  </div>
</section>

<style>
  /* Subtler divider than the default border. */
  .border-border-subtle {
    border-color: color-mix(in srgb, var(--color-border) 50%, transparent);
  }

  /* Per-row left bar — subtle accent keyed to event kind. */
  .hist-row { border-left-color: transparent; }
  .hist-row.hist-composition { border-left-color: color-mix(in srgb, var(--color-accent) 60%, transparent); }
  .hist-row.hist-asset       { border-left-color: color-mix(in srgb, oklch(70% 0.15 200) 70%, transparent); }
  .hist-row.hist-turn        { border-left-color: color-mix(in srgb, oklch(70% 0.15 280) 70%, transparent); }
  .hist-row.hist-init        { border-left-color: color-mix(in srgb, var(--color-fg-faint) 70%, transparent); }
  .hist-row.hist-other       { border-left-color: color-mix(in srgb, var(--color-border) 80%, transparent); }

  /* Current cursor position — strong accent + slight bg tint. */
  .hist-row.is-current {
    background: color-mix(in srgb, var(--color-accent) 8%, transparent);
    border-left-color: var(--color-accent);
  }
  /* Redo space — entries newer than the cursor. Dimmed so the
     visual hierarchy makes "where you are" obvious. */
  .hist-row.is-redo { opacity: 0.40; }
  .hist-row.is-redo:hover { opacity: 0.75; }
  .hist-row.is-head          {
    background: color-mix(in srgb, var(--color-accent) 6%, transparent);
  }

  /* Glyph dot — colour-keyed, 6px circle. */
  .hist-glyph {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--glyph-color, var(--color-fg-faint));
    margin-top: 6px;
  }
  .hist-row.hist-composition .hist-glyph { background: var(--color-accent); }
  .hist-row.hist-asset       .hist-glyph { background: oklch(70% 0.15 200); }
  .hist-row.hist-turn        .hist-glyph { background: oklch(70% 0.15 280); }
  .hist-row.hist-init        .hist-glyph { background: var(--color-fg-faint); }

  /* Badges — current cursor + redo-space marker. */
  :global(.hist-head-badge) {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 9px;
    line-height: 1;
    padding: 1px 4px;
    border-radius: 2px;
    background: var(--color-accent);
    color: var(--color-accent-fg, white);
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  :global(.hist-redo-badge) {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 9px;
    line-height: 1;
    padding: 1px 4px;
    border-radius: 2px;
    background: transparent;
    color: var(--color-fg-faint);
    border: 1px solid color-mix(in srgb, var(--color-fg-faint) 50%, transparent);
    letter-spacing: 0.04em;
  }
  /* "↥ latest" button in the header */
  .hist-redo {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    color: var(--color-fg-muted);
    background: var(--color-page);
    border: 1px solid var(--color-border);
    border-radius: 3px;
    padding: 2px 6px;
    cursor: pointer;
  }
  .hist-redo:hover {
    color: var(--color-fg);
    background: var(--color-surface);
  }

  /* Revert button only shows on hover to keep the row quiet at rest. */
  .hist-revert {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    color: var(--color-fg-muted);
    background: var(--color-page);
    border: 1px solid var(--color-border);
    border-radius: 3px;
    padding: 1px 6px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 120ms ease;
  }
  .hist-row:hover .hist-revert { opacity: 1; }
  .hist-revert:hover {
    color: var(--color-fg);
    border-color: color-mix(in srgb, var(--color-border) 200%, transparent);
    background: var(--color-surface);
  }
  .hist-revert:disabled { opacity: 0.5; cursor: wait; }

  /* Modal */
  .hist-modal-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, black 50%, transparent);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .hist-modal {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 20px;
    min-width: 360px;
    max-width: 460px;
    box-shadow: 0 10px 40px color-mix(in srgb, black 30%, transparent);
  }
  .hist-btn-cancel, .hist-btn-confirm {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid var(--color-border);
  }
  .hist-btn-cancel {
    background: transparent;
    color: var(--color-fg-muted);
  }
  .hist-btn-cancel:hover {
    color: var(--color-fg);
    background: var(--color-page);
  }
  .hist-btn-confirm {
    background: var(--color-accent);
    color: var(--color-accent-fg, white);
    border-color: var(--color-accent);
    font-weight: 600;
  }
  .hist-btn-confirm:hover { opacity: 0.9; }
</style>
