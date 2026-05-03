/**
 * Workbook memory resolver — materializes `<wb-memory>` blocks into
 * Arrow IPC stream bytes that Polars (or, later, DataFusion) can
 * register as queryable tables.
 *
 * Symmetric to `workbookDataResolver.ts` but specialized for binary
 * Arrow IPC payloads. The two resolvers don't share an interface
 * because their consumers differ:
 *
 *   data resolver    → cells via reads= as string|Uint8Array params
 *   memory resolver  → runtime client registers tables BEFORE cells run
 *
 * Memory blocks are append-shaped, so the resolver is also the
 * source of truth for the in-WASM Arrow buffer that
 * `client.appendMemory(id, rows)` mutates. Re-exporting on save
 * goes through the runtime client, not this file.
 */

import { sha256Hex } from "./modelArtifactResolver";
import type { WorkbookMemory } from "./htmlBindings";

export interface ResolvedMemory {
  id: string;
  /** Raw Arrow IPC stream bytes — leading schema message + record
   *  batches. Consumers register this as a Polars table. */
  bytes: Uint8Array;
  /** True if served from in-memory cache. */
  fromCache: boolean;
}

export interface WorkbookMemoryResolver {
  resolve(block: WorkbookMemory): Promise<ResolvedMemory>;
  resolveAll(blocks: WorkbookMemory[]): Promise<Map<string, ResolvedMemory>>;
  /** Drop the in-memory cache. */
  clear(): void;
}

export interface WorkbookMemoryResolverOptions {
  /**
   * Hostnames allowed to serve external `<wb-memory src=...>`. Default
   * is the empty allowlist — `external` blocks throw unless opted in.
   * Pass `null` to disable host validation. Same posture as
   * createWorkbookDataResolver: stricter than the model resolver
   * because memory sources are inherently more arbitrary.
   */
  allowedHosts?: string[] | null;
  /** Override fetch (auth headers, retries). Defaults to global fetch. */
  fetchBytes?: (url: string) => Promise<Uint8Array>;
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
    throw new Error(`workbook memory fetch failed: ${url} → ${resp.status}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Lightweight magic-byte check on the resolved bytes. Arrow IPC
 * stream format starts with a continuation token (0xFFFFFFFF) followed
 * by a flatbuffer Schema message. We don't fully validate the schema —
 * Polars does that on register — but we surface a clearer error than
 * "polars: invalid schema" if someone passes a non-Arrow blob.
 */
function looksLikeArrowIpcStream(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8) return false;
  // Continuation marker: 0xFFFFFFFF in little-endian u32.
  return (
    bytes[0] === 0xff &&
    bytes[1] === 0xff &&
    bytes[2] === 0xff &&
    bytes[3] === 0xff
  );
}

export function createWorkbookMemoryResolver(
  opts: WorkbookMemoryResolverOptions = {},
): WorkbookMemoryResolver {
  const allow: ReadonlyArray<string> | null =
    opts.allowedHosts === null ? null : opts.allowedHosts ?? [];
  const fetchBytes = opts.fetchBytes ?? defaultFetchBytes;
  const cache = new Map<string, ResolvedMemory>();

  async function fetchExternal(
    src: string,
    expectedSha: string,
    declaredBytes: number | undefined,
  ): Promise<Uint8Array> {
    if (allow !== null && !hostAllowed(src, allow)) {
      throw new Error(
        `workbook memory host not in allowlist: ${src}. ` +
          `Pass allowedHosts to createWorkbookMemoryResolver.`,
      );
    }
    const bytes = await fetchBytes(src);
    if (declaredBytes !== undefined && bytes.byteLength !== declaredBytes) {
      throw new Error(
        `workbook memory size mismatch for ${src}: ` +
          `declared ${declaredBytes}, got ${bytes.byteLength}`,
      );
    }
    const got = await sha256Hex(bytes);
    if (got !== expectedSha) {
      throw new Error(
        `workbook memory integrity check failed for ${src}: ` +
          `expected ${expectedSha}, got ${got}`,
      );
    }
    return bytes;
  }

  async function resolveOne(block: WorkbookMemory): Promise<ResolvedMemory> {
    const cached = cache.get(block.id);
    if (cached) return { ...cached, fromCache: true };

    let bytes: Uint8Array;
    if (block.source.kind === "inline-base64") {
      bytes = decodeBase64(block.source.base64);
      const got = await sha256Hex(bytes);
      if (got !== block.source.sha256) {
        throw new Error(
          `workbook memory integrity check failed for ${block.id}: ` +
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

    if (!looksLikeArrowIpcStream(bytes)) {
      throw new Error(
        `workbook memory ${block.id}: payload does not look like an ` +
          `Arrow IPC stream (missing 0xFFFFFFFF continuation marker)`,
      );
    }

    const out: ResolvedMemory = { id: block.id, bytes, fromCache: false };
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
