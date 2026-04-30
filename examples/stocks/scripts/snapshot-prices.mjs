#!/usr/bin/env node
// Fetch ~1y of daily OHLC from Yahoo Finance's public chart API for a
// basket of tickers. No API key, no captcha. Bundles the joined data
// at build time so the workbook ships fully self-contained.

import { writeFileSync } from "node:fs";

const TICKERS = [
  "AAPL", "MSFT", "GOOGL", "NVDA", "AMZN",
  "META", "TSLA", "JPM", "JNJ", "XOM",
];
const OUT = process.argv[2] ?? "prices.csv";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; workbook-showcase)" };

const NOW = Math.floor(Date.now() / 1000);
const ONE_YEAR_AGO = NOW - 365 * 24 * 3600;

async function fetchTicker(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
    `?period1=${ONE_YEAR_AGO}&period2=${NOW}&interval=1d`;
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) throw new Error(`${symbol}: HTTP ${resp.status}`);
  const json = await resp.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`${symbol}: empty response`);
  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close?.[i] == null) continue;
    const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    out.push(
      [
        symbol,
        date,
        fmt(q.open?.[i]),
        fmt(q.high?.[i]),
        fmt(q.low?.[i]),
        fmt(q.close?.[i]),
        Math.round(q.volume?.[i] ?? 0),
      ].join(","),
    );
  }
  return { symbol, rows: out };
}

function fmt(n) {
  return n == null ? "" : Number(n).toFixed(4);
}

console.log(`fetching ${TICKERS.length} tickers from yahoo finance…`);
const all = [];
for (const t of TICKERS) {
  try {
    const data = await fetchTicker(t);
    all.push(...data.rows);
    console.log(`  ${data.symbol.padEnd(6)} ${data.rows.length} rows`);
  } catch (err) {
    console.warn(`  ${t} failed: ${err.message}`);
  }
  // Be polite — small delay between requests.
  await new Promise((r) => setTimeout(r, 80));
}

if (all.length === 0) {
  console.error("✗ no data fetched. is yahoo finance reachable?");
  process.exit(1);
}

const header = "ticker,date,open,high,low,close,volume";
writeFileSync(OUT, [header, ...all].join("\n") + "\n");
console.log(`wrote ${OUT} — ${all.length} rows`);
