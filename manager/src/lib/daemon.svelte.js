// Daemon connection store. Uses Tauri's invoke() to discover
// the daemon's port (read from runtime.json), then plain fetch()
// for everything else — same wire the served-workbook pages
// already use, no IPC layer to maintain.

import { invoke } from "@tauri-apps/api/core";

function makeStore() {
  /** @type {{
   *   status: "loading" | "ok" | "no-daemon",
   *   url: string | null,
   *   workbooks: Array<any>,
   *   error: string | null,
   * }} */
  const state = $state({
    status: "loading",
    url: null,
    workbooks: [],
    error: null,
  });

  async function boot() {
    state.status = "loading";
    state.error = null;
    try {
      const url = await invoke("daemon_url");
      if (!url) {
        state.status = "no-daemon";
        return;
      }
      // Sanity check — the runtime.json could be stale (daemon
      // crashed without cleanup). Probe /health.
      const probe = await fetch(`${url}/health`, { cache: "no-store" });
      if (!probe.ok) throw new Error(`health: HTTP ${probe.status}`);
      state.url = url;
      await refresh();
      state.status = "ok";
    } catch (e) {
      state.status = "no-daemon";
      state.error = e?.message ?? String(e);
    }
  }

  async function refresh() {
    if (!state.url) return;
    try {
      const r = await fetch(`${state.url}/ledger/list`);
      if (!r.ok) throw new Error(`ledger/list: HTTP ${r.status}`);
      const j = await r.json();
      state.workbooks = j.workbooks ?? [];
    } catch (e) {
      state.error = e?.message ?? String(e);
    }
  }

  /** Per-workbook drill-in: full edit log + saves[]. */
  async function history(workbookId) {
    if (!state.url) return null;
    const r = await fetch(`${state.url}/ledger/${encodeURIComponent(workbookId)}`);
    if (!r.ok) return null;
    const j = await r.json();
    return j.history ?? null;
  }

  /** Mint a session URL for a path so "Open" can navigate to it. */
  async function open(path) {
    if (!state.url) throw new Error("daemon not connected");
    const r = await fetch(`${state.url}/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!r.ok) throw new Error(`open: HTTP ${r.status}`);
    const j = await r.json();
    return j.url;
  }

  return {
    get status() { return state.status; },
    get url()    { return state.url; },
    get workbooks() { return state.workbooks; },
    get error()  { return state.error; },
    boot, refresh, history, open,
  };
}

export const daemon = makeStore();
