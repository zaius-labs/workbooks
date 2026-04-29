/**
 * Workbook history resolver — content-addressed Merkle commit chain
 * of the workbook itself. Backed by a Prolly Tree (Merkle-B-tree
 * with rolling-hash chunk boundaries; same primitive Dolt and IPLD
 * use). Status: parser shipped, resolver stubbed.
 *
 * --- Why this primitive ---
 *
 * <wb-data> stores authored datasets. <wb-memory> stores append-shaped
 * tabular state. <wb-doc> stores live mergeable document state. None
 * of those answer "what changed in this workbook over time, by whom,
 * verifiably?" The git-shaped answer for a single HTML file is a
 * Merkle commit chain — every commit points at a content-addressed
 * root, every root references content-addressed chunks. Properties:
 *
 *   - corruption is detectable (hash mismatch on read)
 *   - structural three-way merge across forked workbooks (history
 *     independence: same logical content → same root hash regardless
 *     of edit order)
 *   - copy-on-write writes touch O(log n) chunks, not the whole file
 *   - dedups across history (unchanged subtrees are shared)
 *
 * --- Why it's stubbed today ---
 *
 * No maintained JS Prolly Tree library exists. Dolt has it in Go;
 * IPLD has fragments in JS but not as a clean primitive. A
 * production-quality Rust+WASM implementation is roughly 2-3 months
 * of focused work. Worth doing only if forkable cryptographic audit
 * becomes a tier-one product feature.
 *
 * --- Eventual algorithm sketch (when the epic lands) ---
 *
 * Chunk store: Map<sha256-hex, Uint8Array>. Each chunk is a leaf
 * (raw content) or interior node (sorted list of (key, child-hash)
 * pairs). Chunk boundaries determined by a rolling hash over the
 * content (typical approach: Rabin-Karp or buzhash, target chunk
 * size 4 KB, max 64 KB).
 *
 * Commit: { parent: sha256 | null, root: sha256, timestamp, author?,
 * message? }. Encoded as canonical JSON, hashed, stored as a chunk.
 *
 * HEAD: a single sha256 pointing at the latest commit chunk.
 *
 * Read: HEAD → commit chunk → root chunk → walk to leaf, materialize.
 * Write: build new leaf → propagate new (key, hash) up to new root →
 * new commit chunk → update HEAD. Old chunks remain in the store
 * (history is preserved); GC by reachability when needed.
 *
 * Three-way merge: find common ancestor commit by walking parent
 * chains; structurally diff each side against ancestor; combine
 * non-conflicting changes; surface conflicts (same key, different
 * content on both sides) for caller resolution.
 *
 * --- Serialization shape inside <wb-history> ---
 *
 * Body is a base64'd serialization of:
 *   { head: sha256-hex, chunks: { sha256-hex → bytes } }
 *
 * The outer sha256 attribute hashes that whole serialized blob (for
 * tamper detection on the file itself); the head-sha256 attribute
 * names the current commit (for fast readers that can verify HEAD
 * without rebuilding the whole tree).
 */

import { sha256Hex } from "./modelArtifactResolver";
import type { WorkbookHistory } from "./htmlBindings";

/** Stub return — when the real implementation lands this becomes a
 *  rich handle with checkout/diff/merge/log. */
export interface ResolvedHistory {
  id: string;
  format: WorkbookHistory["format"];
  headSha256: string;
  /** The raw chunk-store bytes after sha256 verification. The real
   *  resolver decodes these into a chunk Map; for now they're returned
   *  as-is for hosts that want to ship custom tooling alongside. */
  bytes: Uint8Array;
  fromCache: boolean;
}

export interface WorkbookHistoryResolver {
  resolve(block: WorkbookHistory): Promise<ResolvedHistory>;
  resolveAll(blocks: WorkbookHistory[]): Promise<Map<string, ResolvedHistory>>;
  clear(): void;
}

export interface WorkbookHistoryResolverOptions {
  allowedHosts?: string[] | null;
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  /**
   * If false (default), resolution throws to surface that history
   * traversal isn't yet implemented. Set true to verify bytes +
   * head sha256 only and return raw bytes — useful for hosts that
   * want to surface "history exists, real reader pending" UI.
   */
  bytesOnly?: boolean;
}

function hostAllowed(rawUrl: string, allow: ReadonlyArray<string>): boolean {
  let parsed: URL;
  try { parsed = new URL(rawUrl); }
  catch { return false; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase();
  return allow.some((h) => h.toLowerCase() === host);
}

async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`workbook history fetch failed: ${url} → ${resp.status}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function createWorkbookHistoryResolver(
  opts: WorkbookHistoryResolverOptions = {},
): WorkbookHistoryResolver {
  const allow: ReadonlyArray<string> | null =
    opts.allowedHosts === null ? null : opts.allowedHosts ?? [];
  const fetchBytes = opts.fetchBytes ?? defaultFetchBytes;
  const cache = new Map<string, ResolvedHistory>();
  const bytesOnly = opts.bytesOnly === true;

  async function fetchExternal(
    src: string,
    expectedSha: string,
    declaredBytes: number | undefined,
  ): Promise<Uint8Array> {
    if (allow !== null && !hostAllowed(src, allow)) {
      throw new Error(
        `workbook history host not in allowlist: ${src}. ` +
          `Pass allowedHosts to createWorkbookHistoryResolver.`,
      );
    }
    const bytes = await fetchBytes(src);
    if (declaredBytes !== undefined && bytes.byteLength !== declaredBytes) {
      throw new Error(
        `workbook history size mismatch for ${src}: ` +
          `declared ${declaredBytes}, got ${bytes.byteLength}`,
      );
    }
    const got = await sha256Hex(bytes);
    if (got !== expectedSha) {
      throw new Error(
        `workbook history integrity check failed for ${src}: ` +
          `expected ${expectedSha}, got ${got}`,
      );
    }
    return bytes;
  }

  async function resolveOne(block: WorkbookHistory): Promise<ResolvedHistory> {
    const cached = cache.get(block.id);
    if (cached) return { ...cached, fromCache: true };

    let bytes: Uint8Array;
    if (block.source.kind === "inline-base64") {
      bytes = decodeBase64(block.source.base64);
      const got = await sha256Hex(bytes);
      if (got !== block.source.sha256) {
        throw new Error(
          `workbook history integrity check failed for ${block.id}: ` +
            `expected ${block.source.sha256}, got ${got}`,
        );
      }
    } else {
      bytes = await fetchExternal(
        block.source.src,
        block.source.sha256,
        block.source.bytes,
      );
    }

    if (!bytesOnly) {
      throw new Error(
        `<wb-history> traversal not yet implemented for format ` +
          `${block.format} — bytes verified, but the Prolly Tree reader ` +
          `is the dedicated 2-3 month epic. Pass bytesOnly: true to ` +
          `createWorkbookHistoryResolver to opt into raw-bytes resolution ` +
          `for tooling that ships its own reader.`,
      );
    }

    const out: ResolvedHistory = {
      id: block.id,
      format: block.format,
      headSha256: block.headSha256,
      bytes,
      fromCache: false,
    };
    cache.set(block.id, out);
    return out;
  }

  return {
    resolve: resolveOne,
    async resolveAll(blocks) {
      const entries = await Promise.all(
        blocks.map(async (b) => [b.id, await resolveOne(b)] as const),
      );
      return new Map(entries);
    },
    clear() {
      cache.clear();
    },
  };
}
