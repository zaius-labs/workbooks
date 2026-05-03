// @work.books/decrypt — pure-browser decrypt primitives.
//
// Single source of truth for unwrapping sealed Workbooks envelopes.
// Today's two formats:
//
//   studio-v1   broker-released DEK, AES-256-GCM per view, identity-
//               gated. Recipient signs in via @work.books/auth-ui →
//               broker releases DEK via HPKE-sealed transport → this
//               module's decryptStudioV1 unwraps the AAD-bound view
//               ciphertext.
//
//   age-v1      passphrase-encrypted, scrypt + chacha20-poly1305.
//               Fully offline — no broker, no internet. This module's
//               decryptAgeV1 wraps the official age-encryption npm
//               package; recipient pastes the passphrase, decrypt
//               runs entirely in the browser.
//
// Designed to run in browsers (WebCrypto SubtleCrypto), Workers, and
// node 18+ (which exposes globalThis.crypto.subtle natively). No
// node-only deps.

import * as ageEncryption from "age-encryption";
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";

// ── Envelope detection ──────────────────────────────────────────────

/** Parse a fetched HTML response into a discriminated envelope. */
export function parseEnvelope(html) {
  const enc = readMeta(html, "wb-encryption");
  if (!enc) {
    return { kind: "plain", html };
  }
  if (enc === "studio-v1") {
    return parseStudioV1(html);
  }
  if (enc === "age-v1") {
    return parseAgeV1(html);
  }
  return { kind: "unsupported", encryption: enc };
}

function readMeta(html, name) {
  const re = new RegExp(
    `<meta\\s+name=["']${name}["']\\s+content=(['"])(.*?)\\1`,
    "i",
  );
  const m = re.exec(html);
  return m ? decodeHtmlEntities(m[2]) : null;
}
function decodeHtmlEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// ── studio-v1 ───────────────────────────────────────────────────────

function parseStudioV1(html) {
  const workbookId = readMeta(html, "wb-workbook-id");
  const brokerUrl = readMeta(html, "wb-broker-url");
  const policyHash = readMeta(html, "wb-policy-hash");
  const cipher = readMeta(html, "wb-cipher");
  const viewsRaw = readMeta(html, "wb-views");
  if (!workbookId || !brokerUrl || !policyHash || !cipher || !viewsRaw) {
    return { kind: "malformed", encryption: "studio-v1", reason: "missing required meta tags" };
  }
  let views;
  try {
    views = JSON.parse(viewsRaw);
  } catch (e) {
    return { kind: "malformed", encryption: "studio-v1", reason: "wb-views is not JSON" };
  }
  const payloadMatch =
    /<script[^>]*id=["']wb-payload["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  const payloadB64 = payloadMatch ? payloadMatch[1].trim() : null;
  if (!payloadB64) {
    return { kind: "malformed", encryption: "studio-v1", reason: "missing wb-payload script" };
  }
  return {
    kind: "studio-v1",
    workbookId,
    brokerUrl,
    policyHash,
    cipher,
    views,
    payloadB64,
  };
}

/** Decrypt one view of a studio-v1 envelope.
 *
 *  Inputs:
 *    envelope    — return value of parseEnvelope(html), kind: 'studio-v1'
 *    viewId      — which view's bytes to decrypt (the broker releases
 *                  per-view DEKs based on the recipient's identity)
 *    dek         — Uint8Array(32), the per-view AES-256-GCM key the
 *                  broker released (HPKE-unsealed before this call)
 *
 *  Returns: Uint8Array of the cleartext bytes for that view.
 */
export async function decryptStudioV1({ envelope, viewId, dek }) {
  if (envelope.kind !== "studio-v1") {
    throw new Error("decryptStudioV1: not a studio-v1 envelope");
  }
  const view = envelope.views.find((v) => v.id === viewId);
  if (!view) {
    throw new Error(`decryptStudioV1: view ${viewId} not in envelope`);
  }
  const payload = base64ToBytes(envelope.payloadB64);
  const ciphertext = payload.slice(view.offset, view.offset + view.len);
  const iv = b64uToBytes(view.iv);
  const mac = b64uToBytes(view.mac);

  // Reassemble GCM ct||tag (split was emitter-side — see wrapStudio).
  const sealed = new Uint8Array(ciphertext.length + mac.length);
  sealed.set(ciphertext, 0);
  sealed.set(mac, ciphertext.length);

  const ad = new TextEncoder().encode(
    `studio-v1|${envelope.workbookId}|${viewId}|${envelope.policyHash}`,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    dek,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const cleartext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: ad, tagLength: 128 },
    key,
    sealed,
  );
  return new Uint8Array(cleartext);
}

// ── HPKE transport for studio-v1 ────────────────────────────────────
//
// Broker → recipient hop encrypts each released DEK to a recipient-
// supplied X25519 transport pubkey using HPKE base mode (RFC 9180,
// suite DHKEM(X25519,HKDF-SHA256) + HKDF-SHA256 + ChaCha20Poly1305).
// Same suite the broker uses (apps/workbooks-broker/src/lib/sealed.ts);
// changing this string is a hard format break.

const HPKE_INFO = new TextEncoder().encode("studio-v1/dek-transport");

function hpkeSuite() {
  return new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });
}

/** Generate an X25519 keypair for one /key call. The private key
 *  never leaves the recipient's tab; the public key goes to the
 *  broker on the request body. Returns objects ready for hand-off:
 *  pubkeyB64u for the network, privateKey (a CryptoKey) for unsealing. */
export async function generateTransportKeypair() {
  const suite = hpkeSuite();
  const kp = await suite.kem.generateKeyPair();
  const pubBytes = new Uint8Array(await suite.kem.serializePublicKey(kp.publicKey));
  const pubkeyB64u = bytesToB64u(pubBytes);
  return { privateKey: kp.privateKey, pubkeyB64u };
}

/** Open one sealed_dek the broker returned. Inputs:
 *    sealedDekB64u — base64url(enc || ciphertext) from the broker
 *    privateKey    — CryptoKey from generateTransportKeypair()
 *    workbookId / viewId / policyHash — AAD binding (must match the
 *                                       broker's seal-time AAD or
 *                                       AES-GCM rejects)
 *  Returns the raw 32-byte DEK as a Uint8Array. Caller passes that
 *  to decryptStudioV1.
 */
export async function unsealDek(args) {
  const { sealedDekB64u, privateKey, workbookId, viewId, policyHash } = args;
  const all = b64uToBytes(sealedDekB64u);
  const enc = all.slice(0, 32);
  const ct = all.slice(32);
  const suite = hpkeSuite();
  const recipient = await suite.createRecipientContext({
    recipientKey: privateKey,
    enc: enc.buffer,
    info: HPKE_INFO,
  });
  const ad = new TextEncoder().encode(
    `studio-v1|${workbookId}|${viewId}|${policyHash}`,
  );
  const dekBuf = await recipient.open(ct.buffer, ad);
  return new Uint8Array(dekBuf);
}

function bytesToB64u(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── age-v1 ──────────────────────────────────────────────────────────

function parseAgeV1(html) {
  const cipherMatch =
    /<script[^>]*id=["']wb-cipher["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  const cipherB64 = cipherMatch ? cipherMatch[1].trim() : null;
  if (!cipherB64) {
    return { kind: "malformed", encryption: "age-v1", reason: "missing wb-cipher script" };
  }
  return {
    kind: "age-v1",
    cipherB64,
  };
}

/** Decrypt an age-v1 envelope. Pure offline — uses the `age-encryption`
 *  npm package which is portable across browsers + Workers + node.
 *
 *  Inputs:
 *    envelope    — return value of parseEnvelope(html), kind: 'age-v1'
 *    passphrase  — utf-8 string the recipient typed
 *
 *  Returns: Uint8Array of the cleartext bytes (the workbook HTML).
 */
export async function decryptAgeV1({ envelope, passphrase }) {
  if (envelope.kind !== "age-v1") {
    throw new Error("decryptAgeV1: not an age-v1 envelope");
  }
  const cipherBytes = base64ToBytes(envelope.cipherB64);
  const decrypter = new ageEncryption.Decrypter();
  decrypter.addPassphrase(passphrase);
  const cleartext = await decrypter.decrypt(cipherBytes);
  return cleartext;
}

// ── Helpers ─────────────────────────────────────────────────────────

function base64ToBytes(s) {
  const clean = s.replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64uToBytes(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(b64);
}
