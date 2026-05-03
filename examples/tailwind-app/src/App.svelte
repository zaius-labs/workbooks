<script>
  import Sidebar from "./components/Sidebar.svelte";
  import MetricCard from "./components/MetricCard.svelte";
  import DataTable from "./components/DataTable.svelte";
  import { query } from "./lib/data.js";

  // Filter state — bound from Sidebar.
  let region = $state("all");
  let threshold = $state(0.25);

  // Reactive query — re-runs when region or threshold change. We
  // hold both result + loading state so the UI can show a spinner
  // on first load and stay readable during subsequent reruns.
  let rows = $state([]);
  let metrics = $state(null);
  let error = $state("");
  let loading = $state(false);

  $effect(() => {
    const r = region;
    const t = threshold;
    runQueries(r, t);
  });

  async function runQueries(r, t) {
    loading = true;
    error = "";
    try {
      const where = [];
      if (r !== "all") where.push(`region = '${r}'`);
      where.push(`churn <= ${t}`);
      const whereClause = `WHERE ${where.join(" AND ")}`;

      const [detail, summary] = await Promise.all([
        query(`SELECT region, segment, revenue, churn, customers FROM data ${whereClause} ORDER BY revenue DESC`),
        query(`SELECT SUM(revenue) AS total_revenue, AVG(churn) AS avg_churn, SUM(customers) AS total_customers FROM data ${whereClause}`),
      ]);
      rows = detail;
      metrics = summary[0] ?? null;
    } catch (e) {
      error = e?.message ?? String(e);
      rows = [];
      metrics = null;
    } finally {
      loading = false;
    }
  }

  function fmtMoney(n) {
    if (n == null) return "—";
    return "$" + Math.round(n).toLocaleString();
  }
  function fmtPct(n) {
    if (n == null) return "—";
    return (n * 100).toFixed(1) + "%";
  }
</script>

<div class="grid grid-cols-[auto_1fr] min-h-screen">
  <Sidebar bind:region bind:threshold />

  <main class="p-8 overflow-y-auto">
    <header class="flex items-baseline gap-3 mb-6">
      <h1 class="text-xl font-semibold">Customer revenue dashboard</h1>
      <span class="text-xs text-fg-muted font-mono">
        wasm · polars · tailwind
      </span>
    </header>

    {#if error}
      <div class="border-2 border-fg p-4 mb-6 font-mono text-sm whitespace-pre-wrap">
        {error}
      </div>
    {/if}

    <section class="grid grid-cols-3 gap-4 mb-6">
      <MetricCard
        label="total revenue"
        value={loading && !metrics ? "…" : fmtMoney(metrics?.total_revenue)}
        sublabel={metrics?.total_revenue != null ? "matched rows" : ""}
      />
      <MetricCard
        label="avg churn"
        value={loading && !metrics ? "…" : fmtPct(metrics?.avg_churn)}
        sublabel="across matched rows"
      />
      <MetricCard
        label="customers"
        value={loading && !metrics ? "…" : (metrics?.total_customers ?? 0).toLocaleString()}
        sublabel="in selection"
      />
    </section>

    <section>
      <div class="text-[11px] uppercase tracking-wider text-fg-muted font-mono mb-2">
        rows
      </div>
      <DataTable {rows} />
    </section>

    <footer class="mt-8 pt-4 border-t border-border text-xs text-fg-muted font-mono">
      Built with @work.books/cli + @tailwindcss/vite. Same .html
      format as svelte-app, notebook-agent, chat-app — different CSS
      authoring style.
    </footer>
  </main>
</div>
