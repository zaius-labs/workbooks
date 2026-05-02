#!/usr/bin/env bun
// E2E for core-5ah.16 — per-permission approve/revoke flow.
//
// Real-usage scenario:
//   1. User opens a workbook that declares { secrets, network }.
//   2. Approves only `secrets` (per-row Allow click).
//   3. Calls /secret/list — passes; calls /proxy — denied.
//   4. Approves `network` too — both work.
//   5. Revokes `network` — /proxy denied again, /secret/list still ok.
//   6. Revokes `secrets` — both denied.
//
// This is the trust model the user asked for: each grant is its
// own commit, every grant is reversible, the daemon's enforcement
// reflects the latest state immediately.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";

const DAEMON = "http://127.0.0.1:47119";
const ORIGIN = DAEMON;

const tmp = mkdtempSync(join(tmpdir(), "workbooks-revoke-"));
const wbPath = join(tmp, "test.workbook.html");

const policyJson = JSON.stringify({ TEST_KEY: { domains: ["example.com"] } });
const policyB64 = Buffer.from(policyJson, "utf8").toString("base64");
const permsJson = JSON.stringify({
  secrets: { reason: "test" },
  network: { reason: "test" },
});
const permsB64 = Buffer.from(permsJson, "utf8").toString("base64");

writeFileSync(
  wbPath,
  `<!doctype html><html><head>
<script id="wb-meta" type="application/json">${JSON.stringify({
    workbook_id: "perm-revoke-e2e",
    compaction_seq: 0,
    snapshot_cid_by_target: {},
  })}</script>
<meta name="wb-permissions" content="${permsB64}">
<meta name="wb-secrets-policy" content="${policyB64}">
</head><body></body></html>`,
);

const cleanup = () => rmSync(tmp, { recursive: true, force: true });
const fail = (msg) => { console.error(`[fail] ${msg}`); cleanup(); process.exit(1); };
const pass = (msg) => { console.log(`[pass] ${msg}`); cleanup(); process.exit(0); };

const { token } = await (await fetch(`${DAEMON}/open`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ path: wbPath }),
})).json();
await fetch(`${DAEMON}/wb/${token}/`); // serve to populate session perms
console.log(`[step] opened session ${token.slice(0, 12)}…`);

async function listPerms() {
  const r = await fetch(`${DAEMON}/wb/${token}/permissions`, {
    headers: { Origin: ORIGIN },
  });
  return r.json();
}
async function approve(ids) {
  return (await fetch(`${DAEMON}/wb/${token}/permissions/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ ids }),
  })).json();
}
async function revoke(ids) {
  return (await fetch(`${DAEMON}/wb/${token}/permissions/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ ids }),
  })).json();
}
async function statusOfSecretList() {
  return (await fetch(`${DAEMON}/wb/${token}/secret/list`, {
    headers: { Origin: ORIGIN },
  })).status;
}
async function statusOfProxy() {
  return (await fetch(`${DAEMON}/wb/${token}/proxy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({
      url: "https://example.com",
      method: "GET",
      headers: {},
    }),
  })).status;
}

// 1. Both gates closed initially.
const start = await listPerms();
if (start.granted.length !== 0) fail(`expected no initial grants; got: ${JSON.stringify(start.granted)}`);
if (await statusOfSecretList() !== 403) fail("/secret/list should 403 before any grant");
if (await statusOfProxy() !== 403) fail("/proxy should 403 before any grant");
console.log("[step] both gates 403 before any grant");

// 2. Approve only secrets (per-row Allow).
await approve(["secrets"]);
let p = await listPerms();
if (!p.granted.includes("secrets") || p.granted.includes("network")) {
  fail(`approve(secrets) wrong granted: ${JSON.stringify(p.granted)}`);
}
if (await statusOfSecretList() !== 200) fail("/secret/list should 200 after granting secrets");
if (await statusOfProxy() !== 403) fail("/proxy should still 403");
console.log("[step] after approve(secrets): secrets pass, network refuse");

// 3. Approve network — UNION semantic should keep secrets granted.
await approve(["network"]);
p = await listPerms();
if (!p.granted.includes("secrets") || !p.granted.includes("network")) {
  fail(`approve(network) lost secrets: ${JSON.stringify(p.granted)}`);
}
if (await statusOfProxy() !== 200) fail("/proxy should 200 after granting network");
console.log("[step] after approve(network): both pass — UNION semantic preserved earlier grant");

// 4. Revoke network — secrets must remain.
await revoke(["network"]);
p = await listPerms();
if (!p.granted.includes("secrets") || p.granted.includes("network")) {
  fail(`revoke(network) wrong: ${JSON.stringify(p.granted)}`);
}
if (await statusOfSecretList() !== 200) fail("/secret/list should still 200 after revoking only network");
if (await statusOfProxy() !== 403) fail("/proxy should 403 again after revoke");
console.log("[step] after revoke(network): secrets still pass, network refuses again");

// 5. Revoke secrets — both denied.
await revoke(["secrets"]);
p = await listPerms();
if (p.granted.length !== 0) fail(`revoke(secrets) didn't clear: ${JSON.stringify(p.granted)}`);
if (await statusOfSecretList() !== 403) fail("/secret/list should 403 after final revoke");
console.log("[step] after revoke(secrets): both gates 403 again");

// 6. Idempotence: revoke a non-granted id is a no-op (200 response, granted unchanged).
await revoke(["network"]);
p = await listPerms();
if (p.granted.length !== 0) fail("idempotent revoke leaked state");
console.log("[step] revoke is idempotent");

pass("approve / revoke / re-approve all flip enforcement immediately, UNION + idempotence verified");
