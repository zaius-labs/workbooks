// Stocks notebook — reactive Polars SQL cells + vanilla K-means + D3 scatter.
//
// Bundled OHLC snapshot from Yahoo Finance (10 tickers × ~252 days).
// Each "cell" has:
//   - editable source (textarea)
//   - Run button + ⌘↵ keybind
//   - rendered output (table, chart, summary cards, etc.)
// Cell 3 (cluster) and cell 4 (chart) reuse the result of cell 2;
// running cell 2 invalidates downstream so the user can see the chain.

import { loadRuntime } from "virtual:workbook-runtime";
import * as d3 from "d3";
import { mountSettings } from "../_shared/settings.js";
import pricesCsvText from "./prices.csv?raw";

const els = {
  meta: document.getElementById("meta"),
  chips: document.getElementById("chips"),
  pickerCount: document.getElementById("picker-count"),
  out: {
    load: document.getElementById("out-load"),
    stats: document.getElementById("out-stats"),
    drawdown: document.getElementById("out-drawdown"),
    corr: document.getElementById("out-corr"),
    cluster: document.getElementById("out-cluster"),
    chart: document.getElementById("out-chart"),
    equity: document.getElementById("out-equity"),
  },
  src: {
    load: document.getElementById("src-load"),
    stats: document.getElementById("src-stats"),
  },
};

// Selection state — every cell respects the current ticker set.
const allTickers = []; // populated once from prices.csv, grows on add
const selectedTickers = new Set();
// All rows currently in the dataset, keyed by ticker. We rebuild the
// IPC bytes from this map every time the universe changes.
const tickerRows = new Map();
// Tickers we've fetched on-the-fly so we can offer a "remove" action.
const userAddedTickers = new Set();

let runtime;
let pricesCsv;
let lastStats = null; // results from cell 2 — feeds drawdown/corr/cluster
let lastDrawdown = null; // results from cell 3 — feeds cluster
let lastClusters = null; // results from cell 5 — feeds chart

function placeholder(host, msg) {
  host.classList.add("empty");
  host.textContent = msg;
}

function renderTable(host, rows, opts = {}) {
  host.classList.remove("empty");
  host.innerHTML = "";
  if (!rows || rows.length === 0) {
    placeholder(host, "(no rows)");
    return;
  }
  const cols = Object.keys(rows[0]);
  const numericCols = new Set(opts.numericCols ?? []);
  const colorCols = new Set(opts.colorCols ?? []);
  const fmt = opts.fmt ?? {};
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const trH = document.createElement("tr");
  for (const c of cols) {
    const th = document.createElement("th");
    th.textContent = c;
    trH.appendChild(th);
  }
  thead.appendChild(trH);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const row of rows.slice(0, opts.limit ?? 100)) {
    const tr = document.createElement("tr");
    for (const c of cols) {
      const td = document.createElement("td");
      const v = row[c];
      const isNum = numericCols.has(c) || (typeof v === "number" && Number.isFinite(v));
      if (isNum) {
        td.classList.add("num");
        if (colorCols.has(c) && typeof v === "number" && Number.isFinite(v)) {
          if (v > 0) td.classList.add("pos");
          else if (v < 0) td.classList.add("neg");
        }
        td.textContent = fmt[c] ? fmt[c](v) : (typeof v === "number" ? v.toFixed(4) : String(v ?? ""));
      } else {
        td.textContent = v == null ? "" : String(v);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
  if (rows.length > (opts.limit ?? 100)) {
    const note = document.createElement("div");
    note.className = "timing";
    note.textContent = `… ${rows.length - (opts.limit ?? 100)} more rows truncated`;
    host.appendChild(note);
  }
}

function renderError(host, err) {
  host.classList.remove("empty");
  host.innerHTML = "";
  const div = document.createElement("div");
  div.className = "err";
  div.textContent = err instanceof Error ? err.message : String(err);
  host.appendChild(div);
}

/**
 * Run a Polars SQL string against a single registered table.
 * The runtime returns CSV text in an outputs array — d3.csvParse + autoType
 * gives us properly typed row objects.
 */
function runSql(sql, tableName, ipcBytes) {
  const t0 = performance.now();
  const result = runtime.wasm.runPolarsSqlIpc(sql, { [tableName]: ipcBytes });
  const ms = performance.now() - t0;
  if (!Array.isArray(result)) {
    throw new Error("unexpected polars output shape");
  }
  const csvOut = result.find(
    (o) => o?.kind === "text" && (o?.mime_type === "text/csv" || o?.mime_type?.startsWith("text/csv")),
  );
  if (!csvOut?.content) {
    return { rows: [], ms };
  }
  return { rows: d3.csvParse(csvOut.content, d3.autoType), ms };
}

/**
 * Inject a `ticker IN (...)` predicate into a SQL string so cell
 * results respect the chip selection. We splice it into the
 * outermost WHERE clause if one exists, otherwise add a new WHERE
 * directly after the FROM. Ticker values are SQL-quoted strings —
 * the chip values are validated kebab-case symbols, no injection
 * surface, but quote them anyway for hygiene.
 */
function injectTickerFilter(sql, tickers) {
  if (!tickers || tickers.length === 0) {
    // Empty selection — return a query that yields zero rows so the
    // cells render an empty state instead of misleading "everything"
    // results.
    return sql.replace(/FROM\s+prices/i, "FROM prices WHERE 1 = 0");
  }
  const list = tickers.map((t) => `'${String(t).replace(/'/g, "''")}'`).join(", ");
  // Match the outermost FROM prices [optional alias] [optional first WHERE].
  // If there's already a WHERE, inject `ticker IN (...) AND ` after it.
  const withWhere = /(FROM\s+prices\b[^()]*?\bWHERE\s+)/i;
  if (withWhere.test(sql)) {
    return sql.replace(withWhere, `$1ticker IN (${list}) AND `);
  }
  // Otherwise inject a fresh WHERE after FROM prices.
  return sql.replace(/(FROM\s+prices\b)/i, `$1 WHERE ticker IN (${list})`);
}

/**
 * Convert the bundled CSV to Arrow IPC bytes that runPolarsSqlIpc
 * accepts. tableFromArrays dictionary-encodes string columns by
 * default, but the polars-wasm runtime is built WITHOUT
 * `dtype-categorical`, so dictionary inputs panic with "activate
 * dtype-categorical to convert dictionary arrays". Force string
 * columns to plain Utf8 by constructing Vectors with explicit type.
 */
/**
 * Bootstrap: parse the bundled CSV, populate tickerRows map.
 */
async function loadInitialRows(csv) {
  const rows = d3.csvParse(csv, d3.autoType);
  for (const r of rows) {
    const t = String(r.ticker ?? "");
    if (!t) continue;
    if (!tickerRows.has(t)) tickerRows.set(t, []);
    tickerRows.get(t).push({
      date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date ?? ""),
      open: Number(r.open) || 0,
      high: Number(r.high) || 0,
      low: Number(r.low) || 0,
      close: Number(r.close) || 0,
      volume: Number(r.volume) || 0,
    });
  }
  // Stable date sort within each ticker.
  for (const [, arr] of tickerRows) arr.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Build Arrow IPC bytes from the current tickerRows map. Includes
 * the precomputed `daily_return` column. Re-run any time the universe
 * changes (ticker added/removed).
 */
async function rebuildIpc() {
  const arrow = await import("apache-arrow");

  // Build per-ticker arrays so we can drop the first row (no prev close
  // → daily_return is undefined). Polars wasm doesn't reliably filter
  // NaN values via SQL, and apache-arrow's tableFromArrays can't
  // produce null-typed Float64 columns from Float64Array. Dropping
  // the first row per ticker is the simplest path to a clean schema:
  // every row has a valid daily_return and SQL aggregations Just Work.
  const flat = [];
  for (const ticker of [...tickerRows.keys()].sort()) {
    const rows = tickerRows.get(ticker) ?? [];
    if (rows.length < 2) continue;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const prev = rows[i - 1];
      if (!prev.close || !r.close) continue;
      flat.push({
        ticker,
        ...r,
        daily_return: (r.close - prev.close) / prev.close,
      });
    }
  }

  if (flat.length === 0) {
    // Empty dataset still needs a valid schema; emit an empty table.
    const empty = arrow.tableFromArrays({
      ticker: arrow.vectorFromArray([], new arrow.Utf8()),
      date: arrow.vectorFromArray([], new arrow.Utf8()),
      open: new Float64Array(0),
      high: new Float64Array(0),
      low: new Float64Array(0),
      close: new Float64Array(0),
      volume: new BigInt64Array(0),
      daily_return: new Float64Array(0),
    });
    return arrow.tableToIPC(empty, "stream");
  }

  const tickerVec = arrow.vectorFromArray(flat.map((r) => r.ticker), new arrow.Utf8());
  const dateVec = arrow.vectorFromArray(flat.map((r) => r.date), new arrow.Utf8());
  const table = arrow.tableFromArrays({
    ticker: tickerVec,
    date: dateVec,
    open: Float64Array.from(flat.map((r) => r.open)),
    high: Float64Array.from(flat.map((r) => r.high)),
    low: Float64Array.from(flat.map((r) => r.low)),
    close: Float64Array.from(flat.map((r) => r.close)),
    volume: BigInt64Array.from(flat.map((r) => BigInt(Math.round(r.volume)))),
    daily_return: Float64Array.from(flat.map((r) => r.daily_return)),
  });
  return arrow.tableToIPC(table, "stream");
}

/* ------------------------------ K-means ------------------------------ */

function kmeans(points, k = 3, maxIter = 100) {
  if (points.length < k) return points.map((_, i) => i);
  // Z-score standardize so neither feature dominates.
  const dims = points[0].length;
  const mean = Array.from({ length: dims }, (_, d) =>
    points.reduce((s, p) => s + p[d], 0) / points.length,
  );
  const std = Array.from({ length: dims }, (_, d) => {
    const v = points.reduce((s, p) => s + (p[d] - mean[d]) ** 2, 0) / points.length;
    return Math.sqrt(v) || 1;
  });
  const Z = points.map((p) => p.map((v, d) => (v - mean[d]) / std[d]));

  // Init via k-means++.
  const centroids = [];
  centroids.push(Z[Math.floor(Math.random() * Z.length)]);
  while (centroids.length < k) {
    const dists = Z.map((p) => Math.min(...centroids.map((c) => sqDist(p, c))));
    const total = dists.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let pick = 0;
    for (let i = 0; i < dists.length; i++) {
      r -= dists[i];
      if (r <= 0) { pick = i; break; }
    }
    centroids.push(Z[pick]);
  }

  let assignments = new Array(Z.length).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    const newAssign = Z.map((p) => {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = sqDist(p, centroids[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      return best;
    });
    if (newAssign.every((v, i) => v === assignments[i])) break;
    assignments = newAssign;
    for (let c = 0; c < centroids.length; c++) {
      const members = Z.filter((_, i) => assignments[i] === c);
      if (members.length === 0) continue;
      centroids[c] = Array.from({ length: dims }, (_, d) =>
        members.reduce((s, p) => s + p[d], 0) / members.length,
      );
    }
  }
  return assignments;
}

function sqDist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return s;
}

/* ----------------------------- cell runners --------------------------- */

const RUNNERS = {
  "cell-load": () => {
    const sql = injectTickerFilter(els.src.load.value, [...selectedTickers]);
    const { rows, ms } = runSql(sql, "prices", pricesCsv.ipc);
    renderTable(els.out.load, rows, {
      limit: 50,
      numericCols: ["rows", "low", "high", "close", "volume", "daily_return"],
      colorCols: ["daily_return"],
      fmt: {
        rows: (v) => Number(v).toLocaleString(),
        low: (v) => Number(v).toFixed(2),
        high: (v) => Number(v).toFixed(2),
        close: (v) => Number(v).toFixed(2),
        volume: (v) => Number(v).toLocaleString(),
        daily_return: (v) => {
          const n = Number(v);
          return Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : "—";
        },
      },
    });
    appendTiming(els.out.load, rows.length, ms);
  },

  "cell-stats": () => {
    const sql = injectTickerFilter(els.src.stats.value, [...selectedTickers]);
    const { rows, ms } = runSql(sql, "prices", pricesCsv.ipc);
    lastStats = rows;
    lastDrawdown = null;
    lastClusters = null;
    placeholder(els.out.drawdown, "(re-run cell 3)");
    placeholder(els.out.corr, "(re-run cell 4)");
    placeholder(els.out.cluster, "(re-run cell 5)");
    placeholder(els.out.chart, "(re-run cell 6)");
    renderTable(els.out.stats, rows, {
      numericCols: ["days", "ann_return", "ann_vol", "sharpe"],
      colorCols: ["ann_return", "sharpe"],
      fmt: {
        ann_return: (v) => (v * 100).toFixed(1) + "%",
        ann_vol: (v) => (v * 100).toFixed(1) + "%",
        sharpe: (v) => Number(v).toFixed(2),
        days: (v) => String(v),
      },
    });
    appendTiming(els.out.stats, rows.length, ms);
  },

  "cell-drawdown": () => {
    if (!lastStats || lastStats.length === 0) {
      throw new Error("Run cell 2 first.");
    }
    const t0 = performance.now();
    const tickers = lastStats.map((r) => String(r.ticker));
    const out = [];
    for (const t of tickers) {
      const series = tickerRows.get(t);
      if (!series || series.length === 0) continue;
      const closes = series.map((r) => r.close).filter((v) => Number.isFinite(v) && v > 0);
      if (closes.length < 2) continue;
      let peak = closes[0];
      let maxDD = 0;
      let dDays = 0; // count of days where price < peak (i.e. underwater)
      for (const c of closes) {
        if (c > peak) peak = c;
        const dd = (c - peak) / peak; // ≤ 0
        if (dd < maxDD) maxDD = dd;
        if (c < peak) dDays += 1;
      }
      // Days since the all-time high (current "underwater" duration).
      let currentUnderwater = 0;
      const ath = Math.max(...closes);
      for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] >= ath) break;
        currentUnderwater += 1;
      }
      const last = closes[closes.length - 1];
      const fromAth = (last - ath) / ath; // ≤ 0
      out.push({
        ticker: t,
        max_dd: maxDD,
        from_ath: fromAth,
        days_underwater: currentUnderwater,
        days_below_peak: dDays,
      });
    }
    out.sort((a, b) => a.max_dd - b.max_dd); // worst (most negative) first
    lastDrawdown = out;
    placeholder(els.out.cluster, "(re-run cell 5)");
    placeholder(els.out.chart, "(re-run cell 6)");
    renderTable(els.out.drawdown, out, {
      numericCols: ["max_dd", "from_ath", "days_underwater", "days_below_peak"],
      colorCols: ["max_dd", "from_ath"],
      fmt: {
        max_dd: (v) => (v * 100).toFixed(1) + "%",
        from_ath: (v) => (v * 100).toFixed(1) + "%",
        days_underwater: (v) => String(v),
        days_below_peak: (v) => String(v),
      },
    });
    appendTiming(els.out.drawdown, out.length, performance.now() - t0);
  },

  "cell-corr": () => {
    if (!lastStats || lastStats.length === 0) {
      throw new Error("Run cell 2 first.");
    }
    renderCorrelationHeatmap(els.out.corr);
  },

  "cell-cluster": () => {
    if (!lastStats || lastStats.length === 0) {
      throw new Error("Run cell 2 first.");
    }
    if (!lastDrawdown) {
      throw new Error("Run cell 3 (drawdown) first.");
    }
    // Build a richer feature vector: [ann_return, ann_vol, sharpe, max_dd]
    const ddByTicker = new Map(lastDrawdown.map((r) => [r.ticker, r]));
    const usable = lastStats
      .filter((r) => Number.isFinite(Number(r.ann_return)))
      .map((r) => {
        const dd = ddByTicker.get(String(r.ticker));
        return {
          ticker: String(r.ticker),
          ann_return: Number(r.ann_return),
          ann_vol: Number(r.ann_vol),
          sharpe: Number.isFinite(Number(r.sharpe)) ? Number(r.sharpe) : 0,
          max_dd: dd ? Number(dd.max_dd) : -1,
        };
      });
    if (usable.length < 3) {
      throw new Error("Need at least 3 coins with valid stats to cluster.");
    }
    const points = usable.map((r) => [r.ann_return, r.ann_vol, r.sharpe, r.max_dd]);
    const k = Math.min(3, usable.length);
    const assignments = kmeans(points, k);

    // Order clusters by mean Sharpe descending so labels are stable.
    const sharpeByCluster = new Map();
    for (let i = 0; i < usable.length; i++) {
      const c = assignments[i];
      const arr = sharpeByCluster.get(c) ?? [];
      arr.push(usable[i].sharpe);
      sharpeByCluster.set(c, arr);
    }
    const clusterMean = (c) => {
      const arr = sharpeByCluster.get(c) ?? [0];
      return arr.reduce((a, b) => a + b, 0) / arr.length;
    };
    const sorted = [...new Set(assignments)].sort((a, b) => clusterMean(b) - clusterMean(a));
    const remap = new Map(sorted.map((old, i) => [old, i]));
    const remapped = assignments.map((c) => remap.get(c));

    lastClusters = usable.map((r, i) => ({
      ...r,
      cluster: remapped[i],
    }));

    const labels = ["Aggressive growth", "Balanced", "Defensive"];
    const summary = document.createElement("div");
    summary.className = "cluster-summary";
    for (let i = 0; i < 3; i++) {
      const card = document.createElement("div");
      card.className = `cluster-card c${i}`;
      const lbl = document.createElement("p");
      lbl.className = "cluster-label";
      lbl.textContent = labels[i] ?? `Cluster ${i}`;
      const tk = document.createElement("div");
      tk.className = "cluster-tickers";
      const members = lastClusters.filter((r) => r.cluster === i).map((r) => r.ticker);
      tk.textContent = members.length ? members.join(" · ") : "—";
      card.appendChild(lbl);
      card.appendChild(tk);
      summary.appendChild(card);
    }
    els.out.cluster.classList.remove("empty");
    els.out.cluster.innerHTML = "";
    els.out.cluster.appendChild(summary);
  },

  "cell-chart": () => {
    if (!lastClusters) {
      throw new Error("Run cell 5 first.");
    }
    renderScatter(els.out.chart, lastClusters);
  },

  "cell-equity": () => {
    renderEquityCurves(els.out.equity);
  },
};

function renderScatter(host, rows) {
  host.classList.remove("empty");
  host.innerHTML = "";
  const w = host.clientWidth;
  const h = 380;
  const m = { top: 24, right: 32, bottom: 44, left: 64 };

  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${w} ${h}`);

  const x = d3
    .scaleLinear()
    .domain(d3.extent(rows, (r) => r.ann_vol)).nice()
    .range([m.left, w - m.right]);
  const y = d3
    .scaleLinear()
    .domain(d3.extent(rows, (r) => r.ann_return)).nice()
    .range([h - m.bottom, m.top]);

  const colors = ["var(--c0)", "var(--c1)", "var(--c2)"];

  // Axes.
  svg
    .append("g")
    .attr("transform", `translate(0,${h - m.bottom})`)
    .call(d3.axisBottom(x).ticks(6).tickFormat((v) => `${(v * 100).toFixed(0)}%`));
  svg
    .append("g")
    .attr("transform", `translate(${m.left},0)`)
    .call(d3.axisLeft(y).ticks(6).tickFormat((v) => `${(v * 100).toFixed(0)}%`));

  // Axis labels.
  svg
    .append("text")
    .attr("x", w - m.right)
    .attr("y", h - 8)
    .attr("text-anchor", "end")
    .attr("font-family", "var(--sans)")
    .attr("font-size", "11px")
    .attr("fill", "#8a909c")
    .text("annualized volatility →");
  svg
    .append("text")
    .attr("transform", `translate(16,${m.top + 8}) rotate(-90)`)
    .attr("text-anchor", "end")
    .attr("font-family", "var(--sans)")
    .attr("font-size", "11px")
    .attr("fill", "#8a909c")
    .text("← annualized return");

  // Zero line on return axis (helps separate winners from losers).
  if (y.domain()[0] < 0 && y.domain()[1] > 0) {
    svg
      .append("line")
      .attr("x1", m.left)
      .attr("x2", w - m.right)
      .attr("y1", y(0))
      .attr("y2", y(0))
      .attr("stroke", "#c5cad0")
      .attr("stroke-dasharray", "3 3");
  }

  // Dots.
  svg
    .append("g")
    .selectAll("circle")
    .data(rows)
    .join("circle")
    .attr("cx", (r) => x(r.ann_vol))
    .attr("cy", (r) => y(r.ann_return))
    .attr("r", 7)
    .attr("fill", (r) => colors[r.cluster] ?? "#8a909c")
    .attr("fill-opacity", 0.85)
    .attr("stroke", "white")
    .attr("stroke-width", 1.5);

  // Labels.
  svg
    .append("g")
    .attr("font-family", "var(--mono)")
    .attr("font-size", "11px")
    .attr("fill", "#0f1115")
    .selectAll("text")
    .data(rows)
    .join("text")
    .attr("x", (r) => x(r.ann_vol) + 11)
    .attr("y", (r) => y(r.ann_return) + 4)
    .text((r) => r.ticker);

  // Legend.
  const legend = document.createElement("div");
  legend.className = "legend";
  for (const [i, label] of ["Aggressive growth", "Balanced", "Defensive"].entries()) {
    const item = document.createElement("div");
    item.className = "legend-item";
    const dot = document.createElement("span");
    dot.className = "legend-dot";
    dot.style.background = colors[i];
    item.appendChild(dot);
    item.appendChild(document.createTextNode(label));
    legend.appendChild(item);
  }
  host.appendChild(legend);
}

function appendTiming(host, rowCount, ms) {
  const div = document.createElement("div");
  div.className = "timing";
  div.textContent = `${rowCount.toLocaleString()} rows · ${ms.toFixed(1)} ms`;
  host.appendChild(div);
}

/**
 * Pearson correlation matrix of daily returns. Aligns each ticker's
 * series by date so missing days don't bias the result. Renders as
 * a small heatmap in pure SVG.
 */
function renderCorrelationHeatmap(host) {
  host.classList.remove("empty");
  host.innerHTML = "";

  const tickers = [...selectedTickers].filter((t) => tickerRows.has(t)).sort();
  if (tickers.length < 2) {
    placeholder(host, "Need at least 2 coins to compute correlations.");
    return;
  }

  // Build a {date → {ticker → close}} map, then compute returns aligned by date.
  const byDate = new Map();
  for (const t of tickers) {
    for (const r of tickerRows.get(t)) {
      if (!byDate.has(r.date)) byDate.set(r.date, {});
      byDate.get(r.date)[t] = r.close;
    }
  }
  const dates = [...byDate.keys()].sort();
  // Daily-return per ticker, only for dates where ALL tickers have a price.
  const returns = new Map(tickers.map((t) => [t, []]));
  let prevValid = null;
  for (const d of dates) {
    const row = byDate.get(d);
    if (!tickers.every((t) => Number.isFinite(row[t]) && row[t] > 0)) continue;
    if (prevValid) {
      const prev = byDate.get(prevValid);
      for (const t of tickers) {
        returns.get(t).push((row[t] - prev[t]) / prev[t]);
      }
    }
    prevValid = d;
  }
  const n = returns.get(tickers[0])?.length ?? 0;
  if (n < 2) {
    placeholder(host, "Not enough overlapping days across coins.");
    return;
  }

  // Pearson correlation between every pair.
  const corr = tickers.map(() => tickers.map(() => 0));
  const means = tickers.map((t) => mean(returns.get(t)));
  const stds = tickers.map((t, i) => stdDev(returns.get(t), means[i]));
  for (let i = 0; i < tickers.length; i++) {
    for (let j = i; j < tickers.length; j++) {
      const a = returns.get(tickers[i]);
      const b = returns.get(tickers[j]);
      let s = 0;
      for (let k = 0; k < n; k++) s += (a[k] - means[i]) * (b[k] - means[j]);
      const c = stds[i] === 0 || stds[j] === 0 ? 0 : s / n / (stds[i] * stds[j]);
      corr[i][j] = c;
      corr[j][i] = c;
    }
  }

  // Render as SVG heatmap with labels.
  const wHost = host.clientWidth || 720;
  const cellSz = Math.min(56, Math.max(28, Math.floor((wHost - 100) / tickers.length)));
  const margin = { top: 16, right: 16, bottom: 56, left: 64 };
  const w = margin.left + cellSz * tickers.length + margin.right;
  const h = margin.top + cellSz * tickers.length + margin.bottom;

  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${w} ${h}`);
  // Diverging blue→white→red so 0 is white, +1 red, -1 blue.
  const color = d3.scaleSequential(d3.interpolateRdBu).domain([1, -1]);

  for (let i = 0; i < tickers.length; i++) {
    for (let j = 0; j < tickers.length; j++) {
      const x = margin.left + j * cellSz;
      const y = margin.top + i * cellSz;
      svg
        .append("rect")
        .attr("x", x)
        .attr("y", y)
        .attr("width", cellSz)
        .attr("height", cellSz)
        .attr("fill", color(corr[i][j]))
        .attr("stroke", "white")
        .attr("stroke-width", 1)
        .append("title")
        .text(`${tickers[i]} ↔ ${tickers[j]}: ${corr[i][j].toFixed(2)}`);
      if (cellSz >= 38) {
        svg
          .append("text")
          .attr("x", x + cellSz / 2)
          .attr("y", y + cellSz / 2 + 4)
          .attr("text-anchor", "middle")
          .attr("font-family", "ui-monospace, Menlo, monospace")
          .attr("font-size", "11px")
          .attr("fill", Math.abs(corr[i][j]) > 0.55 ? "white" : "#0f1115")
          .text(corr[i][j].toFixed(2));
      }
    }
  }
  // Row labels.
  for (let i = 0; i < tickers.length; i++) {
    svg
      .append("text")
      .attr("x", margin.left - 8)
      .attr("y", margin.top + i * cellSz + cellSz / 2 + 4)
      .attr("text-anchor", "end")
      .attr("font-family", "ui-monospace, Menlo, monospace")
      .attr("font-size", "11px")
      .attr("font-weight", "600")
      .attr("fill", "#0f1115")
      .text(tickers[i]);
  }
  // Column labels (rotated).
  for (let j = 0; j < tickers.length; j++) {
    const cx = margin.left + j * cellSz + cellSz / 2;
    const cy = margin.top + cellSz * tickers.length + 14;
    svg
      .append("text")
      .attr("transform", `translate(${cx},${cy}) rotate(45)`)
      .attr("text-anchor", "start")
      .attr("font-family", "ui-monospace, Menlo, monospace")
      .attr("font-size", "11px")
      .attr("font-weight", "600")
      .attr("fill", "#0f1115")
      .text(tickers[j]);
  }
}

function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}
function stdDev(arr, mu) {
  if (!arr.length) return 0;
  let s = 0;
  for (const v of arr) s += (v - mu) ** 2;
  return Math.sqrt(s / arr.length);
}

/**
 * Cumulative-return equity curves on a log-scaled y axis. Each line is
 * the running product of (1 + daily_return) starting at 1 — so the y
 * value at any point is "what $1 invested at day 0 would be worth."
 */
function renderEquityCurves(host) {
  host.classList.remove("empty");
  host.innerHTML = "";
  const tickers = [...selectedTickers].filter((t) => tickerRows.has(t)).sort();
  if (tickers.length === 0) {
    placeholder(host, "Add coins above to see equity curves.");
    return;
  }

  // Build (date, multiple) per ticker.
  const series = tickers.map((t) => {
    const rows = tickerRows.get(t);
    if (!rows || rows.length < 2) return { ticker: t, points: [] };
    const base = rows[0].close;
    if (!base) return { ticker: t, points: [] };
    return {
      ticker: t,
      points: rows.map((r) => ({
        date: new Date(r.date),
        mult: r.close / base,
      })),
    };
  }).filter((s) => s.points.length > 0);
  if (series.length === 0) {
    placeholder(host, "No usable price data.");
    return;
  }

  const wHost = host.clientWidth || 720;
  const w = wHost;
  const h = 380;
  const m = { top: 24, right: 110, bottom: 36, left: 56 };

  const allPoints = series.flatMap((s) => s.points);
  const x = d3
    .scaleTime()
    .domain(d3.extent(allPoints, (p) => p.date))
    .range([m.left, w - m.right]);
  const yMin = Math.max(0.05, d3.min(allPoints, (p) => p.mult));
  const yMax = Math.max(2, d3.max(allPoints, (p) => p.mult));
  const y = d3.scaleLog().domain([yMin, yMax]).nice().range([h - m.bottom, m.top]);

  const palette = d3.schemeTableau10;
  const colorOf = (i) => palette[i % palette.length];

  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${w} ${h}`);

  // Axes.
  svg
    .append("g")
    .attr("transform", `translate(0,${h - m.bottom})`)
    .call(d3.axisBottom(x).ticks(6));
  svg
    .append("g")
    .attr("transform", `translate(${m.left},0)`)
    .call(d3.axisLeft(y).ticks(5, "~s").tickFormat((v) => `${v}×`));

  // 1× reference line.
  if (yMin < 1 && yMax > 1) {
    svg
      .append("line")
      .attr("x1", m.left)
      .attr("x2", w - m.right)
      .attr("y1", y(1))
      .attr("y2", y(1))
      .attr("stroke", "#c5cad0")
      .attr("stroke-dasharray", "3 3");
  }

  // Lines.
  const line = d3
    .line()
    .x((p) => x(p.date))
    .y((p) => y(p.mult));
  series.forEach((s, i) => {
    svg
      .append("path")
      .attr("fill", "none")
      .attr("stroke", colorOf(i))
      .attr("stroke-width", 1.6)
      .attr("opacity", 0.85)
      .attr("d", line(s.points));
    // Right-edge label.
    const last = s.points[s.points.length - 1];
    svg
      .append("text")
      .attr("x", w - m.right + 8)
      .attr("y", y(last.mult) + 4)
      .attr("font-family", "ui-monospace, Menlo, monospace")
      .attr("font-size", "11px")
      .attr("font-weight", "600")
      .attr("fill", colorOf(i))
      .text(`${s.ticker} ${last.mult.toFixed(2)}×`);
  });
}

/* -------------------------------- boot -------------------------------- */

function renderChips() {
  els.chips.innerHTML = "";
  for (const t of allTickers) {
    const chip = document.createElement("button");
    chip.className = "chip" + (selectedTickers.has(t) ? " is-on" : "");
    chip.dataset.ticker = t;
    chip.setAttribute("aria-pressed", String(selectedTickers.has(t)));
    chip.appendChild(document.createTextNode(t));
    if (userAddedTickers.has(t)) {
      const x = document.createElement("span");
      x.className = "chip-remove";
      x.dataset.removeTicker = t;
      x.title = "remove ticker";
      x.textContent = "×";
      chip.appendChild(x);
    }
    els.chips.appendChild(chip);
  }
  els.pickerCount.textContent = `${selectedTickers.size}/${allTickers.length} selected`;
}

function runAllCells() {
  for (const id of [
    "cell-load",
    "cell-stats",
    "cell-drawdown",
    "cell-corr",
    "cell-cluster",
    "cell-chart",
    "cell-equity",
  ]) {
    try {
      RUNNERS[id]();
    } catch (err) {
      const targetId = id.replace("cell-", "out-");
      const host = document.getElementById(targetId);
      if (host) renderError(host, err);
      console.error(id, err);
    }
  }
}

async function regenIpcAndRefresh() {
  pricesCsv = { ipc: await rebuildIpc() };
  allTickers.length = 0;
  for (const t of [...tickerRows.keys()].sort()) allTickers.push(t);
  for (const t of [...selectedTickers]) {
    if (!tickerRows.has(t)) selectedTickers.delete(t);
  }
  renderChips();
  updateMeta();
  if (allTickers.length === 0) {
    showEmptyState();
  } else {
    runAllCells();
  }
}

function updateMeta() {
  let totalRows = 0;
  for (const arr of tickerRows.values()) totalRows += arr.length;
  if (allTickers.length === 0) {
    els.meta.textContent =
      "Empty universe — search and click a coin above to start. Live data fetched from CoinGecko.";
  } else {
    els.meta.textContent =
      `${totalRows.toLocaleString()} rows · ${allTickers.length} coin${allTickers.length === 1 ? "" : "s"} · ` +
      `1y of daily prices, fetched live from CoinGecko.`;
  }
}

async function bootstrap() {
  els.meta.textContent = "loading runtime…";
  runtime = await loadRuntime();
  await loadInitialRows(pricesCsvText);
  for (const t of [...tickerRows.keys()].sort()) {
    allTickers.push(t);
    selectedTickers.add(t);
  }
  pricesCsv = { ipc: await rebuildIpc() };
  renderChips();
  updateMeta();
  setupSearch();
  // Auto-focus the search box so the empty state is actionable.
  if (allTickers.length === 0) {
    document.getElementById("ticker-search")?.focus();
    showEmptyState();
  } else {
    runAllCells();
  }
}

function showEmptyState() {
  for (const host of [
    els.out.load,
    els.out.stats,
    els.out.drawdown,
    els.out.corr,
    els.out.cluster,
    els.out.chart,
    els.out.equity,
  ]) {
    placeholder(host, "Add a coin above to see results.");
  }
}

/* ----------------------- CoinGecko integration ----------------------- */

// CoinGecko has native CORS support and the public endpoints don't
// require an API key — sign up for a Pro key only if you need higher
// rate limits (the optional key below routes through pro-api when
// present). Free tier: ~30 req/min, plenty for a notebook demo.
const CG_PUBLIC = "https://api.coingecko.com/api/v3";
const CG_PRO = "https://pro-api.coingecko.com/api/v3";

// We keep settings mounted (so the ⚙ button is visible and the panel
// pattern is consistent across showcase notebooks), but the only
// configurable thing here is an OPTIONAL Pro key — required:false so
// no banner shows up unprompted.
const settings = mountSettings({
  keys: [
    {
      id: "coingecko_pro",
      label: "CoinGecko Pro key (optional)",
      storageKey: "wb_stocks_cg_pro",
      signupUrl: "https://www.coingecko.com/en/api/pricing",
      hint: "Optional — only needed if you hit free-tier rate limits (~30 req/min). Stored in localStorage.",
      required: false,
    },
  ],
});

settings.onChange((id) => {
  if (id !== "coingecko_pro") return;
  // No reactive impact — next request just uses the new key/no key.
});

// In-session response cache. Same query → same answer for 2 minutes;
// cuts repeat searches to zero requests and softens the ~30 req/min
// free-tier limit. Keyed by full URL so chart and search don't collide.
const _cgCache = new Map();
const CG_CACHE_TTL_MS = 2 * 60 * 1000;

async function cgFetch(path, params, opts = {}) {
  const proKey = settings.get("coingecko_pro");
  const base = proKey ? CG_PRO : CG_PUBLIC;
  const u = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v != null) u.searchParams.set(k, String(v));
  }
  const cacheKey = u.toString();
  const cached = _cgCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.json;

  const headers = {};
  if (proKey) headers["x-cg-pro-api-key"] = proKey;
  const resp = await fetch(u.toString(), { headers, signal: opts.signal });
  if (resp.status === 429) {
    throw new Error(
      "Rate limit hit (429). CoinGecko free tier is ~30 req/min; wait a moment, or add a Pro key in ⚙.",
    );
  }
  if (!resp.ok) throw new Error(`CoinGecko: HTTP ${resp.status}`);
  const json = await resp.json();
  _cgCache.set(cacheKey, { json, expires: Date.now() + CG_CACHE_TTL_MS });
  return json;
}

let searchTimer;
let activeSearchAbort;

function setupSearch() {
  const input = document.getElementById("ticker-search");
  const dropdown = document.getElementById("search-dropdown");
  if (!input || !dropdown) return;

  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(searchTimer);
    if (q.length < 2) {
      // <2 chars: hide the dropdown and don't even debounce a request.
      // CoinGecko's search responds to single letters but the noise:signal
      // ratio is awful and we burn rate-limit budget.
      if (activeSearchAbort) activeSearchAbort.abort();
      dropdown.hidden = true;
      return;
    }
    // 400 ms debounce — slower-typist-friendly, also gives more
    // headroom under the 30 req/min limit.
    searchTimer = setTimeout(() => doSearch(q, dropdown), 400);
  });

  input.addEventListener("focus", () => {
    if (input.value.trim().length >= 2) dropdown.hidden = false;
  });

  document.addEventListener("click", (ev) => {
    if (ev.target.closest(".search-wrap")) return;
    dropdown.hidden = true;
  });
}

async function doSearch(query, dropdown) {
  if (activeSearchAbort) activeSearchAbort.abort();
  activeSearchAbort = new AbortController();
  dropdown.hidden = false;
  dropdown.innerHTML = `<div class="search-msg">Searching CoinGecko…</div>`;
  try {
    const json = await cgFetch("/search", { query }, { signal: activeSearchAbort.signal });
    const coins = (json?.coins ?? [])
      .filter((c) => c?.id && c?.symbol)
      .slice(0, 8);
    // Don't render if a newer search has started while we awaited.
    if (activeSearchAbort.signal.aborted) return;
    renderSearchResults(dropdown, coins);
    settings.hideBanner();
  } catch (err) {
    if (err.name === "AbortError") return;
    dropdown.innerHTML = `<div class="search-msg is-err">Search failed: ${err.message}.</div>`;
    settings.showBanner(`Search failed: ${err.message}`);
  }
}

function renderSearchResults(dropdown, coins) {
  if (coins.length === 0) {
    dropdown.innerHTML = `<div class="search-msg">no matches</div>`;
    return;
  }
  dropdown.innerHTML = "";
  for (const c of coins) {
    const sym = String(c.symbol).toUpperCase();
    // CoinGecko's id (e.g. "bitcoin", "ethereum") is what /coins/{id}/market_chart needs.
    const cgId = String(c.id);
    const row = document.createElement("div");
    row.className = "search-row";
    row.dataset.symbol = sym;
    const name = c.name || "";
    const rank = c.market_cap_rank ? `rank #${c.market_cap_rank}` : "";
    const already = tickerRows.has(sym);
    row.innerHTML = `
      <span class="sym">${escapeHtml(sym)}</span>
      <span class="name">${escapeHtml(name)}</span>
      <span class="exch">${escapeHtml(rank)}</span>
      ${already ? `<span class="added-tag">added</span>` : ""}
    `;
    if (!already) {
      row.addEventListener("click", () => addTicker(sym, name, cgId));
    } else {
      row.style.opacity = "0.6";
      row.style.cursor = "default";
    }
    dropdown.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function addTicker(symbol, name, cgId) {
  const dropdown = document.getElementById("search-dropdown");
  const input = document.getElementById("ticker-search");
  if (dropdown) dropdown.hidden = true;
  if (input) input.value = "";

  if (!allTickers.includes(symbol)) {
    allTickers.push(symbol);
  }
  selectedTickers.add(symbol);
  userAddedTickers.add(symbol);
  renderChips();
  const chip = els.chips.querySelector(`.chip[data-ticker="${cssEscape(symbol)}"]`);
  if (chip) chip.classList.add("is-loading");

  try {
    const rows = await fetchOhlcYear(cgId);
    if (rows.length === 0) throw new Error("no rows returned");
    tickerRows.set(symbol, rows);
    await regenIpcAndRefresh();
    settings.hideBanner();
    if (name) {
      window.__tickerNames = window.__tickerNames || new Map();
      window.__tickerNames.set(symbol, name);
    }
  } catch (err) {
    console.error("addTicker", symbol, err);
    selectedTickers.delete(symbol);
    userAddedTickers.delete(symbol);
    const idx = allTickers.indexOf(symbol);
    if (idx >= 0) allTickers.splice(idx, 1);
    renderChips();
    settings.showBanner(`Failed to fetch ${symbol}: ${err.message}`);
  }
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

async function fetchOhlcYear(cgId) {
  // CoinGecko market_chart returns daily-resolution data automatically
  // for any range >= 90 days. The shape is:
  //   { prices: [[ms, price], ...], total_volumes: [[ms, vol], ...] }
  // Crypto trades 24/7 so there's no "open/high/low/close" — just one
  // data point per day. We populate open/high/low = close to keep the
  // schema consistent with the existing SQL queries.
  const json = await cgFetch(`/coins/${encodeURIComponent(cgId)}/market_chart`, {
    vs_currency: "usd",
    days: 365,
  });
  const prices = Array.isArray(json?.prices) ? json.prices : [];
  const volumes = Array.isArray(json?.total_volumes) ? json.total_volumes : [];
  if (prices.length === 0) throw new Error("no prices returned");
  // Index volumes by ts for quick lookup.
  const volByTs = new Map(volumes.map((v) => [v[0], v[1]]));
  return prices.map(([ts, price]) => {
    const close = Number(price) || 0;
    return {
      date: new Date(ts).toISOString().slice(0, 10),
      open: close,
      high: close,
      low: close,
      close,
      volume: Number(volByTs.get(ts) ?? 0) || 0,
    };
  });
}

document.addEventListener("click", (ev) => {
  // Cell run buttons.
  const runTarget = ev.target.closest("[data-run]");
  if (runTarget) {
    const id = runTarget.dataset.run;
    const runner = RUNNERS[id];
    if (!runner) return;
    runTarget.classList.add("is-running");
    requestAnimationFrame(() => {
      try {
        runner();
      } catch (err) {
        const targetId = id.replace("cell-", "out-");
        const host = document.getElementById(targetId);
        if (host) renderError(host, err);
        console.error(id, err);
      }
      runTarget.classList.remove("is-running");
    });
    return;
  }

  // Chip "×" — remove a user-added ticker from the universe entirely.
  const removeBtn = ev.target.closest("[data-remove-ticker]");
  if (removeBtn) {
    ev.stopPropagation();
    const t = removeBtn.dataset.removeTicker;
    tickerRows.delete(t);
    selectedTickers.delete(t);
    userAddedTickers.delete(t);
    void regenIpcAndRefresh();
    return;
  }

  // Ticker chip toggles — re-run every cell so downstream stays in sync.
  const chip = ev.target.closest(".chip");
  if (chip) {
    const t = chip.dataset.ticker;
    if (selectedTickers.has(t)) selectedTickers.delete(t);
    else selectedTickers.add(t);
    renderChips();
    runAllCells();
    return;
  }

  // "all" / "none" / "clear" picker buttons.
  const action = ev.target.closest("[data-action]");
  if (action) {
    if (action.dataset.action === "all") {
      for (const t of allTickers) selectedTickers.add(t);
      renderChips();
      runAllCells();
    } else if (action.dataset.action === "none") {
      selectedTickers.clear();
      renderChips();
      if (allTickers.length === 0) showEmptyState();
      else runAllCells();
    } else if (action.dataset.action === "clear") {
      tickerRows.clear();
      selectedTickers.clear();
      userAddedTickers.clear();
      void regenIpcAndRefresh();
    }
    return;
  }
});

document.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
    const ta = ev.target.closest(".cell")?.querySelector("[data-run]");
    if (ta) ta.click();
  }
});

bootstrap().catch((err) => {
  console.error("bootstrap failed:", err);
  els.meta.textContent = `bootstrap failed: ${err.message}`;
});
