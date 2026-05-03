#!/usr/bin/env bun
// E2E for core-5ah.19 — workbook_id-keyed permissions + secrets
// + the cross-copy "you're N saves behind" banner data.
//
// macOS appends "(1) (2)" to duplicates. Pre-0.1.4 the daemon
// keyed approvals + keychain secrets by path, so duplicates lost
// all that state and the user had to re-grant + re-enter keys.
//
// What this test asserts end-to-end against the running daemon:
//
//   A. Approve a permission on the original path.
//      Open the duplicate (different path, same workbook_id).
//      The duplicate's /permissions response shows the same
//      permission as already-granted — inherited via the new
//      workbook_id index.
//
//   B. Set a secret on the original. /secret/list on the
//      duplicate shows the same id (inherited index) and
//      /proxy with that secret_id round-trips successfully on
//      the duplicate (the value is found via id-keyed keychain).
//
//   C. Save N times on the original. Open the duplicate.
//      /related on the duplicate's token reports `behind: N` and
//      a `latest_url` pointing at a fresh session for the
//      original path. The HTML response from the duplicate's
//      /wb/<token>/ contains the banner script.
//
//   D. Revoke on duplicate → both copies lose the grant.
//      Symmetric: revocation propagates through the id index.

import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { daemonUrl } from "./_runtime.mjs";

const DAEMON = daemonUrl();
const ORIGIN = DAEMON;
const fail = (msg) => { console.error(`[fail] ${msg}`); process.exit(1); };
const pass = (msg) => { console.log(`[pass] ${msg}`); process.exit(0); };

const tmp = mkdtempSync(join(tmpdir(), "workbooks-dup-"));
const orig = join(tmp, "myworkbook.workbook.html");
const dup  = join(tmp, "myworkbook (1).workbook.html");
const cleanup = () => rmSync(tmp, { recursive: true, force: true });
const exitFail = (msg) => { cleanup(); fail(msg); };
const exitPass = (msg) => { cleanup(); pass(msg); };

const policyB64 = Buffer.from(JSON.stringify({
  TEST_KEY: { domains: ["example.com"] },
})).toString("base64");
const permsB64  = Buffer.from(JSON.stringify({
  secrets: { reason: "test" },
  network: { reason: "test" },
})).toString("base64");

// Unique workbook_id per run so the ledger doesn't see history
// from prior test invocations (the daemon-side ledger persists).
const WORKBOOK_ID = `dup-inheritance-e2e-${Date.now()}`;

function makeHtml(seq) {
  return `<!doctype html><html><head>
<script id="wb-meta" type="application/json">${JSON.stringify({
    workbook_id: WORKBOOK_ID,
    compaction_seq: seq,
    snapshot_cid_by_target: {},
  })}</script>
<meta name="wb-permissions" content="${permsB64}">
<meta name="wb-secrets-policy" content="${policyB64}">
</head><body>v${seq}</body></html>`;
}

writeFileSync(orig, makeHtml(0));

async function openAndServe(p) {
  const { token } = await (await fetch(`${DAEMON}/open`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: p }),
  })).json();
  await fetch(`${DAEMON}/wb/${token}/`);
  return token;
}
async function approve(token, ids) {
  return (await fetch(`${DAEMON}/wb/${token}/permissions/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ ids }),
  })).json();
}
async function revoke(token, ids) {
  return (await fetch(`${DAEMON}/wb/${token}/permissions/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ ids }),
  })).json();
}
async function listPerms(token) {
  return (await fetch(`${DAEMON}/wb/${token}/permissions`)).json();
}
async function setSecret(token, id, value) {
  return fetch(`${DAEMON}/wb/${token}/secret/set`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ id, value }),
  });
}
async function listSecrets(token) {
  return (await fetch(`${DAEMON}/wb/${token}/secret/list`)).json();
}
async function saveBody(token, p) {
  const body = readFileSync(p);
  return fetch(`${DAEMON}/wb/${token}/save`, {
    method: "PUT",
    headers: { Origin: ORIGIN, "x-wb-agent": "human" },
    body,
  });
}
async function getRelated(token) {
  return (await fetch(`${DAEMON}/wb/${token}/related`)).json();
}

// --- A. permissions inherit by workbook_id ---
const tA = await openAndServe(orig);
await approve(tA, ["secrets", "network"]);
copyFileSync(orig, dup);                         // macOS-style duplicate
const tDup = await openAndServe(dup);
const dupPerms = await listPerms(tDup);
const dupGrants = new Set(dupPerms.granted ?? []);
if (!dupGrants.has("secrets") || !dupGrants.has("network")) {
  exitFail(`duplicate didn't inherit grants; got: ${JSON.stringify(dupPerms)}`);
}
console.log(`[step] A ok — duplicate inherits {secrets,network} via workbook_id`);

// --- B. secrets inherit (set on orig, list/use on dup) ---
const setRes = await setSecret(tA, "TEST_KEY", "tk-12345-67890");
if (!setRes.ok) exitFail(`secret/set on orig: HTTP ${setRes.status}`);
// Need the dup's session to refresh — workbook_id is already cached
// from openAndServe so /secret/list will read both indexes.
const dupSecrets = await listSecrets(tDup);
if (!Array.isArray(dupSecrets.ids) || !dupSecrets.ids.includes("TEST_KEY")) {
  exitFail(`duplicate didn't see TEST_KEY in /secret/list; got: ${JSON.stringify(dupSecrets)}`);
}
console.log(`[step] B ok — duplicate sees TEST_KEY in /secret/list`);

// Also verify /proxy on duplicate can RESOLVE the secret value.
const proxyRes = await fetch(`${DAEMON}/wb/${tDup}/proxy`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: ORIGIN },
  body: JSON.stringify({
    url: "https://example.com",
    method: "GET",
    headers: {},
    auth: { headerName: "Authorization", secretId: "TEST_KEY", format: "Bearer {value}" },
  }),
});
if (!proxyRes.ok) exitFail(`/proxy on duplicate failed: HTTP ${proxyRes.status} — ${(await proxyRes.text()).slice(0, 200)}`);
console.log(`[step] B' ok — /proxy on duplicate spliced TEST_KEY value (id-keyed read)`);

// --- C. /related reports "behind" + provides latest_url ---
// Make N saves on the original. Each save bumps the ledger; the
// duplicate's content stays at v0, so it's "behind" by N.
for (const seq of [1, 2, 3]) {
  writeFileSync(orig, makeHtml(seq));
  const r = await saveBody(tA, orig);
  if (!r.ok) exitFail(`save seq=${seq}: HTTP ${r.status}`);
}

// /related on the dup token reads the dup file (still v0 content),
// looks up the workbook_id history, finds 3 newer saves, returns
// behind=3 + a fresh latest_url for the original path.
const rel = await getRelated(tDup);
if (rel.behind !== 3) {
  exitFail(`expected behind=3 for stale duplicate; got ${rel.behind} (${JSON.stringify(rel)})`);
}
if (!rel.latest_url || !rel.latest_url.includes("/wb/")) {
  exitFail(`expected latest_url with /wb/ token; got ${rel.latest_url}`);
}
if (!rel.latest_path?.endsWith("myworkbook.workbook.html")) {
  exitFail(`expected latest_path = original; got ${rel.latest_path}`);
}
console.log(`[step] C ok — /related: behind=${rel.behind}, latest_path=${rel.latest_path.split("/").pop()}, latest_url=...${rel.latest_url.slice(-50)}`);

// And confirm the served HTML on the dup contains the banner script.
const dupHtml = await (await fetch(`${DAEMON}/wb/${tDup}/`)).text();
if (!dupHtml.includes("wb-related-banner") || !dupHtml.includes(`/wb/${tDup}/related`)) {
  exitFail(`dup HTML missing banner script (length ${dupHtml.length})`);
}
console.log(`[step] C' ok — duplicate's HTML has banner script wired to /wb/<token>/related`);

// --- D. revoke on duplicate propagates to original ---
await revoke(tDup, ["secrets"]);
const origAfter = await listPerms(tA);
if ((origAfter.granted ?? []).includes("secrets")) {
  exitFail(`revoke on dup didn't propagate; orig still has secrets: ${JSON.stringify(origAfter)}`);
}
console.log(`[step] D ok — revoke on duplicate propagated to original (id-keyed)`);

exitPass("workbook_id-keyed perms + secrets + cross-copy banner all round-trip");
