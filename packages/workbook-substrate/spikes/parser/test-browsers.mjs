#!/usr/bin/env node
// Spike 1: Drive the spike file through Chromium, Firefox, and WebKit
// via Playwright. The HTML file populates a #results table on load;
// we read pass/fail counts and per-check rows + parse-time stats.
//
// Usage:
//   npx playwright install chromium firefox webkit  # one-time
//   node test-browsers.mjs

import { chromium, firefox, webkit } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEST_FILE = join(HERE, "out", "spike-parser-test.html");

if (!existsSync(TEST_FILE)) {
  console.error(`Missing ${TEST_FILE} — run generate-test-file.mjs first.`);
  process.exit(1);
}
const fileUrl = pathToFileURL(TEST_FILE).href;

const browsers = [
  { name: "Chromium", launcher: chromium },
  { name: "Firefox",  launcher: firefox },
  { name: "WebKit",   launcher: webkit },
];

async function runOne({ name, launcher }) {
  let browser;
  try {
    browser = await launcher.launch();
  } catch (e) {
    return { name, error: `launch failed: ${e.message}` };
  }

  const page = await browser.newPage();
  const consoleEvents = [];
  page.on("console", (m) => consoleEvents.push({ type: m.type(), text: m.text() }));
  page.on("pageerror", (e) => consoleEvents.push({ type: "pageerror", text: e.message }));

  let result;
  try {
    await page.goto(fileUrl, { waitUntil: "load", timeout: 60_000 });

    // The in-page runner is async; wait for it to call console.log with summary.
    await page.waitForFunction(
      () => {
        const summary = document.getElementById("summary");
        return summary && summary.textContent.includes("passed");
      },
      { timeout: 60_000 },
    );

    result = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#results tbody tr")].map((tr) => {
        const tds = tr.querySelectorAll("td");
        return {
          name: tds[0]?.textContent ?? "?",
          verdict: tds[1]?.textContent ?? "?",
          detail: tds[2]?.textContent ?? "",
        };
      });
      const summary = document.getElementById("summary").textContent;
      return {
        compatMode: document.compatMode,
        bodyChildren: [...document.body.children].map((el) => el.tagName),
        rows,
        summary,
      };
    });
  } catch (e) {
    result = { error: e.message, console: consoleEvents };
  } finally {
    await browser.close();
  }
  return { name, ...result };
}

console.log(`Spike 1 — running spike file in 3 engines\n  ${TEST_FILE}\n`);

const results = [];
for (const b of browsers) {
  process.stdout.write(`${b.name.padEnd(10)} ... `);
  const r = await runOne(b);
  results.push(r);
  if (r.error) {
    console.log(`ERROR: ${r.error}`);
    continue;
  }
  const pass = r.rows.filter((row) => row.verdict === "PASS").length;
  const fail = r.rows.filter((row) => row.verdict === "FAIL").length;
  console.log(`${pass} pass, ${fail} fail · compatMode=${r.compatMode}`);
  if (fail > 0) {
    for (const row of r.rows.filter((r) => r.verdict === "FAIL")) {
      console.log(`    ✗ ${row.name}: ${row.detail}`);
    }
  }
}

// JSON dump for the FINDINGS markdown.
const summaryPath = join(HERE, "out", "browser-results.json");
import("node:fs").then((fs) =>
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2)),
);
console.log(`\nDetailed results: ${summaryPath}`);

const anyFail = results.some((r) => r.error || r.rows?.some((row) => row.verdict === "FAIL"));
process.exit(anyFail ? 1 : 0);
