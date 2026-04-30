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
import { verifyBlock, isSigned } from "./signature";
import type { WorkbookData } from "./htmlBindings";

/** What a cell sees after resolution. */
export interface ResolvedData {
  id: string;
  mime: string;
  /** Text mimes get a string; binary mimes get bytes; encrypted
   *  binary blocks in wasmIsolation mode get an opaque handle. */
  value: string | Uint8Array | WasmPlaintextHandle;
  /** True if served from in-memory cache (same id resolved earlier). */
  fromCache: boolean;
}

export interface WorkbookDataResolver {
  /** Resolve a single block. Throws on integrity mismatch / fetch failure. */
  resolve(block: WorkbookData): Promise<ResolvedData>;
  /** Resolve every block in the workbook in parallel. */
  resolveAll(blocks: WorkbookData[]): Promise<Map<string, ResolvedData>>;
  /** Drop the in-memory result cache. Does NOT clear the cached
   *  passphrase — call forgetPassphrase() for that. */
  clear(): void;
  /**
   * Drop the cached passphrase. Next encrypted-block resolve will
   * re-prompt via requestPassword. Use when the user "logs out" of
   * the workbook or to force a re-auth before sensitive operations.
   */
  forgetPassphrase(): void;
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
  /**
   * If set, signed `<wb-data>` blocks must carry a pubkey matching
   * this base64 string. Pinning protects against an attacker who
   * substitutes their own (pubkey, sig) pair to authenticate
   * tampered content. Without pinning, signature verification
   * still proves "this block hasn't been tampered after authoring"
   * but NOT "the author is the one you expect."
   *
   * Recommended: store the workbook's expected author pubkey in
   * IDB or in your app's code, pass it here on every mount.
   */
  expectedAuthorPubkey?: string;
  /**
   * Policy for unsigned blocks. Default: "allow" — unsigned blocks
   * pass through (Phase A behavior). Set to "require" to refuse
   * any block missing a (pubkey, sig) pair — useful in production
   * where every author is expected to sign.
   */
  signaturePolicy?: "allow" | "require";
  /**
   * Auto-drop the cached passphrase after N ms of inactivity. Each
   * successful encrypted-block resolve resets the idle timer; if N
   * ms elapse with no further resolves, the cache is cleared and
   * the next encrypted block re-prompts via requestPassword.
   *
   * Default: undefined (no auto-forget — passphrase persists until
   * explicit forgetPassphrase() or resolver GC). Reasonable values:
   *   5 * 60_000   for sensitive data (5 min)
   *   30 * 60_000  for low-friction UX (30 min)
   *
   * Useful in apps where the user opens a sensitive workbook,
   * walks away, and someone else sits down at the laptop.
   */
  passphraseIdleTimeoutMs?: number;
  /**
   * Phase E — keep decrypted plaintext inside WASM linear memory
   * instead of JS heap. Cells with `reads=` references to encrypted
   * blocks receive an opaque {kind: "wasm-handle", id, dispose}
   * value rather than raw bytes; cell dispatchers that understand
   * handles (Polars-SQL via runPolarsSqlIpcHandles) read bytes
   * directly from the Rust registry.
   *
   * Requires the runtime WASM module — pass the `wasm` option (or
   * loadRuntime() the JS exports) so the resolver can call into
   * ageDecryptToHandle. If unset, the resolver falls back to the
   * typage-based JS decrypt (Phase A behavior).
   *
   * Trade-offs:
   *   - cells without handle support get an export() escape hatch
   *     that copies bytes to JS — same exposure as Phase A.
   *   - the analytical query path (Polars-SQL over encrypted CSVs,
   *     SQLite TODO) keeps bytes in Rust. THIS is the win.
   *
   * Closes the "plaintext lives in JS heap" item in
   * encryption.SECURITY.md.
   */
  wasmIsolation?: {
    /** Loaded runtime WASM exports — the resolver dereferences
     *  ageDecryptToHandle, handleDispose, etc. on this. */
    wasm: import("./wasmBridge").WorkbookRuntimeWasm;
  };
}

/** Phase E: an opaque reference to plaintext bytes living in WASM
 *  linear memory. Cells receive these instead of Uint8Array when
 *  the resolver is in wasmIsolation mode. */
export interface WasmPlaintextHandle {
  readonly kind: "wasm-handle";
  readonly id: number;
  /** Byte-length of the plaintext. */
  readonly bytes: number;
  /** Copy the plaintext into JS as a Uint8Array. Escape hatch for
   *  cell paths that don't support handles natively. Defeats the
   *  isolation property — call sparingly. */
  export(): Uint8Array;
  /** Drop the bytes from the registry. Idempotent. */
  dispose(): void;
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
  //
  // SECURITY NOTE: cachedPassword lives in the JS heap until the
  // resolver is GC'd or forgetPassphrase() is called. JS doesn't
  // enforce closure privacy cryptographically, so a determined
  // attacker with JS-execution privilege in the page can in
  // principle read it. Phase E (#46) moves the cache to WASM-side.
  let cachedPassword: string | null = null;
  // Track all WasmPlaintextHandles we've issued so clear() / GC
  // can dispose every Rust-side slot. Without this, a long session
  // would leak plaintext bytes in WASM linear memory across
  // workbook reloads.
  const issuedHandles = new Set<WasmPlaintextHandle>();
  // Dedup concurrent prompts: if two encrypted blocks resolve in
  // parallel before the cache is filled, both would call
  // requestPassword without this single-flight promise.
  let inflightPasswordRequest: Promise<string> | null = null;
  // Idle-forget timer. Reset on every successful decryptOrReprompt
  // call. When it fires, cachedPassword is cleared so the next
  // encrypted resolve re-prompts. setTimeout in ms; falsy disables.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  function bumpIdleTimer() {
    const ms = opts.passphraseIdleTimeoutMs;
    if (!ms || ms <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      cachedPassword = null;
      idleTimer = null;
    }, ms);
  }

  /** Get the passphrase for encrypted blocks, prompting via the
   *  host's requestPassword callback only if we haven't already
   *  cached one for this resolver lifetime. Concurrent calls share
   *  the same promise so the host UX shows ONE prompt. */
  async function getPassword(): Promise<string> {
    if (cachedPassword !== null) return cachedPassword;
    if (inflightPasswordRequest) return inflightPasswordRequest;
    if (!opts.requestPassword) {
      throw new Error(
        "workbook data: encrypted block encountered but no " +
          "requestPassword callback was passed to " +
          "createWorkbookDataResolver. The host must wire a passphrase UX.",
      );
    }
    inflightPasswordRequest = (async () => {
      try {
        const pw = await opts.requestPassword!();
        if (!pw) {
          throw new Error("workbook data: empty passphrase from requestPassword");
        }
        cachedPassword = pw;
        return pw;
      } finally {
        inflightPasswordRequest = null;
      }
    })();
    return inflightPasswordRequest;
  }

  /** Drop the cached passphrase. */
  function forgetPassphrase(): void {
    cachedPassword = null;
    inflightPasswordRequest = null;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  /** Phase E: decrypt via Rust, get back a handle, build the
   *  WasmPlaintextHandle wrapper. Verifies sha256 inside Rust so
   *  bytes never cross the boundary on the integrity-check step. */
  async function decryptToHandle(
    ciphertext: Uint8Array,
    block: WorkbookData,
  ): Promise<WasmPlaintextHandle> {
    const wasm = opts.wasmIsolation!.wasm;
    if (
      !wasm.ageDecryptToHandle ||
      !wasm.handleDispose ||
      !wasm.handleSize ||
      !wasm.handleExport ||
      !wasm.handleSha256
    ) {
      throw new Error(
        "wasmIsolation: runtime build missing handle-registry bindings " +
          "(ageDecryptToHandle / handleDispose / handleSize / handleExport / handleSha256)",
      );
    }
    const password = await getPassword();
    let id: number;
    try {
      id = wasm.ageDecryptToHandle(ciphertext, password);
      bumpIdleTimer();
    } catch (e) {
      cachedPassword = null;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      throw new Error(
        `workbook data ${block.id}: decryption failed (likely wrong passphrase): ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }
    // Verify plaintext sha256 against the declared digest WITHOUT
    // exporting bytes — handleSha256 hashes inside Rust.
    const sha256 = (block.source as { sha256: string }).sha256;
    const got = wasm.handleSha256(id);
    if (got !== sha256) {
      // Tampered or wrong-content payload. Drop the slot before
      // throwing so we don't leak the bytes that didn't match.
      wasm.handleDispose(id);
      throw new Error(
        `workbook data integrity check failed for ${block.id}: ` +
          `expected ${sha256}, got ${got}`,
      );
    }
    const wasmRef = wasm;
    const handle: WasmPlaintextHandle = {
      kind: "wasm-handle",
      id,
      bytes: wasmRef.handleSize!(id),
      export() { return wasmRef.handleExport!(id); },
      dispose() { wasmRef.handleDispose!(id); },
    };
    issuedHandles.add(handle);
    return handle;
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
      const plaintext = await decryptWithPassphrase(ciphertext, password);
      // Successful decrypt — reset the idle-forget timer.
      bumpIdleTimer();
      return plaintext;
    } catch (e) {
      cachedPassword = null;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
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

  /** Apply the signature policy:
   *   - signed block: verify against expectedAuthorPubkey if pinned
   *   - unsigned block: allow (default) or refuse (if policy = require)
   *
   * Throws on any failure; returns void on success. Called BEFORE
   * decrypt so a tampered block never reaches the decrypt path. */
  function verifyOrPolicyCheck(block: WorkbookData, ciphertext: Uint8Array): void {
    const policy = opts.signaturePolicy ?? "allow";
    if (isSigned(block)) {
      verifyBlock(
        {
          id: block.id,
          mime: block.mime,
          encryption: block.encryption ?? "",
          // sha256 in canonical bytes is the source-of-truth attribute
          // value — same string the author signed. Only binary forms
          // reach this code path so source.sha256 is always present.
          sha256: (block.source as { sha256: string }).sha256,
          ciphertext,
        },
        { pubkey: block.pubkey, sig: block.sig },
        opts.expectedAuthorPubkey,
      );
    } else if (policy === "require") {
      throw new Error(
        `workbook data ${block.id}: signaturePolicy="require" but block is unsigned. ` +
          `Sign the block via "workbook encrypt --sign-key …".`,
      );
    }
  }

  async function resolveOne(block: WorkbookData): Promise<ResolvedData> {
    const cached = cache.get(block.id);
    if (cached) return { ...cached, fromCache: true };

    let bytes: Uint8Array | null = null;
    let text: string | null = null;
    let handle: WasmPlaintextHandle | null = null;

    if (block.source.kind === "inline-text") {
      if (block.source.sha256) {
        const enc = new TextEncoder().encode(block.source.content);
        await verifyDigest(enc, block.source.sha256, block.id);
      }
      text = block.source.content;
    } else if (block.source.kind === "inline-base64") {
      bytes = decodeBase64(block.source.base64);
      verifyOrPolicyCheck(block, bytes);
      if (block.encryption === "age-v1" && opts.wasmIsolation) {
        // Phase E: bytes never cross to JS. Rust does decrypt +
        // sha256 + holds plaintext.
        handle = await decryptToHandle(bytes, block);
        bytes = null;
      } else if (block.encryption === "age-v1") {
        bytes = await decryptOrReprompt(bytes, block.id);
        await verifyDigest(bytes, block.source.sha256, block.id);
      } else {
        await verifyDigest(bytes, block.source.sha256, block.id);
      }
      if (block.compression && bytes) {
        bytes = await decompress(bytes, block.compression);
      }
    } else {
      bytes = await fetchExternal(block.source.src, block.source.bytes);
      verifyOrPolicyCheck(block, bytes);
      if (block.encryption === "age-v1" && opts.wasmIsolation) {
        handle = await decryptToHandle(bytes, block);
        bytes = null;
      } else if (block.encryption === "age-v1") {
        bytes = await decryptOrReprompt(bytes, block.id);
        await verifyDigest(bytes, block.source.sha256, block.id);
      } else {
        await verifyDigest(bytes, block.source.sha256, block.id);
      }
      if (block.compression && bytes) {
        bytes = await decompress(bytes, block.compression);
      }
    }

    // Materialize into the shape the consuming cell expects.
    let value: string | Uint8Array | WasmPlaintextHandle;
    if (handle !== null) {
      value = handle;
    } else if (text !== null) {
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
      // Dispose every issued plaintext handle so the Rust-side
      // registry doesn't leak across workbook unloads.
      for (const h of issuedHandles) {
        try { h.dispose(); } catch { /* idempotent — ignore */ }
      }
      issuedHandles.clear();
    },
    forgetPassphrase,
  };
}
