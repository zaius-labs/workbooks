#!/usr/bin/env bun
// Parser smoke test for the portal viewer's inspect.js.
//
// inspect.js runs in the browser (DOM + crypto.subtle). We can't
// import it directly under Bun without DOM polyfills, but the
// PARSING logic is pure regex + JSON.parse + heuristic byte
// scans — easy to mirror here so we can verify the same
// fixture renders the way we expect.
//
// Real-usage assertion: a workbook + sidecar generated through
// the daemon's full pipeline (open → permissions/approve → save
// × N → c2pa sign) is parseable by the inspect page's logic.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_DIR = process.env.FIXTURE_DIR ?? "/tmp/workbooks-portal-fixture";
const wbPath = join(FIXTURE_DIR, "demo.workbook.html");
const sidecarPath = `${wbPath}.c2pa`;

const fail = (msg) => { console.error(`[fail] ${msg}`); process.exit(1); };
const pass = (msg) => { console.log(`[pass] ${msg}`); process.exit(0); };

// Re-implement the inspect page's parsers — same regex shapes.
function parseWorkbook(text) {
  const out = { workbook_id: null, entries: [] };
  const m1 = text.match(/<script id="wb-meta"[^>]*>([\s\S]*?)<\/script>/);
  if (m1) {
    try { out.workbook_id = JSON.parse(m1[1]).workbook_id ?? null; } catch {}
  }
  const m2 = text.match(/<script id="wb-edit-log"[^>]*>([\s\S]*?)<\/script>/);
  if (m2) {
    try {
      const arr = JSON.parse(m2[1]);
      if (Array.isArray(arr)) out.entries = arr;
    } catch {}
  }
  return out;
}

function inspectSidecar(buf) {
  const ascii = new TextDecoder("ascii").decode(buf.slice(0, 64));
  const fullAscii = new TextDecoder("latin1").decode(buf);
  const isWorkbooksSigned = fullAscii.includes("workbooks-daemon");
  return {
    hasJumb: ascii.includes("jumb"),
    isWorkbooksSigned,
  };
}

let html;
try { html = readFileSync(wbPath, "utf8"); }
catch { fail(`fixture missing at ${wbPath} — run portal-fixture.mjs first`); }

const wb = parseWorkbook(html);
if (wb.workbook_id !== "portal-demo-2026-05") fail(`workbook_id mismatch: ${wb.workbook_id}`);
if (wb.entries.length !== 3) fail(`expected 3 edit-log entries, got ${wb.entries.length}`);
const agents = wb.entries.map((e) => e.agent);
if (JSON.stringify(agents) !== JSON.stringify(["human", "claude", "codex"])) {
  fail(`agent chain mismatch: ${JSON.stringify(agents)}`);
}
console.log(`[step] workbook parses: id=${wb.workbook_id}, ${wb.entries.length} entries (${agents.join(" → ")})`);

// Each entry should have ts + sha256_after + size_after.
for (const [i, e] of wb.entries.entries()) {
  if (typeof e.ts !== "string" || !e.ts) fail(`entry ${i}: missing ts`);
  if (typeof e.sha256_after !== "string" || e.sha256_after.length !== 64) {
    fail(`entry ${i}: sha256_after looks wrong: ${e.sha256_after}`);
  }
  if (typeof e.size_after !== "number") fail(`entry ${i}: missing size_after`);
}
console.log("[step] every edit-log entry has ts/sha256/size");

// Sidecar — best-effort heuristics (the same the inspect page runs).
let sidecarSize;
try { sidecarSize = statSync(sidecarPath).size; }
catch { fail(`sidecar missing — c2pa permission may not have been approved`); }
const buf = readFileSync(sidecarPath);
const sc = inspectSidecar(buf);
if (!sc.hasJumb) fail(`sidecar (${sidecarSize}b) has no JUMBF magic — not a c2pa manifest?`);
if (!sc.isWorkbooksSigned) fail("sidecar didn't surface workbooks-daemon CN — wrong signer");
console.log(`[step] sidecar (${sidecarSize}b) has JUMBF + workbooks-daemon signer`);

pass("portal parsers round-trip the daemon's full save+sign pipeline output");
