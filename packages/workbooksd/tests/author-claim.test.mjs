#!/usr/bin/env bun
// E2E for core-1fi.8.7-A — author-claim signing endpoints on the
// running daemon.
//
// Pre-req: workbooksd is running (the suite assumes it; see _runtime).
// On a fresh box the daemon will mint its per-machine ed25519 identity
// the first time /author/identity is hit — that's intentional and
// matches the c2pa-sidecar flow. We exercise:
//
//   A. GET /author/identity returns base64url(32) pubkey + 16-hex
//      key fingerprint.
//   B. POST /author/sign-claim returns base64url(64) sig.
//   C. The sig verifies via WebCrypto Ed25519 against the canonical
//      claim bytes the recipient's pre-auth shell will reconstruct.
//   D. Tampering any field of the claim invalidates the sig.
//
// This test does NOT exercise the workbook-cli `seal --sign` flag
// directly — that's a thin shell over (A) + (B). We unit-test the
// canonical-bytes layout in packages/workbook-cli/test/wrap-studio-
// claim.test.mjs so byte drift between Rust + JS sides is caught
// regardless of the live integration.

import { Buffer } from "node:buffer";
import { daemonUrl } from "./_runtime.mjs";

const DAEMON = daemonUrl();

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail !== undefined ? ": " + detail : ""}`);
  if (ok) pass++; else fail++;
}

function b64uToBytes(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function canonicalClaimBytes(claim) {
  const ordered = {};
  for (const k of Object.keys(claim).sort()) ordered[k] = claim[k];
  return new TextEncoder().encode(JSON.stringify(ordered));
}

// (A) Identity surface.
const idR = await fetch(`${DAEMON}/author/identity`);
check("GET /author/identity status 200", idR.status === 200, idR.status);
const id = await idR.json();
check(
  "pubkey decodes to 32 bytes",
  b64uToBytes(id.pubkey).length === 32,
  b64uToBytes(id.pubkey).length,
);
check(
  "key_fingerprint is 16 hex chars",
  /^[0-9a-f]{16}$/.test(id.key_fingerprint),
  id.key_fingerprint,
);

// (B) Sign-claim surface.
const claim = {
  author_sub: "workos|user_e2e",
  author_email: "e2e@example.test",
  key_id: "k_e2e_test",
  workbook_id: "wb_e2e_signing_test",
  ts: 1730000000,
};
const signR = await fetch(`${DAEMON}/author/sign-claim`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(claim),
});
check("POST /author/sign-claim status 200", signR.status === 200, signR.status);
const sign = await signR.json();
const sigBytes = b64uToBytes(sign.sig);
check("sig decodes to 64 bytes", sigBytes.length === 64, sigBytes.length);

// (C) WebCrypto verification — same path the recipient pre-auth shell
//     runs. If this fails, byte layouts diverged between the Rust
//     signer and the JS canonicalClaimBytes.
const cryptoKey = await crypto.subtle.importKey(
  "raw",
  b64uToBytes(id.pubkey),
  { name: "Ed25519" },
  false,
  ["verify"],
);
const msg = canonicalClaimBytes(claim);
const ok = await crypto.subtle.verify(
  { name: "Ed25519" },
  cryptoKey,
  sigBytes,
  msg,
);
check("WebCrypto Ed25519.verify against daemon pubkey succeeds", ok === true);

// (D) Tampering: same pubkey + signature, but a tweaked claim → fail.
const tampered = canonicalClaimBytes({ ...claim, ts: claim.ts + 1 });
const tamperedOk = await crypto.subtle.verify(
  { name: "Ed25519" },
  cryptoKey,
  sigBytes,
  tampered,
);
check("verify fails when ts is tampered", tamperedOk === false);

// (B.1) Rejection paths.
const missingR = await fetch(`${DAEMON}/author/sign-claim`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ...claim, author_sub: "" }),
});
check(
  "empty author_sub → 400 missing_fields",
  missingR.status === 400,
  missingR.status,
);

const longR = await fetch(`${DAEMON}/author/sign-claim`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ...claim, key_id: "x".repeat(65) }),
});
check(
  "key_id > 64 chars → 400 field_too_long",
  longR.status === 400,
  longR.status,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
