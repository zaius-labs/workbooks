/**
 * Workbook data resolver — materializes `<wb-data>` blocks into the
 * bytes/strings cells consume via `reads=`.
 *
 * Three storage forms (parsed in htmlBindings.ts):
 *   inline-text:   plain string in element body
 *   inline-base64: base64 in element body, sha256 required
 *   external:      src URL fetched on demand, sha256 required
 *
 * Pipeline per block:
 *   1. Fetch (external) or decode (base64) or pass through (text).
 *   2. Optional decompression (gzip / zstd via DecompressionStream).
 *   3. SHA-256 verify against the declared digest. Mismatch throws.
 *   4. Materialize as the shape the consuming cell language expects:
 *        text mimes  → string
 *        binary      → Uint8Array
 *
 * External fetches reuse the host-allowlist pattern from
 * createModelArtifactResolver (core-0id.8): a workbook can't make the
 * page fetch arbitrary hosts. Default allowlist is empty — embedders
 * must opt in to the hosts they trust. (Differs from model artifacts,
 * where Hugging Face origins are baked in. Data is more arbitrary, so
 * the safer default is "no external".)
 *
 * Resolution is cached in-memory per resolver instance — same data id
 * referenced by N cells is fetched + verified once.
 */

import { sha256Hex } from "./modelArtifactResolver";
import { decryptWithPassphrase, looksLikeAgeEnvelope } from "./encryption";
import type { WorkbookData } from "./htmlBindings";

/** What a cell sees after resolution. */
export interface ResolvedData {
  id: string;
  mime: string;
  /** Text mimes get a string; binary mimes get bytes. */
  value: string | Uint8Array;
  /** True if served from in-memory cache (same id resolved earlier). */
  fromCache: boolean;
}

export interface WorkbookDataResolver {
  /** Resolve a single block. Throws on integrity mismatch / fetch failure. */
  resolve(block: WorkbookData): Promise<ResolvedData>;
  /** Resolve every block in the workbook in parallel. */
  resolveAll(blocks: WorkbookData[]): Promise<Map<string, ResolvedData>>;
  /** Drop the in-memory cache. */
  clear(): void;
}

export interface WorkbookDataResolverOptions {
  /**
   * Hostnames allowed to serve external `<wb-data src=...>`. Default
   * is the empty allowlist — `external` blocks throw unless the host
   * is explicitly opted in. Pass `null` to disable host validation
   * (use only for trusted-author scenarios; a workbook can otherwise
   * exfiltrate via tracking pixels).
   */
  allowedHosts?: string[] | null;
  /** Override fetch (auth headers, retries). Defaults to global fetch. */
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  /**
   * Called when the resolver encounters a `<wb-data encryption="...">`
   * block. Host wires its own UX (password modal, passkey ceremony,
   * etc.) and returns the passphrase. Called once per resolver
   * lifetime if a session-cache hit isn't available.
   *
   * If unset, encrypted blocks throw — the host hasn't opted in to
   * the auth flow.
   */
  requestPassword?: () => Promise<string>;
}

const TEXT_MIMES = new Set<string>([
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/jsonl",
]);

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
    throw new Error(`workbook data fetch failed: ${url} → ${resp.status}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

/** Decode base64 (with whitespace already stripped at parse). */
function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function decompress(
  bytes: Uint8Array,
  algo: "gzip" | "zstd",
): Promise<Uint8Array> {
  // DecompressionStream supports "gzip" and "deflate" everywhere.
  // "deflate-raw" is wider; "zstd" lands in browsers later 2025+. If
  // the runtime is missing a stream, surface a clear error rather
  // than a cryptic TypeError.
  const supported =
    typeof DecompressionStream !== "undefined" &&
    // @ts-expect-error — the constructor accepts any string; test by try/catch.
    (() => { try { new DecompressionStream(algo); return true; } catch { return false; } })();
  if (!supported) {
    throw new Error(
      `workbook data: ${algo} decompression not supported by this runtime`,
    );
  }
  const ds = new DecompressionStream(algo as CompressionFormat);
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export function createWorkbookDataResolver(
  opts: WorkbookDataResolverOptions = {},
): WorkbookDataResolver {
  const allow: ReadonlyArray<string> | null =
    opts.allowedHosts === null ? null : opts.allowedHosts ?? [];
  const fetchBytes = opts.fetchBytes ?? defaultFetchBytes;
  const cache = new Map<string, ResolvedData>();
  // Session-cache the passphrase across encrypted blocks: ask once,
  // unlock all blocks. Reset to null on any decryption failure so the
  // next attempt re-prompts (likely wrong passphrase). The cache is
  // resolver-instance scoped — disposed when the resolver is.
  let cachedPassword: string | null = null;

  /** Get the passphrase for encrypted blocks, prompting via the
   *  host's requestPassword callback only if we haven't already
   *  cached one for this resolver lifetime. */
  async function getPassword(): Promise<string> {
    if (cachedPassword !== null) return cachedPassword;
    if (!opts.requestPassword) {
      throw new Error(
        "workbook data: encrypted block encountered but no " +
          "requestPassword callback was passed to " +
          "createWorkbookDataResolver. The host must wire a passphrase UX.",
      );
    }
    cachedPassword = await opts.requestPassword();
    if (!cachedPassword) {
      throw new Error("workbook data: empty passphrase from requestPassword");
    }
    return cachedPassword;
  }

  /** Try to decrypt; on failure, drop the cached password so the
   *  next call re-prompts (the user likely typed it wrong). */
  async function decryptOrReprompt(
    ciphertext: Uint8Array,
    blockId: string,
  ): Promise<Uint8Array> {
    if (!looksLikeAgeEnvelope(ciphertext)) {
      throw new Error(
        `workbook data ${blockId}: bytes don't look like an age v1 envelope`,
      );
    }
    const password = await getPassword();
    try {
      return await decryptWithPassphrase(ciphertext, password);
    } catch (e) {
      cachedPassword = null;
      throw new Error(
        `workbook data ${blockId}: decryption failed (likely wrong passphrase): ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  async function fetchExternal(
    src: string,
    declaredBytes: number | undefined,
  ): Promise<Uint8Array> {
    if (allow !== null && !hostAllowed(src, allow)) {
      throw new Error(
        `workbook data host not in allowlist: ${src}. ` +
          `Pass allowedHosts to createWorkbookDataResolver.`,
      );
    }
    const bytes = await fetchBytes(src);
    if (declaredBytes !== undefined && bytes.byteLength !== declaredBytes) {
      throw new Error(
        `workbook data size mismatch for ${src}: ` +
          `declared ${declaredBytes}, got ${bytes.byteLength}`,
      );
    }
    return bytes;
  }

  /** Verify bytes match the declared sha256. Used both for ciphertext
   *  (non-encrypted blocks) and plaintext (after decryption). */
  async function verifyDigest(
    bytes: Uint8Array,
    expectedSha: string,
    blockId: string,
  ): Promise<void> {
    const got = await sha256Hex(bytes);
    if (got !== expectedSha) {
      throw new Error(
        `workbook data integrity check failed for ${blockId}: ` +
          `expected ${expectedSha}, got ${got}`,
      );
    }
  }

  async function resolveOne(block: WorkbookData): Promise<ResolvedData> {
    const cached = cache.get(block.id);
    if (cached) return { ...cached, fromCache: true };

    let bytes: Uint8Array | null = null;
    let text: string | null = null;

    if (block.source.kind === "inline-text") {
      // Inline-text blocks aren't encryptable in Phase A — the
      // ciphertext is binary regardless of source mime. Authors who
      // want encryption must use base64 + sha256 form.
      if (block.source.sha256) {
        const enc = new TextEncoder().encode(block.source.content);
        await verifyDigest(enc, block.source.sha256, block.id);
      }
      text = block.source.content;
    } else if (block.source.kind === "inline-base64") {
      bytes = decodeBase64(block.source.base64);
      // If encrypted: decrypt FIRST, then sha256 attests to plaintext,
      // then optionally decompress. Pipeline order matters — we want
      // sha256 to reflect what the AUTHOR's CSV/etc. hashes to,
      // independent of compression algorithm choice.
      if (block.encryption === "age-v1") {
        bytes = await decryptOrReprompt(bytes, block.id);
      }
      await verifyDigest(bytes, block.source.sha256, block.id);
      if (block.compression) bytes = await decompress(bytes, block.compression);
    } else {
      bytes = await fetchExternal(block.source.src, block.source.bytes);
      if (block.encryption === "age-v1") {
        bytes = await decryptOrReprompt(bytes, block.id);
      }
      await verifyDigest(bytes, block.source.sha256, block.id);
      if (block.compression) bytes = await decompress(bytes, block.compression);
    }

    // Materialize into the shape the consuming cell expects.
    let value: string | Uint8Array;
    if (text !== null) {
      value = text;
    } else if (bytes && TEXT_MIMES.has(block.mime)) {
      value = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } else if (bytes) {
      value = bytes;
    } else {
      throw new Error(`workbook data: no payload resolved for ${block.id}`);
    }

    const out: ResolvedData = {
      id: block.id,
      mime: block.mime,
      value,
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
