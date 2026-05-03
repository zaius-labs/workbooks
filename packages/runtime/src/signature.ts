/**
 * Ed25519 per-block signing for `<wb-data encryption=...>` blocks.
 * (#39 Phase C — closes the attribute-tamper + author-identity gaps
 * documented in encryption.SECURITY.md.)
 *
 * Threat addressed
 * ----------------
 * age's auth tag protects ciphertext integrity, but does NOT cover
 * the wrapping `<wb-data>` element's attributes. An attacker with
 * file-modify access can today:
 *
 *   1. Substitute a different age envelope (encrypted with the same
 *      passphrase if known, or just garbage) — caught by sha256
 *      verify on plaintext.
 *   2. Change `id="orders"` → `id="orders_2"`, swapping decrypted
 *      content into a different cell's reads= namespace. NOT caught.
 *   3. Change `mime="text/csv"` → `mime="application/json"`, causing
 *      the consumer to misinterpret valid plaintext. NOT caught.
 *   4. Substitute a completely different file from the same author
 *      and same workbook — sha256 mismatches but the user sees a
 *      "wrong file" rather than "tampered file."
 *
 * (2) and (3) are the real holes. Per-block Ed25519 signature over
 * the canonical byte sequence:
 *
 *   wbdata-sig-v1 \n
 *   id=<id> \n
 *   mime=<mime> \n
 *   encryption=<encryption-tag> \n
 *   sha256=<plaintext sha256> \n
 *   ciphertext bytes
 *
 * closes both. Tamper with any attribute or any ciphertext byte =
 * signature fails.
 *
 * Trust model
 * -----------
 * The pubkey is in the file (self-signed). To prevent an attacker
 * from substituting their own (pubkey, sig) pair, the resolver
 * accepts an optional `expectedAuthorPubkey` — the host pins the
 * legitimate author's pubkey out-of-band (in code, in IDB, in a
 * trust file). Without pinning, the signature still proves "this
 * block hasn't been tampered after authoring" but NOT "the author
 * is the one you expect."
 *
 * Pubkeys are 32 raw bytes; serialized as base64 for the attribute.
 * Same for signatures (64 bytes raw → base64).
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

// noble-ed25519 v3 requires registering a sha512 implementation
// once before sync sign/verify can run. Idempotent — multiple
// imports just overwrite the same property.
ed.hashes.sha512 = sha512;

/** Bump this when the canonical byte format changes. Mismatched
 *  versions reject signing/verifying. */
export const SIGNATURE_VERSION = "wbdata-sig-v1";

/** What the parser surfaces from `<wb-data pubkey=... sig=...>` —
 *  both base64 strings. Either both present (signed block) or
 *  neither (unsigned). */
export interface WorkbookDataSignature {
  /** Base64 of the 32-byte Ed25519 public key. */
  pubkey: string;
  /** Base64 of the 64-byte Ed25519 signature. */
  sig: string;
}

/** Inputs needed to sign or verify one block — the same canonical
 *  byte sequence both sides feed into ed25519. */
export interface SignableBlock {
  id: string;
  mime: string;
  encryption: string;
  sha256: string;
  ciphertext: Uint8Array;
}

// ─── Base64 helpers ─────────────────────────────────────────────
//
// Browsers + Node both have btoa/atob today (Node 16+). Wrapping
// to Uint8Array conversions for clarity at call sites.

function bytesToB64(b: Uint8Array): string {
  // chunked to avoid argument-count limits on String.fromCharCode
  const CHUNK = 0x8000;
  let s = "";
  for (let i = 0; i < b.byteLength; i += CHUNK) {
    s += String.fromCharCode(...b.subarray(i, Math.min(i + CHUNK, b.byteLength)));
  }
  return btoa(s);
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Build the canonical byte sequence the signature is computed
 *  over. Deterministic — same inputs always produce same bytes. */
function canonicalBytes(b: SignableBlock): Uint8Array {
  const enc = new TextEncoder();
  const head = enc.encode(
    `${SIGNATURE_VERSION}\n` +
      `id=${b.id}\n` +
      `mime=${b.mime}\n` +
      `encryption=${b.encryption}\n` +
      `sha256=${b.sha256}\n`,
  );
  const out = new Uint8Array(head.byteLength + b.ciphertext.byteLength);
  out.set(head, 0);
  out.set(b.ciphertext, head.byteLength);
  return out;
}

/** Generate a fresh Ed25519 keypair. Returns base64-encoded keys
 *  ready to write to attribute strings or files. */
export function generateKeypair(): { privateKey: string; publicKey: string } {
  const { secretKey, publicKey } = ed.keygen();
  return {
    privateKey: bytesToB64(secretKey),
    publicKey: bytesToB64(publicKey),
  };
}

/** Recover the Ed25519 public key from a private key. Useful for
 *  callers who only stored the private key — they don't need to
 *  manage the pubkey separately. */
export function publicKeyFromPrivate(privateKeyB64: string): string {
  const sk = b64ToBytes(privateKeyB64);
  if (sk.byteLength !== 32) {
    throw new Error(`Ed25519 secret key must be 32 bytes, got ${sk.byteLength}`);
  }
  return bytesToB64(ed.getPublicKey(sk));
}

/** Sign a block. Returns the (pubkey, sig) pair as base64 strings,
 *  ready to set as attributes on the `<wb-data>` element. */
export function signBlock(
  block: SignableBlock,
  privateKeyB64: string,
): WorkbookDataSignature {
  const sk = b64ToBytes(privateKeyB64);
  if (sk.byteLength !== 32) {
    throw new Error(`Ed25519 secret key must be 32 bytes, got ${sk.byteLength}`);
  }
  const msg = canonicalBytes(block);
  const sig = ed.sign(msg, sk);
  const pk = ed.getPublicKey(sk);
  return { pubkey: bytesToB64(pk), sig: bytesToB64(sig) };
}

/** Verify a signature. Throws on:
 *   - malformed pubkey/sig (wrong length, bad base64)
 *   - signature mismatch (any byte of the canonical message changed)
 *   - expectedAuthorPubkey mismatch when pinning was requested
 *
 * Returns true on success — symmetric with throwing on failure so
 * callers can wrap in `if (await verifyBlock(...))` or just throw-
 * pass through a try/catch. */
export function verifyBlock(
  block: SignableBlock,
  signature: WorkbookDataSignature,
  expectedAuthorPubkey?: string,
): true {
  if (expectedAuthorPubkey && signature.pubkey !== expectedAuthorPubkey) {
    throw new Error(
      `signature pubkey mismatch: file claims '${signature.pubkey.slice(0, 12)}...' ` +
        `but caller pinned '${expectedAuthorPubkey.slice(0, 12)}...'`,
    );
  }
  const pk = b64ToBytes(signature.pubkey);
  if (pk.byteLength !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${pk.byteLength}`);
  }
  const sig = b64ToBytes(signature.sig);
  if (sig.byteLength !== 64) {
    throw new Error(`Ed25519 signature must be 64 bytes, got ${sig.byteLength}`);
  }
  const msg = canonicalBytes(block);
  const ok = ed.verify(sig, msg, pk);
  if (!ok) {
    throw new Error(
      `signature verification failed for block '${block.id}' — ` +
        `the file was modified after signing, or the signature is from a different author`,
    );
  }
  return true;
}

/** True if a `<wb-data>` element has a (pubkey, sig) pair attached.
 *  Used by the resolver to decide whether to invoke verifyBlock. */
export function isSigned(
  block: { pubkey?: string; sig?: string },
): block is { pubkey: string; sig: string } {
  return typeof block.pubkey === "string" && typeof block.sig === "string";
}
