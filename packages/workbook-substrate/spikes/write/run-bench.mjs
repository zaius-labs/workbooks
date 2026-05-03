#!/usr/bin/env node
// Spike 2 — drive bench.html in headed Chromium via Playwright.
//
// Headed mode required because OPFS in Chromium needs a "real" origin
// context. We serve bench.html from a tiny local HTTP server (file://
// origin would also block OPFS quota access in some configurations).
//
// Run: cd /tmp/wb-spike-deps && node run-bench.mjs

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_HTML = resolve(HERE, "bench.html");

if (!existsSync(BENCH_HTML)) {
  console.error("Missing bench.html");
  process.exit(1);
}

// Tiny static server (single file, but served over HTTP to give OPFS a
// proper origin).
const PORT = 9876;
const server = createServer(async (req, res) => {
  if (req.url === "/" || req.url === "/bench.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(await readFile(BENCH_HTML));
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise((resolve) => server.listen(PORT, resolve));
console.log(`Bench server: http://localhost:${PORT}/`);

const browser = await chromium.launch();
const context = await browser.newContext();
// Persist OPFS across the run.
const page = await context.newPage();

const consoleEvents = [];
page.on("console", (m) => consoleEvents.push(m.text()));
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
console.log("Loaded; running bench…");

// Wait for the summary div to populate.
await page.waitForFunction(
  () => document.querySelector("#summary p"),
  { timeout: 600_000 },
);

const resultsLine = consoleEvents.find((l) => l.startsWith("RESULTS_JSON="));
if (!resultsLine) {
  console.error("No RESULTS_JSON line in console; check page errors.");
  await browser.close();
  server.close();
  process.exit(1);
}
const results = JSON.parse(resultsLine.slice("RESULTS_JSON=".length));

console.log("\nResults:\n");
console.log("  snapshot |   op    | median ms | writes/sec");
console.log("  ---------|---------|-----------|-----------");
for (const r of results) {
  console.log(
    `  ${r.snapshot.padEnd(8)} | ${r.op.padEnd(7)} | ${String(Math.round(r.medianMs)).padStart(9)} | ${String(r.writesPerSec).padStart(10)}`,
  );
}

const outPath = join(HERE, "out", "bench-results.json");
import("node:fs").then((fs) => {
  import("node:path").then((p) => {
    fs.mkdirSync(p.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`\nDetailed results: ${outPath}`);
  });
});

await browser.close();
server.close();
