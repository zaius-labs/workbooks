// Substrate CID — content identifier.
// Format: `blake3-` + 32 lowercase hex chars.
//
// Production uses Blake3-256 truncated to 32 chars (16 bytes). Until the
// Blake3 binding is wired into the runtime crate, we ship a SHA-256
// fallback (truncated identically). The CID prefix stays `blake3-` so
// migration is transparent — all existing CIDs remain valid; new ones
// recompute identically to old ones because we always use the same
// algorithm in a given runtime version.
//
// The `data-cid` attribute on snapshot blocks is recomputed on parse and
// cross-checked. If you change the algorithm, every CID in every
// existing workbook becomes invalid. Don't do this lightly.

import type { Cid } from "./types";

const ALGO_PREFIX = "blake3-";
const HEX_LEN = 32; // 16 bytes of digest

/** Compute a substrate CID from raw bytes.
 *
 *  Uses Web Crypto SHA-256 truncated to 16 bytes. When the Blake3 wasm
 *  binding lands in @work.books/runtime, swap the digest call here. */
export async function cidOf(bytes: Uint8Array | string): Promise<Cid> {
  const buf =
    typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const hash = await crypto.subtle.digest("SHA-256", buf as BufferSource);
  return ALGO_PREFIX + hexFromArrayBuffer(hash, HEX_LEN);
}

/** Synchronous variant — used inside hot loops where bytes are already
 *  in-memory. Falls back to a JS-implemented SHA-256 if WebCrypto's
 *  async API is unavailable (e.g. older Node). */
export function cidOfSync(bytes: Uint8Array | string): Cid {
  const buf =
    typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return ALGO_PREFIX + hex(sha256_bytes(buf)).slice(0, HEX_LEN);
}

/** Compose CID inputs into a single hash buffer per the format spec:
 *  cid = blake3_32(parent_cid || target || seq || payload)
 *  where seq is encoded as 8-byte big-endian.  */
export function opCidInputs(
  parentCid: Cid,
  target: string,
  seq: number,
  payload: Uint8Array,
): Uint8Array {
  const parentBytes = new TextEncoder().encode(parentCid);
  const targetBytes = new TextEncoder().encode(target);
  const seqBytes = new Uint8Array(8);
  // Big-endian uint64 — JS numbers max ~2^53 so we can split simply.
  const view = new DataView(seqBytes.buffer);
  view.setBigUint64(0, BigInt(seq), false);
  const total = parentBytes.length + targetBytes.length + 8 + payload.length;
  const out = new Uint8Array(total);
  let o = 0;
  out.set(parentBytes, o); o += parentBytes.length;
  out.set(targetBytes, o); o += targetBytes.length;
  out.set(seqBytes, o); o += 8;
  out.set(payload, o);
  return out;
}

export async function opCid(
  parentCid: Cid,
  target: string,
  seq: number,
  payload: Uint8Array,
): Promise<Cid> {
  return cidOf(opCidInputs(parentCid, target, seq, payload));
}

export function opCidSync(
  parentCid: Cid,
  target: string,
  seq: number,
  payload: Uint8Array,
): Cid {
  return cidOfSync(opCidInputs(parentCid, target, seq, payload));
}

// ── primitives ──────────────────────────────────────────────────

function hexFromArrayBuffer(buf: ArrayBuffer, byteCount: number): string {
  const bytes = new Uint8Array(buf, 0, byteCount / 2);
  return hex(bytes);
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

// Minimal SHA-256 — used as the synchronous fallback. Standard FIPS-180-4
// implementation. Replace with Blake3 when the wasm binding lands.
function sha256_bytes(input: Uint8Array): Uint8Array {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const len = input.length;
  const bitLen = BigInt(len) * 8n;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(input);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setBigUint64(padded.length - 8, bitLen, false);

  const W = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i], false);
  return out;
}

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}
