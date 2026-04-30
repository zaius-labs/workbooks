#!/usr/bin/env node
// Ensure prices.csv exists at build time. The workbook ships with no
// pre-bundled tickers — the user adds them via the Yahoo Finance
// search box at runtime. We just need a header row so the CSV-to-IPC
// path doesn't choke on a missing file.

import { existsSync, writeFileSync } from "node:fs";

const OUT = process.argv[2] ?? "prices.csv";
if (!existsSync(OUT)) {
  writeFileSync(OUT, "ticker,date,open,high,low,close,volume\n");
  console.log(`wrote empty ${OUT} (header only)`);
}
