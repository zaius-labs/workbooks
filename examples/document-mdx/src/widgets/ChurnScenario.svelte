<!--
  ChurnScenario — an interactive widget embedded in a document workbook.

  A widget is "an SPA at component scale". Same authoring model as the
  app-shape exemplars (svelte-app, tailwind-app), just narrower in scope:
  it lives inside another workbook's flow, takes its own state, runs in
  the same wasm runtime as the surrounding document.

  This widget runs a Polars query on every input change (the wasm
  runtime is already loaded by the parent document, so it's cheap),
  letting the reader explore "what if starter-tier churn dropped by X%?"
  without leaving the page.
-->
<script>
  import { onMount } from "svelte";

  let reduction = $state(0.5);              // fraction (0..1) of churn we eliminate
  let result = $state(null);
  let loading = $state(true);
  let error = $state("");

  // Pull the runtime once on mount — same wasm instance the
  // surrounding document uses; no second cold start.
  let runtime = $state(null);
  onMount(async () => {
    try {
      const { loadRuntime } = await import("virtual:workbook-runtime");
      runtime = await loadRuntime();
    } catch (e) {
      error = e?.message ?? String(e);
    } finally {
      loading = false;
    }
  });

  // Re-run the projection when reduction changes (or once runtime loads).
  $effect(() => {
    if (!runtime) return;
    void reduction;
    runProjection();
  });

  async function runProjection() {
    try {
      // Pull the customers CSV from the document's <wb-input> on the page —
      // same data the prose queries above use. Falls back to inline if
      // the input isn't there (running this widget standalone).
      const inputEl = document.querySelector('wb-input[name="customers"]');
      const csv = inputEl?.getAttribute("default") ?? FALLBACK_CSV;
      const sql = `
        SELECT region, segment,
               revenue,
               churn,
               ROUND(revenue * churn,                    2) AS lost_today,
               ROUND(revenue * churn * (1 - ${reduction}), 2) AS lost_with_intervention,
               ROUND(revenue * churn * ${reduction},     2) AS recovered
        FROM data
        WHERE churn > 0.10
        ORDER BY recovered DESC
      `;
      const outputs = runtime.wasm.runPolarsSql(sql, csv);
      const csvOut = outputs.find((o) => o.kind === "text" && o.mime_type === "text/csv");
      if (!csvOut) {
        const err = outputs.find((o) => o.kind === "error");
        throw new Error(err?.message ?? "no CSV output");
      }
      result = parseCsv(csvOut.content);
    } catch (e) {
      error = e?.message ?? String(e);
    }
  }

  let totalRecovered = $derived(
    result ? result.reduce((sum, row) => sum + (Number(row.recovered) || 0), 0) : 0,
  );

  function parseCsv(s) {
    const lines = s.trim().split("\n");
    const head = lines[0].split(",");
    return lines.slice(1).map((line) => {
      const cells = line.split(",");
      const row = {};
      head.forEach((k, i) => row[k] = cells[i]);
      return row;
    });
  }
  function fmtMoney(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return "$" + Math.round(v).toLocaleString();
  }

  const FALLBACK_CSV = "";  // production widgets keep their own data
</script>

<div class="widget">
  <div class="head">
    <span class="kind">widget · scenario</span>
    <span class="title">Churn-reduction calculator</span>
  </div>

  <div class="body">
    <label class="control">
      <span class="lbl">Reduce starter-tier churn by</span>
      <span class="val">{Math.round(reduction * 100)}%</span>
      <input
        type="range"
        min="0" max="1" step="0.05"
        bind:value={reduction}
      />
    </label>

    {#if loading}
      <div class="muted">loading runtime…</div>
    {:else if error}
      <div class="err">{error}</div>
    {:else if result}
      <div class="summary">
        Recovered revenue per period: <strong>{fmtMoney(totalRecovered)}</strong>
        {#if reduction > 0}
          · annualized: <strong>{fmtMoney(totalRecovered * 4)}</strong>
        {/if}
      </div>
      <table>
        <thead>
          <tr>
            <th>region</th><th>segment</th>
            <th class="num">today</th>
            <th class="num">with intervention</th>
            <th class="num">recovered</th>
          </tr>
        </thead>
        <tbody>
          {#each result as row, i (i)}
            <tr>
              <td>{row.region}</td>
              <td>{row.segment}</td>
              <td class="num">{fmtMoney(row.lost_today)}</td>
              <td class="num">{fmtMoney(row.lost_with_intervention)}</td>
              <td class="num strong">{fmtMoney(row.recovered)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>

<style>
  .widget {
    margin: 24px 0;
    border: 1px solid #d6d6d6; border-radius: 6px;
    background: #fff; overflow: hidden;
    font-family: -apple-system, "SF Pro Text", "Inter", system-ui, sans-serif;
  }
  .head {
    padding: 8px 14px; border-bottom: 1px solid #e5e5e5;
    background: #f5f5f5;
    display: flex; align-items: baseline; gap: 12px;
  }
  .kind {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 11px; color: #707070;
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .title { font-size: 14px; font-weight: 600; color: #0a0a0a; }
  .body { padding: 16px; display: grid; gap: 12px; }

  .control {
    display: grid; grid-template-columns: 1fr auto; row-gap: 6px;
    align-items: baseline;
  }
  .lbl { font-size: 13px; color: #2a2a2a; }
  .val {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 13px; color: #0a0a0a; font-weight: 600;
  }
  .control input[type="range"] {
    grid-column: 1 / -1; accent-color: #0a0a0a;
  }

  .summary {
    font-size: 14px; padding: 8px 12px;
    background: #f5f5f5; border-radius: 4px;
  }
  .summary strong { font-weight: 600; color: #0a0a0a; }

  table { border-collapse: collapse; font-size: 13px; }
  th, td { border: 1px solid #e5e5e5; padding: 4px 10px; text-align: left; }
  th { background: #f5f5f5; font-weight: 600; font-size: 12px; color: #2a2a2a; }
  td.num { text-align: right; font-feature-settings: "tnum"; font-family: "JetBrains Mono", ui-monospace, monospace; }
  td.num.strong { color: #0a0a0a; font-weight: 600; }

  .muted { color: #707070; font-size: 13px; }
  .err { color: #0a0a0a; font-weight: 600; padding: 8px 12px; border: 2px solid #0a0a0a; border-radius: 4px; }
</style>
