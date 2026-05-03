#!/usr/bin/env node
// C8-B / C8-C — wrapStudio author-claim embedding + canonical-claim
// signature verification.
//
// Verifies:
//   - Wrapping with no claim is unchanged (existing C1 callers still work)
//   - Wrapping with a claim emits the expected meta tags + visible block
//   - canonicalClaimBytes is byte-stable: identical for equivalent claims
//     regardless of insertion order
//   - A claim signed by an Ed25519 private key verifies successfully
//     when the in-browser verifier reconstructs the canonical bytes
//     and verifies against the matching public key
//   - A claim signed under one key fails verification under a
//     different key (sanity / no false-positive)
//
// No daemon, no broker — this is a unit-level test of the wrap path.
// The full end-to-end verification (against a real broker pubkey
// surface) is exercised by the broker e2e plus the daemon's c2pa
// signing tests; this just nails down the wire shape so a regression
// in the canonical-bytes layout is caught before either side ships.

import { wrapStudio, parseEnvelope, canonicalClaimBytes } from "../src/encrypt/wrapStudio.mjs";
import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ": " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

const POLICY = {
  allow: [{ domain: "acme.example" }],
  views: { default: { allow: ["*"] } },
};
const BROKER = "https://broker.example/";

function findMeta(html, name) {
  const re = new RegExp(`<meta\\s+name=["']${name}["']\\s+content=(['"])(.+?)\\1`, "i");
  const m = re.exec(html);
  return m ? m[2] : null;
}

// 1. No-claim case stays C1-shape — no wb-author-* meta, no claim block.
{
  const out = await wrapStudio({
    html: "<p>hi</p>",
    brokerUrl: BROKER,
    policy: POLICY,
    title: "No-claim test",
  });
  check("no-claim wrap: parseEnvelope succeeds", parseEnvelope(out.html) !== null);
  check(
    "no-claim wrap: no wb-author-sub meta",
    findMeta(out.html, "wb-author-sub") === null,
  );
  check(
    "no-claim wrap: no wb-claim-badge in DOM",
    !out.html.includes('id="wb-claim-badge"'),
  );
}

// 2. canonicalClaimBytes is order-independent.
{
  const a = canonicalClaimBytes({
    workbook_id: "wb_x",
    ts: 1700000000,
    key_id: "k1",
    author_email: "alice@acme.example",
    author_sub: "workos|user_alice",
  });
  const b = canonicalClaimBytes({
    author_sub: "workos|user_alice",
    author_email: "alice@acme.example",
    workbook_id: "wb_x",
    key_id: "k1",
    ts: 1700000000,
  });
  const aStr = new TextDecoder().decode(a);
  const bStr = new TextDecoder().decode(b);
  check("canonicalClaimBytes is insertion-order-independent", aStr === bStr, aStr);
  // The expected layout is a sorted-key compact JSON. Spell it out so
  // a future drift in the algorithm fails this assertion clearly.
  const expected =
    `{"author_email":"alice@acme.example","author_sub":"workos|user_alice","key_id":"k1","ts":1700000000,"workbook_id":"wb_x"}`;
  check("canonicalClaimBytes layout matches spec", aStr === expected);
}

// 3. With a real Ed25519 sig, the wrapped envelope contains a
//    verifiable claim. Reconstruct the canonical bytes the same way
//    the in-browser verifier does and confirm the signature checks
//    out using webcrypto on the same key material.
{
  const kp = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pubRaw = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  const claim = {
    author_sub: "workos|user_alice",
    author_email: "alice@acme.example",
    author_name: "Alice (Acme)",
    key_id: "k_alice_macbook",
    ts: 1700000000,
  };
  const claimMsg = canonicalClaimBytes({
    author_sub: claim.author_sub,
    author_email: claim.author_email,
    workbook_id: "deterministic_wb_id",
    key_id: claim.key_id,
    ts: claim.ts,
  });
  const sigBytes = new Uint8Array(await subtle.sign({ name: "Ed25519" }, kp.privateKey, claimMsg));
  const sigB64u = Buffer.from(sigBytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const out = await wrapStudio({
    html: "<p>hi</p>",
    brokerUrl: BROKER,
    policy: POLICY,
    title: "Claim test",
    workbookId: "deterministic_wb_id",
    claim,
    claimSig: sigB64u,
  });

  // Meta tags present.
  check(
    "claim wrap: wb-author-sub meta present",
    findMeta(out.html, "wb-author-sub") === claim.author_sub,
  );
  check(
    "claim wrap: wb-author-email meta present",
    findMeta(out.html, "wb-author-email") === claim.author_email,
  );
  check(
    "claim wrap: wb-author-key-id meta present",
    findMeta(out.html, "wb-author-key-id") === claim.key_id,
  );
  check(
    "claim wrap: wb-claim-ts meta present",
    findMeta(out.html, "wb-claim-ts") === String(claim.ts),
  );
  check(
    "claim wrap: wb-author-sig meta present",
    findMeta(out.html, "wb-author-sig") === sigB64u,
  );
  check(
    "claim wrap: visible 'Sealed by' block emitted",
    out.html.includes("Sealed by") &&
      out.html.includes("Alice (Acme)") &&
      out.html.includes('id="wb-claim-badge"'),
  );

  // Verify the signature out-of-band, using the same canonical bytes
  // the in-browser verifier reconstructs.
  const reconstructed = canonicalClaimBytes({
    author_sub: claim.author_sub,
    author_email: claim.author_email,
    workbook_id: "deterministic_wb_id",
    key_id: claim.key_id,
    ts: claim.ts,
  });
  const importedPub = await subtle.importKey(
    "raw",
    pubRaw,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const ok = await subtle.verify({ name: "Ed25519" }, importedPub, sigBytes, reconstructed);
  check("claim sig verifies under correct pubkey", ok === true);

  // And under a different keypair the same sig must fail.
  const wrong = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const wrongOk = await subtle.verify({ name: "Ed25519" }, wrong.publicKey, sigBytes, reconstructed);
  check("claim sig fails under wrong pubkey", wrongOk === false);
}

// 4. Required-field validation.
{
  let threw = false;
  try {
    await wrapStudio({
      html: "<p>x</p>",
      brokerUrl: BROKER,
      policy: POLICY,
      claim: { author_sub: "x", author_email: "x@y", key_id: "k" }, // no ts
    });
  } catch (e) {
    threw = e.message.includes("claim.ts");
  }
  check("missing claim.ts → wrap throws", threw);
}
{
  let threw = false;
  try {
    await wrapStudio({
      html: "<p>x</p>",
      brokerUrl: BROKER,
      policy: POLICY,
      claim: {
        author_sub: "x",
        author_email: "y@z",
        key_id: "k",
        ts: 1700000000,
      },
      claimSig: "not base64url because spaces!",
    });
  } catch (e) {
    threw = e.message.includes("claimSig");
  }
  check("invalid claimSig shape → wrap throws", threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
