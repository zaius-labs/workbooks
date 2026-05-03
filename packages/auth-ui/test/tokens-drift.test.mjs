#!/usr/bin/env node
// Brand-drift check (C7.1).
//
// The pre-auth shell (vendor/workbooks/packages/workbook-cli/src/encrypt/
// wrapStudio.mjs) and the admin webapp (apps/workbooks-admin/src/routes/
// +layout.svelte) all hardcode the same palette. If THIS package's tokens
// drift from those, visual continuity across the broker redirect breaks
// silently — recipient sees a slightly different shade between the
// sealed-workbook shell and the broker sign-in page.
//
// This test pins each authoritative hex literal. When any of them change,
// the test fails LOUDLY with a list of every file that needs the same
// update.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");
const REPO_ROOT = join(PKG_ROOT, "..", "..", "..", "..");

const tokensPath = join(PKG_ROOT, "src/tokens.css");
const tokens = readFileSync(tokensPath, "utf8");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ": " + detail : ""}`);
  if (ok) pass++; else fail++;
}

// 1. Each authoritative hex literal must appear in tokens.css.
const palette = {
  "--wb-bg light": "#ffffff",
  "--wb-fg light": "#0a0a0a",
  "--wb-fg-mute light": "#555",
  "--wb-line light": "#ececec",
  "--wb-code-bg light": "#f5f5f5",
  "--wb-bg dark": "#0a0a0a",
  "--wb-fg dark": "#f5f5f5",
  "--wb-fg-mute dark": "#9a9a9a",
  "--wb-line dark": "#1c1c1c",
  "--wb-code-bg dark": "#141414",
  "--wb-ok": "#0a7c45",
  "--wb-warn": "#a35400",
  "--wb-err": "#b3261e",
};
for (const [name, hex] of Object.entries(palette)) {
  check(`tokens.css contains ${name} = ${hex}`, tokens.includes(hex));
}

// 2. JS re-exports match the CSS values byte-for-byte.
const indexJs = readFileSync(join(PKG_ROOT, "src/index.js"), "utf8");
for (const hex of Object.values(palette)) {
  check(`index.js carries ${hex}`, indexJs.includes(hex));
}

// 3. Sister surfaces (pre-auth shell + admin webapp) hardcode the same
//    light-mode palette — those files are the visual "downstream"
//    consumers until C7.7 unifies via @import. Any drift here is
//    a brand-continuity bug.
const drift = [
  {
    label: "pre-auth shell (wrapStudio.mjs)",
    path: join(REPO_ROOT, "vendor/workbooks/packages/workbook-cli/src/encrypt/wrapStudio.mjs"),
    must_contain: ["#ffffff", "#0a0a0a", "#ececec", "#f5f5f5", "#0a7c45", "#a35400", "#b3261e"],
  },
  {
    label: "admin webapp +layout.svelte",
    path: join(REPO_ROOT, "apps/workbooks-admin/src/routes/+layout.svelte"),
    must_contain: ["#ffffff", "#0a0a0a", "#555", "#ececec", "#f5f5f5"],
  },
];

for (const surface of drift) {
  let body;
  try {
    body = readFileSync(surface.path, "utf8");
  } catch {
    check(`${surface.label} readable`, false, surface.path);
    continue;
  }
  for (const hex of surface.must_contain) {
    check(
      `${surface.label} carries ${hex}`,
      body.includes(hex),
      surface.path,
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
