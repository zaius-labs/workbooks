#!/usr/bin/env node
// Substrate conformance suite — runs all spike + smoke + conformance
// tests in sequence. Exits non-zero if any test fails.
//
// Usage:
//   cd vendor/workbooks/packages/workbook-substrate
//   node test/conformance/run-all.mjs
//
// Some tests require browser drivers (Playwright) and standalone
// dependencies (yjs, @sqlite.org/sqlite-wasm) which we install in
// /tmp/wb-spike-deps to sidestep the monorepo's workspace pinning.
// See each test's individual reproducer for setup.

import { execSync } from "node:child_process";
import { existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBSTRATE_DIR = join(HERE, "..", "..");
const DEPS_DIR = "/tmp/wb-spike-deps";

/** Copy a spike script into DEPS_DIR so it can resolve standalone deps
 *  (yjs, sqlite-wasm) installed there. Returns the new path. */
function stageInDepsDir(srcPath) {
  const dst = join(DEPS_DIR, basename(srcPath));
  copyFileSync(srcPath, dst);
  return dst;
}

const tests = [
  // Smoke tests — pure Node, no external browser
  { name: "parser smoke",
    cmd: `tsx ${join(SUBSTRATE_DIR, "test", "smoke.mjs")}`,
    cwd: DEPS_DIR },
  { name: "mutate smoke",
    cmd: `node ${join(SUBSTRATE_DIR, "test", "mutate-smoke.mjs")}`,
    cwd: SUBSTRATE_DIR },
  { name: "compact + identity smoke",
    cmd: `node ${join(SUBSTRATE_DIR, "test", "compact-identity-smoke.mjs")}`,
    cwd: SUBSTRATE_DIR },
  { name: "transport smoke (T5 fallback)",
    cmd: `node ${join(SUBSTRATE_DIR, "test", "transport-smoke.mjs")}`,
    cwd: SUBSTRATE_DIR },

  // Conformance tests — invariants from the spec
  { name: "version refusal + meta validation",
    cmd: `node ${join(SUBSTRATE_DIR, "test", "conformance", "version-refusal.mjs")}`,
    cwd: SUBSTRATE_DIR },

  // Replay spike (yjs determinism + integrity chain)
  // Staged into DEPS_DIR so `import "yjs"` resolves.
  { name: "yjs determinism + integrity chain",
    setup: () => stageInDepsDir(join(SUBSTRATE_DIR, "spikes", "replay", "yjs-determinism.mjs")),
    cmd: (staged) => `node ${staged}`,
    cwd: DEPS_DIR },

  // SQLite Sessions spike — same staging treatment.
  { name: "SQLite Sessions",
    setup: () => stageInDepsDir(join(SUBSTRATE_DIR, "spikes", "replay", "sqlite-sessions.mjs")),
    cmd: (staged) => `node ${staged}`,
    cwd: DEPS_DIR },

  // Fingerprint guard (pure Node)
  { name: "fingerprint guard",
    cmd: `node ${join(SUBSTRATE_DIR, "spikes", "write", "fingerprint-guard.mjs")}`,
    cwd: SUBSTRATE_DIR },

  // Browser parser containment — requires playwright + browsers installed
  // Slower; gated by --include-browsers flag.
  ...(process.argv.includes("--include-browsers")
    ? [{
        name: "parser containment (3 browsers)",
        cmd: `node ${join(SUBSTRATE_DIR, "spikes", "parser", "test-browsers.mjs")}`,
        cwd: DEPS_DIR,
      }]
    : []),
];

if (!existsSync(DEPS_DIR)) {
  console.warn(`! ${DEPS_DIR} not found — some tests will fail.`);
  console.warn(`  setup: mkdir -p ${DEPS_DIR} && cd ${DEPS_DIR} && npm init -y && npm install yjs @sqlite.org/sqlite-wasm tsx playwright`);
}

const results = [];
let fails = 0;
for (const t of tests) {
  process.stdout.write(`\n── ${t.name} ────────────────────────────\n`);
  try {
    const setup = typeof t.setup === "function" ? t.setup() : null;
    const cmd = typeof t.cmd === "function" ? t.cmd(setup) : t.cmd;
    execSync(cmd, { stdio: "inherit", cwd: t.cwd });
    results.push({ name: t.name, ok: true });
  } catch (e) {
    fails++;
    results.push({ name: t.name, ok: false, error: e.message });
  }
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Conformance suite — ${results.length} tests`);
console.log(`${"=".repeat(60)}`);
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.name}`);
}
console.log(`${"=".repeat(60)}`);
console.log(`${results.filter((r) => r.ok).length} passed, ${fails} failed`);

process.exit(fails > 0 ? 1 : 0);
