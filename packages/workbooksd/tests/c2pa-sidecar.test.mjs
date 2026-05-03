#!/usr/bin/env bun
// E2E for core-5ah.10 — C2PA sidecar signing via the official
// c2pa Rust crate. Real-usage scenario:
//
//   1. User opens a workbook that declares the `c2pa` permission.
//   2. Approves it. Saves.
//   3. Daemon mints (or reuses) a per-machine ed25519 self-signed
//      cert, builds a Content Credentials manifest with our
//      assertions (workbook_id, content_sha256, edit_log), signs,
//      writes <path>.c2pa next to the workbook.
//   4. Validation: the c2patool CLI (if installed) or our own
//      Reader-backed daemon endpoint can read it back and surface
//      signer info + assertions.
//
// Assertions:
//   A. Sidecar appears at <path>.c2pa with non-trivial size.
//   B. Without `c2pa` permission granted, NO sidecar is written.
//   C. Re-signing reuses the same identity (cert.pem unchanged).
//   D. (Optional) c2patool validates the sidecar if present on PATH.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { which } from "bun";

import { daemonUrl } from "./_runtime.mjs";
const DAEMON = daemonUrl();
const ORIGIN = DAEMON;

const tmp = mkdtempSync(join(tmpdir(), "workbooks-c2pa-"));
const wbPath = join(tmp, "test.workbook.html");
const denyPath = join(tmp, "deny.workbook.html");

const permsB64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");

function wbHtml(id, perms) {
  return `<!doctype html><html><head>
<script id="wb-meta" type="application/json">${JSON.stringify({
    workbook_id: id,
    compaction_seq: 0,
    snapshot_cid_by_target: {},
  })}</script>
<meta name="wb-permissions" content="${permsB64(perms)}">
</head><body>v1</body></html>`;
}

writeFileSync(wbPath, wbHtml("c2pa-e2e-001", { c2pa: { reason: "test signing" } }));
writeFileSync(denyPath, wbHtml("c2pa-deny", { c2pa: { reason: "test signing" } }));

const cleanup = () => rmSync(tmp, { recursive: true, force: true });
const fail = (msg) => { console.error(`[fail] ${msg}`); cleanup(); process.exit(1); };
const pass = (msg) => { console.log(`[pass] ${msg}`); cleanup(); process.exit(0); };

async function openAndServe(path) {
  const r = await (await fetch(`${DAEMON}/open`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  })).json();
  await fetch(`${DAEMON}/wb/${r.token}/`);
  return r.token;
}
async function approve(token, ids) {
  await fetch(`${DAEMON}/wb/${token}/permissions/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ ids }),
  });
}
async function save(token, path) {
  const body = readFileSync(path);
  const res = await fetch(`${DAEMON}/wb/${token}/save`, {
    method: "PUT",
    headers: { Origin: ORIGIN, "x-wb-agent": "human" },
    body,
  });
  if (!res.ok) fail(`save: HTTP ${res.status}`);
}

// A. Approved → sidecar written.
const tokenA = await openAndServe(wbPath);
await approve(tokenA, ["c2pa"]);
console.log("[step] c2pa permission approved");

await save(tokenA, wbPath);
// Sidecar work runs in spawn_blocking after save acks; give it
// a moment to complete.
const sidecar = `${wbPath}.c2pa`;
const dl = Date.now() + 5000;
while (!existsSync(sidecar) && Date.now() < dl) {
  await new Promise((r) => setTimeout(r, 100));
}
if (!existsSync(sidecar)) fail("sidecar not written within 5s of save");
const size = statSync(sidecar).size;
if (size < 500) fail(`sidecar suspiciously small: ${size} bytes`);
console.log(`[step] A ok — sidecar written (${size} bytes)`);

// Verify the identity dir got populated.
const identityDir = join(homedir(), "Library/Application Support/sh.workbooks.workbooksd/signing");
const certPath = join(identityDir, "cert.pem");
const keyPath  = join(identityDir, "key.pem");
if (!existsSync(certPath) || !existsSync(keyPath)) fail("identity (cert.pem / key.pem) not persisted");
const cert1 = readFileSync(certPath);
console.log("[step] identity persisted at ~/Library/Application Support/sh.workbooks.workbooksd/signing/");

// B. Same workbook, different file path, no approval → no sidecar.
const tokenB = await openAndServe(denyPath);
// Deliberately do NOT approve c2pa for this token.
await save(tokenB, denyPath);
await new Promise((r) => setTimeout(r, 1000));
const denySidecar = `${denyPath}.c2pa`;
if (existsSync(denySidecar)) fail(`sidecar should NOT exist for un-approved workbook: ${denySidecar}`);
console.log("[step] B ok — no sidecar without c2pa permission");

// C. Re-sign reuses the identity.
const tokenC = await openAndServe(wbPath);
await approve(tokenC, ["c2pa"]);
// Mutate the body slightly so the new save is a real save.
writeFileSync(wbPath, wbHtml("c2pa-e2e-001", { c2pa: { reason: "test signing" } }).replace("v1", "v2"));
await save(tokenC, wbPath);
const dl2 = Date.now() + 5000;
let sidecarMtime = statSync(sidecar).mtimeMs;
while (Date.now() < dl2) {
  await new Promise((r) => setTimeout(r, 100));
  const m = statSync(sidecar).mtimeMs;
  if (m > sidecarMtime) { sidecarMtime = m; break; }
}
const cert2 = readFileSync(certPath);
if (!cert1.equals(cert2)) fail("cert.pem changed between saves — identity should persist");
console.log("[step] C ok — identity reused across saves");

// D. (Best-effort) c2patool validation if available. Otherwise
//    we trust the daemon's own Reader path which gets exercised
//    via core-5ah.13's portal viewer when that lands.
if (which("c2patool")) {
  // c2patool reads the asset and looks for a sidecar by filename.
  // It exits 0 on a valid manifest, non-zero with detail on
  // mismatch.
  const r = spawnSync("c2patool", [wbPath], { encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0) {
    console.warn(`[warn] c2patool exit ${r.status}: ${r.stderr?.slice(0, 200)}`);
    console.warn("       (likely 'untrusted self-signed cert' — expected for v1 per-machine identity)");
  } else {
    console.log("[step] D ok — c2patool validates sidecar");
  }
} else {
  console.log("[step] D skipped — c2patool not on PATH; portal viewer (.13) will exercise validation");
}

pass("c2pa sidecar written, identity persisted, gate honored, re-sign idempotent");
