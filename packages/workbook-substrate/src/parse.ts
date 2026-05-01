// Substrate v0 parser + integrity verifier.
//
// Input: an HTML string OR a Document (e.g. window.document inside the
// running runtime). Output: a fully-validated SubstrateFile or a
// SubstrateError.
//
// Wire contract: vendor/workbooks/docs/SUBSTRATE_FORMAT_V0.md.

import {
  SubstrateError,
  type SubstrateFile,
  type SubstrateMeta,
  type Snapshot,
  type WalOp,
  type Cid,
} from "./types";
import { cidOf, opCidInputs } from "./cid";

/** Parse + verify a substrate workbook from HTML text.
 *
 *  Use case: Node test harnesses, build-time validators, conformance
 *  suite. */
export async function parseSubstrateFromHtml(html: string): Promise<SubstrateFile> {
  const meta = await readMeta(html);
  const snapshots = await readSnapshots(html);
  const wal = await readWal(html);
  await verifyChain(meta, snapshots, wal);
  const fingerprint = await fingerprintOf(snapshots);
  return { meta, snapshots, wal, fingerprint };
}

/** Parse + verify a substrate workbook from a Document instance.
 *
 *  Use case: the runtime running inside the workbook itself. Reads via
 *  `document.getElementById(...)` — fastest path, no re-parse cost. */
export async function parseSubstrateFromDocument(doc: Document): Promise<SubstrateFile> {
  const meta = await readMetaFromDoc(doc);
  const snapshots = await readSnapshotsFromDoc(doc);
  const wal = await readWalFromDoc(doc);
  await verifyChain(meta, snapshots, wal);
  const fingerprint = await fingerprintOf(snapshots);
  return { meta, snapshots, wal, fingerprint };
}

// ─── meta ─────────────────────────────────────────────────────────

async function readMeta(html: string): Promise<SubstrateMeta> {
  const text = extractScript(html, "wb-meta");
  if (text == null) {
    throw new SubstrateError("missing-meta", `<script id="wb-meta"> not found`);
  }
  return parseMeta(text);
}

async function readMetaFromDoc(doc: Document): Promise<SubstrateMeta> {
  const el = doc.getElementById("wb-meta");
  if (!el) throw new SubstrateError("missing-meta", `<script id="wb-meta"> not found`);
  return parseMeta(el.textContent ?? "");
}

function parseMeta(text: string): SubstrateMeta {
  let m: any;
  try {
    m = JSON.parse(text);
  } catch (e) {
    throw new SubstrateError("invalid-meta-json",
      `wb-meta JSON parse failed: ${(e as Error).message}`);
  }
  if (m?.substrate_version !== "v0") {
    throw new SubstrateError("unsupported-substrate-version",
      `unsupported substrate_version=${JSON.stringify(m?.substrate_version)} (this runtime supports v0)`);
  }
  if (typeof m.workbook_id !== "string" || m.workbook_id.length === 0) {
    throw new SubstrateError("invalid-meta-json", "wb-meta.workbook_id missing");
  }
  if (typeof m.compaction_seq !== "number") {
    throw new SubstrateError("invalid-meta-json", "wb-meta.compaction_seq missing");
  }
  if (m.snapshot_cid_by_target == null || typeof m.snapshot_cid_by_target !== "object") {
    throw new SubstrateError("invalid-meta-json", "wb-meta.snapshot_cid_by_target missing");
  }
  return {
    workbook_id: m.workbook_id,
    substrate_version: "v0",
    schema_version: typeof m.schema_version === "number" ? m.schema_version : 0,
    created_at: m.created_at,
    compaction_seq: m.compaction_seq,
    snapshot_cid_by_target: m.snapshot_cid_by_target,
  };
}

// ─── snapshots ────────────────────────────────────────────────────

const SNAPSHOT_ID_PREFIX = "wb-snapshot:";

async function readSnapshots(html: string): Promise<Map<string, Snapshot>> {
  const re = /<script[^>]*\bid="(wb-snapshot:[^"]+)"[^>]*>([\s\S]*?)<\/script>/gi;
  const out = new Map<string, Snapshot>();
  for (const m of html.matchAll(re)) {
    const id = m[1];
    const text = m[2];
    // Pull attributes back out of the matched tag header.
    const headerEnd = html.indexOf(">", html.indexOf(id, m.index!)) + 1;
    const tagHeader = html.slice(m.index!, headerEnd);
    const cid = attr(tagHeader, "data-cid");
    const format = attr(tagHeader, "data-format") ?? "bytes";
    if (cid == null) {
      throw new SubstrateError("snapshot-cid-mismatch",
        `snapshot ${id} missing data-cid attribute`);
    }
    out.set(id.slice(SNAPSHOT_ID_PREFIX.length),
      await materializeSnapshot(id, text, cid, format));
  }
  return out;
}

async function readSnapshotsFromDoc(doc: Document): Promise<Map<string, Snapshot>> {
  const out = new Map<string, Snapshot>();
  const els = doc.querySelectorAll(`script[id^="${SNAPSHOT_ID_PREFIX}"]`);
  for (const el of els) {
    const id = el.getAttribute("id") ?? "";
    const cid = el.getAttribute("data-cid");
    const format = el.getAttribute("data-format") ?? "bytes";
    if (cid == null) {
      throw new SubstrateError("snapshot-cid-mismatch",
        `snapshot ${id} missing data-cid attribute`);
    }
    out.set(id.slice(SNAPSHOT_ID_PREFIX.length),
      await materializeSnapshot(id, el.textContent ?? "", cid, format));
  }
  return out;
}

async function materializeSnapshot(
  id: string, b64Raw: string, expectedCid: Cid, format: string,
): Promise<Snapshot> {
  const b64 = b64Raw.replace(/\s/g, "");
  const bytes = decodeBase64(b64);
  const actual = await cidOf(bytes);
  if (actual !== expectedCid) {
    throw new SubstrateError("snapshot-cid-mismatch",
      `snapshot ${id}: data-cid=${expectedCid}, computed=${actual}`);
  }
  return {
    target: id.slice(SNAPSHOT_ID_PREFIX.length),
    bytes,
    cid: expectedCid,
    format,
  };
}

// ─── WAL ──────────────────────────────────────────────────────────

async function readWal(html: string): Promise<WalOp[]> {
  const text = extractScript(html, "wb-wal");
  if (text == null) {
    throw new SubstrateError("missing-wal", `<script id="wb-wal"> not found`);
  }
  return parseWal(text);
}

async function readWalFromDoc(doc: Document): Promise<WalOp[]> {
  const el = doc.getElementById("wb-wal");
  if (!el) throw new SubstrateError("missing-wal", `<script id="wb-wal"> not found`);
  return parseWal(el.textContent ?? "");
}

function parseWal(text: string): WalOp[] {
  if (text.trim().length === 0) return [];
  let arr: any;
  try {
    arr = JSON.parse(text);
  } catch (e) {
    throw new SubstrateError("invalid-wal-json",
      `wb-wal JSON parse failed: ${(e as Error).message}`);
  }
  if (!Array.isArray(arr)) {
    throw new SubstrateError("invalid-wal-json", "wb-wal must be a JSON array");
  }
  return arr.map((o, i) => {
    if (typeof o.seq !== "number" || typeof o.target !== "string"
      || typeof o.parent_cid !== "string" || typeof o.cid !== "string"
      || typeof o.payload_b64 !== "string") {
      throw new SubstrateError("invalid-wal-json",
        `wb-wal[${i}] missing required field`);
    }
    return {
      seq: o.seq,
      target: o.target,
      parent_cid: o.parent_cid,
      cid: o.cid,
      ts: o.ts,
      payload: decodeBase64(o.payload_b64),
    };
  });
}

// ─── chain integrity ──────────────────────────────────────────────

async function verifyChain(
  meta: SubstrateMeta,
  snapshots: Map<string, Snapshot>,
  wal: WalOp[],
): Promise<void> {
  // 1. Cross-check meta.snapshot_cid_by_target against actual snapshot CIDs.
  for (const [target, expectedCid] of Object.entries(meta.snapshot_cid_by_target)) {
    const snap = snapshots.get(target);
    if (snap && snap.cid !== expectedCid) {
      throw new SubstrateError("snapshot-cid-mismatch",
        `meta.snapshot_cid_by_target[${target}]=${expectedCid} but snapshot.cid=${snap.cid}`);
    }
  }

  // 2. WAL seq strictly monotonic.
  for (let i = 1; i < wal.length; i++) {
    if (wal[i].seq <= wal[i - 1].seq) {
      throw new SubstrateError("wal-seq-non-monotonic",
        `wal[${i}].seq=${wal[i].seq} not > wal[${i - 1}].seq=${wal[i - 1].seq}`);
    }
  }

  // 3. Per-target parent-CID chain + per-op CID verify.
  // Trailing-op recovery: if the LAST op fails CID verify, we discard it
  // (mutates the wal array in place) and don't fail. If anything earlier
  // fails, the file is corrupt.
  //
  // When a target has NO snapshot yet (first op for a fresh target),
  // the writer uses a stable sentinel parent CID (32 zeros) — see
  // mutate.ts. The parser must agree on that sentinel; otherwise the
  // first op's parent_cid !== expected (`undefined`) and every saved
  // file fails to load on the next session. Was a real bug.
  const NO_PARENT_SENTINEL = "blake3-" + "0".repeat(32);
  const lastCid = new Map<string, Cid>(Object.entries(meta.snapshot_cid_by_target));
  for (let i = 0; i < wal.length; i++) {
    const op = wal[i];
    const expectedParent =
      lastCid.get(op.target)
      ?? meta.snapshot_cid_by_target[op.target]
      ?? NO_PARENT_SENTINEL;
    if (expectedParent !== op.parent_cid) {
      if (i === wal.length - 1) {
        wal.pop(); // trailing-op recovery
        return;
      }
      throw new SubstrateError("wal-parent-cid-broken",
        `wal[seq=${op.seq}] target=${op.target}: parent_cid=${op.parent_cid} expected=${expectedParent}`);
    }
    const recomputed = await cidOf(opCidInputs(op.parent_cid, op.target, op.seq, op.payload));
    if (recomputed !== op.cid) {
      if (i === wal.length - 1) {
        wal.pop();
        return;
      }
      throw new SubstrateError("wal-cid-mismatch",
        `wal[seq=${op.seq}]: cid=${op.cid} computed=${recomputed}`);
    }
    lastCid.set(op.target, op.cid);
  }
}

// ─── content fingerprint ──────────────────────────────────────────

async function fingerprintOf(snapshots: Map<string, Snapshot>): Promise<Cid> {
  // Canonical: sort target names, concat "target=cid;" pairs, hash.
  const keys = [...snapshots.keys()].sort();
  const canonical = keys.map((k) => `${k}=${snapshots.get(k)!.cid};`).join("");
  return cidOf(canonical);
}

// ─── helpers ──────────────────────────────────────────────────────

function extractScript(html: string, id: string): string | null {
  const idEsc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<script[^>]*\\bid="${idEsc}"[^>]*>([\\s\\S]*?)</script>`, "i");
  const m = html.match(re);
  return m ? m[1] : null;
}

function attr(tagHeader: string, name: string): string | null {
  const re = new RegExp(`\\b${name}="([^"]*)"`, "i");
  const m = tagHeader.match(re);
  return m ? m[1] : null;
}

function decodeBase64(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node fallback
  return new Uint8Array(Buffer.from(b64, "base64"));
}
