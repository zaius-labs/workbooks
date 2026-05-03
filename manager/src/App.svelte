<script>
  /**
   * Two views, no fancy router:
   *   • home      — search + cards grid of every workbook
   *   • details   — one workbook, opened from a card click;
   *                 left = at-a-glance info,
   *                 right = starmap of saves you can navigate.
   */
  import Titlebar from "./components/Titlebar.svelte";
  import EmptyState from "./components/EmptyState.svelte";
  import WorkbookList from "./components/WorkbookList.svelte";
  import DetailsView from "./components/DetailsView.svelte";
  import { daemon } from "./lib/daemon.svelte.js";

  let view = $state("home");          // "home" | "details"
  let activeWorkbook = $state(null);  // summary object from /ledger/list

  $effect(() => { daemon.boot(); });

  async function openPath(path) {
    try {
      const url = await daemon.open(path);
      window.open(url, "_blank");
    } catch {}
  }

  function showDetails(w) {
    activeWorkbook = w;
    view = "details";
  }
  function showHome() {
    view = "home";
    activeWorkbook = null;
  }
  function pickById(id) {
    const target = daemon.workbooks.find((w) => w.workbook_id === id);
    if (target) showDetails(target);
  }
</script>

<Titlebar onBack={view === "details" ? showHome : null} />

{#if daemon.status === "loading"}
  <main class="empty"><div class="loader">connecting…</div></main>
{:else if daemon.status === "no-daemon"}
  <EmptyState
    title="Daemon offline"
    body={["Open a .workbook.html from Finder to wake the daemon, or reinstall via the latest .pkg."]}
    action={{ label: "Retry", onClick: () => daemon.boot() }}
  />
{:else if daemon.workbooks.length === 0}
  <EmptyState
    title="Nothing yet"
    body={["Open any .workbook.html and it'll show up here."]}
  />
{:else if view === "details" && activeWorkbook}
  <DetailsView
    summary={activeWorkbook}
    {openPath}
    fetchHistory={(id) => daemon.history(id)}
    onPickById={pickById}
    onBack={showHome}
  />
{:else}
  <WorkbookList
    workbooks={daemon.workbooks}
    onPick={showDetails}
    onOpenLatest={openPath}
    onRefresh={() => daemon.refresh()}
  />
{/if}

<style>
  main.empty {
    flex: 1 1 auto;
    display: flex; align-items: center; justify-content: center;
  }
  .loader {
    color: var(--fg-faint);
    font-size: 12px;
  }
</style>
