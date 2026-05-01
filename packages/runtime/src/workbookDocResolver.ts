/**
 * Workbook doc resolver — materializes `<wb-doc>` blocks into loaded
 * CRDT handles. Phase 2 of core-0or made Yjs the only backend; the
 * legacy `format="loro"` path was dropped (pre-1.0 product) and old
 * workbook files migrate via host-side ports (see color.wave's
 * one-time IDB migration).
 *
 * Cells consume docs read-only via `reads=` — they receive a JSON
 * projection of the current state. Host-driven mutation goes through
 * `client.docMutate(id, ops)`, which routes through this resolver's
 * dispatcher.
 */

import { sha256Hex } from "./modelArtifactResolver";
import {
  createYjsDispatcher,
  type YjsDispatcher,
  type LoroDocHandle,
} from "./yjsSidecar";
import type { WorkbookDoc } from "./htmlBindings";

export interface ResolvedDoc {
  id: string;
  format: WorkbookDoc["format"];
  /** Loaded CRDT handle. Use `.toJSON()` for cell consumption. */
  handle: LoroDocHandle;
  fromCache: boolean;
}

export interface WorkbookDocResolver {
  resolve(block: WorkbookDoc): Promise<ResolvedDoc>;
  resolveAll(blocks: WorkbookDoc[]): Promise<Map<string, ResolvedDoc>>;
  /** Drop every cached handle. */
  clear(): void;
}

export interface WorkbookDocResolverOptions {
  /**
   * Hostnames allowed to serve external `<wb-doc src=...>`. Default
   * is the empty allowlist — `external` blocks throw unless opted in.
   */
  allowedHosts?: string[] | null;
  /** Override fetch (auth headers, retries). Defaults to global fetch. */
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  /** Pre-built Yjs dispatcher (e.g. shared across resolvers). */
  yjsDispatcher?: YjsDispatcher;
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
    throw new Error(`workbook doc fetch failed: ${url} → ${resp.status}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function createWorkbookDocResolver(
  opts: WorkbookDocResolverOptions = {},
): WorkbookDocResolver {
  const allow: ReadonlyArray<string> | null =
    opts.allowedHosts === null ? null : opts.allowedHosts ?? [];
  const fetchBytes = opts.fetchBytes ?? defaultFetchBytes;
  const yjs = opts.yjsDispatcher ?? createYjsDispatcher();
  const cache = new Map<string, ResolvedDoc>();

  async function fetchExternal(
    src: string,
    expectedSha: string,
    declaredBytes: number | undefined,
  ): Promise<Uint8Array> {
    if (allow !== null && !hostAllowed(src, allow)) {
      throw new Error(
        `workbook doc host not in allowlist: ${src}. ` +
          `Pass allowedHosts to createWorkbookDocResolver.`,
      );
    }
    const bytes = await fetchBytes(src);
    if (declaredBytes !== undefined && bytes.byteLength !== declaredBytes) {
      throw new Error(
        `workbook doc size mismatch for ${src}: ` +
          `declared ${declaredBytes}, got ${bytes.byteLength}`,
      );
    }
    const got = await sha256Hex(bytes);
    if (got !== expectedSha) {
      throw new Error(
        `workbook doc integrity check failed for ${src}: ` +
          `expected ${expectedSha}, got ${got}`,
      );
    }
    return bytes;
  }

  async function resolveOne(block: WorkbookDoc): Promise<ResolvedDoc> {
    const cached = cache.get(block.id);
    if (cached) return { ...cached, fromCache: true };

    let bytes: Uint8Array;
    if (block.source.kind === "empty") {
      bytes = new Uint8Array(0);
    } else if (block.source.kind === "inline-base64") {
      bytes = decodeBase64(block.source.base64);
      const got = await sha256Hex(bytes);
      if (got !== block.source.sha256) {
        throw new Error(
          `workbook doc integrity check failed for ${block.id}: ` +
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

    let handle: LoroDocHandle;
    if (block.format === "yjs") {
      handle = await yjs.load({ id: block.id, bytes });
    } else {
      throw new Error(`unsupported wb-doc format: ${(block as { format: string }).format}`);
    }

    const out: ResolvedDoc = { id: block.id, format: block.format, handle, fromCache: false };
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
      yjs.dispose();
    },
  };
}
