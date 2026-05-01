/**
 * HTML-first workbook bindings.
 *
 * The DOM IS the workbook. Author a workbook as plain HTML using a
 * small custom-element vocabulary; the runtime parses the document at
 * mount time, builds the same internal spec the JSON path produces,
 * and drives the executor. No build step, no framework, view-source
 * works, fork-in-the-browser works.
 *
 *   <wb-workbook name="example">
 *     <wb-input name="n" type="number" default="40"/>
 *     <wb-cell id="doubled" language="rhai" reads="n">n * 2</wb-cell>
 *     <wb-cell id="summary" language="rhai" reads="doubled">doubled + 1</wb-cell>
 *     <wb-output for="summary"/>
 *   </wb-workbook>
 *
 * Plus agent + tool elements for in-workbook agents:
 *
 *   <wb-agent id="analyst" model="openai/gpt-4o-mini" reads="result">
 *     <wb-system>You are a precise data analyst.</wb-system>
 *     <wb-tool ref="result"/>
 *   </wb-agent>
 *   <wb-chat for="analyst"/>
 *
 * Plugin API (`registerWorkbookCell`) lets third-party packages ship
 * new cell languages by registering an executor; HTML authors then
 * use `<wb-cell language="my-language">…</wb-cell>` and the new cell
 * type Just Works.
 */

import { ReactiveExecutor } from "./reactiveExecutor";
import { createRuntimeClient } from "./wasmBridge";
import type {
  Cell,
  CellLanguage,
  CellOutput,
  RuntimeClient,
  RuntimeClientOptions,
} from "./wasmBridge";
import type { CellState } from "./reactiveExecutor";
import type { LlmClient } from "./llmClient";
import { runAgentLoop, type AgentTool } from "./agentLoop";
import { createWorkbookBashTool } from "./agentBashTool";
import { sanitizeSvg } from "./util/sanitize";
import {
  createWorkbookDataResolver,
  type WorkbookDataResolver,
} from "./workbookDataResolver";
import {
  createWorkbookMemoryResolver,
  type WorkbookMemoryResolver,
} from "./workbookMemoryResolver";
import {
  createWorkbookDocResolver,
  type WorkbookDocResolver,
} from "./workbookDocResolver";
import {
  createWorkbookHistoryResolver,
  type WorkbookHistoryResolver,
} from "./workbookHistoryResolver";

// ----------------------------------------------------------------------
// Plugin registry — third parties can register cell languages.
//
// Two scopes are supported:
//   1. Module-global (legacy): registerWorkbookCell() / getRegisteredCell().
//      Anyone who imports the runtime sees the same map. Convenient for
//      one-workbook-per-page apps but unsafe for multi-tenant pages.
//   2. Per-mount (preferred, core-0id.11): pass `cellRegistry` to
//      mountHtmlWorkbook. Plugins registered there are scoped to that
//      single mount — independent workbooks on the same page can register
//      different executors for the same language without colliding.
// ----------------------------------------------------------------------

export interface CustomCellExecutor {
  /** Called when this cell needs to run. Return CellOutput[]. */
  execute: (req: {
    source: string;
    params: Record<string, unknown>;
    cellId: string;
    ctx: WorkbookContext;
  }) => Promise<CellOutput[]> | CellOutput[];
  /** Optional: render a custom output element. If unset, default
   *  output rendering kicks in (text/csv/image dispatch). */
  renderOutput?: (target: HTMLElement, outputs: CellOutput[]) => void;
}

/**
 * Scoped cell registry. Construct one per workbook mount and pass it to
 * mountHtmlWorkbook via `cellRegistry`. Lookup falls back to the
 * module-global registry when a language is not present locally.
 */
export interface WorkbookCellRegistry {
  register(language: string, impl: CustomCellExecutor): void;
  get(language: string): CustomCellExecutor | undefined;
}

export function createWorkbookCellRegistry(): WorkbookCellRegistry {
  const map = new Map<string, CustomCellExecutor>();
  return {
    register(language, impl) { map.set(language, impl); },
    get(language) { return map.get(language); },
  };
}

const customCellRegistry = new Map<string, CustomCellExecutor>();

export function registerWorkbookCell(language: string, impl: CustomCellExecutor): void {
  customCellRegistry.set(language, impl);
}

export function getRegisteredCell(language: string): CustomCellExecutor | undefined {
  return customCellRegistry.get(language);
}

// ----------------------------------------------------------------------
// Workbook context — shared across all elements inside a <wb-workbook>.
// ----------------------------------------------------------------------

export interface WorkbookContext {
  client: RuntimeClient;
  llmClient?: LlmClient;
  /** Synchronously read the latest output value for a cell id. Used by
   *  agents that want cell results as tool inputs. */
  read: (cellId: string) => CellOutput[] | undefined;
  /** Imperatively run a cell now (e.g. when an agent invokes a tool). */
  runCell: (cellId: string) => Promise<CellOutput[]>;
}

// ----------------------------------------------------------------------
// Spec extraction from DOM.
// ----------------------------------------------------------------------

interface AgentSpec {
  id: string;
  model: string;
  systemPrompt: string;
  reads: string[];
  tools: string[];
}

/**
 * A `<wb-data>` block — the SQL/blob counterpart to `<wb-input>`.
 * Inputs are scalar (number/text/boolean); data blocks are
 * sized payloads (CSV / JSON / SQLite db / parquet / arbitrary
 * bytes). Cells consume them via `reads="dataId"`, identical to how
 * they read upstream cell outputs.
 *
 * Three storage forms — the parser picks based on attributes:
 *   - inline-text:    `<wb-data id="x" mime="text/csv">id,name\n...</wb-data>`
 *   - inline-base64:  `<wb-data id="x" mime="application/x-sqlite3" encoding="base64" sha256="...">U1FMaXRl...</wb-data>`
 *   - external:       `<wb-data id="x" mime="application/parquet" src="https://..." sha256="..." bytes="..."/>`
 *
 * `sha256` is required for any binary form (inline-base64 + external)
 * — it's the integrity guarantee. Inline-text may carry sha256
 * optionally; the runtime verifies if present.
 *
 * ENCRYPTION: any binary form (inline-base64 or external) may also
 * carry `encryption="aes-gcm-pbkdf2-v1"`. When present, the bytes
 * are an encrypted payload (header + AES-GCM ciphertext); the
 * resolver fetches a passphrase via host callback, derives the key
 * via PBKDF2, decrypts, then verifies sha256 against the plaintext.
 * sha256 in this case attests to the plaintext, not the ciphertext.
 */
export type WorkbookDataEncryption = "age-v1";

export interface WorkbookData {
  id: string;
  mime: string;
  /** Optional row count hint for UI; never trusted by the runtime. */
  rows?: number;
  /** Optional pre-decompression algorithm. Applied AFTER decryption. */
  compression?: "gzip" | "zstd";
  /** Optional encryption envelope. Applied to inline-base64 + external
   *  binary forms. The resolver requests a passphrase via callback. */
  encryption?: WorkbookDataEncryption;
  /** Optional Ed25519 author pubkey (base64). Pairs with `sig`. */
  pubkey?: string;
  /** Optional Ed25519 signature (base64) over the canonical block
   *  byte sequence. Verified before decrypt — see signature.ts.
   *  Closes the attribute-tamper + author-identity gaps that age's
   *  auth tag alone doesn't cover. */
  sig?: string;
  source:
    | { kind: "inline-text"; content: string; sha256?: string }
    | { kind: "inline-base64"; base64: string; sha256: string }
    | { kind: "external"; src: string; sha256: string; bytes?: number };
}

/**
 * A `<wb-memory>` block — append-shaped tabular memory backed by an
 * Apache Arrow IPC stream. Where `<wb-data>` is for static authored
 * datasets, `<wb-memory>` is for state the workbook accumulates over
 * time: agent observations, eval traces, telemetry, conversation
 * facts. Cells query it via Polars-SQL (registered as a table
 * matching the block id).
 *
 * Writes happen out-of-band — a host-provided runtime API
 * (`client.appendMemory(id, rows)`) appends record batches in WASM
 * linear memory. Cells do not mutate memory directly; this keeps
 * side effects auditable and routable through agent tool layers.
 *
 * Two storage forms (no inline-text — Arrow IPC is binary):
 *   inline-base64: <wb-memory id encoding="base64" sha256="...">QVJ...
 *   external:      <wb-memory id src="https://..." sha256="..." bytes="..."/>
 *
 * The body is an Arrow IPC stream (a leading schema message followed
 * by record batches); appending rows = appending one more record
 * batch to the stream.
 */
export interface WorkbookMemory {
  id: string;
  /** Optional schema id (for cross-workbook schema registry). Never
   *  trusted by the runtime; cells get the schema from the IPC stream
   *  itself. */
  schemaId?: string;
  /** Optional row count hint; UI display only. */
  rows?: number;
  source:
    | { kind: "inline-base64"; base64: string; sha256: string }
    | { kind: "external"; src: string; sha256: string; bytes?: number };
}

/**
 * A `<wb-doc>` block — hierarchical mergeable state via a CRDT.
 * Where `<wb-memory>` is tabular and append-shaped, `<wb-doc>` is
 * document-shaped and mutable: nested maps, lists, text, hierarchies
 * that fork-and-merge cleanly.
 *
 * Supported formats:
 *   - "yjs"   pure-JS Yjs (only backend since Phase 2 of core-0or).
 *             Bytes are `Y.encodeStateAsUpdate(doc)` output; load via
 *             `Y.applyUpdate(doc, bytes)`. Legacy `format="loro"`
 *             files are no longer loadable by the runtime — hosts
 *             must port via a one-time IDB migration before mount
 *             (see color.wave for the pattern).
 *
 *   <wb-doc id="agent-state" format="yjs"
 *           encoding="base64" sha256="...">AQEBAAhz...</wb-doc>
 *
 * Initial ship is read-only: cells read the doc as a JSON projection
 * via reads=. Mutation API (host-driven, mirrors appendMemory) lands
 * in a follow-up.
 */
export interface WorkbookDoc {
  id: string;
  format: "yjs";
  source:
    | { kind: "inline-base64"; base64: string; sha256: string }
    | { kind: "external"; src: string; sha256: string; bytes?: number }
    | { kind: "empty" };
}

/**
 * A `<wb-history>` block — content-addressed, structurally-mergeable
 * version history of the workbook itself. Where `<wb-doc>` carries
 * the live state of one document, `<wb-history>` carries the chain
 * of commits that produced the current workbook.
 *
 * Backed by a Prolly Tree (Merkle-B-tree with rolling-hash chunk
 * boundaries — same primitive Dolt and IPLD use). Each commit
 * points at a root chunk hash; chunks are content-addressed so
 * corruption is detectable and structural three-way merge is
 * possible across forked workbooks. The body is a base64'd
 * serialization of the chunk dictionary plus a head pointer.
 *
 *   <wb-history id="changelog" format="prolly-v1"
 *               head-sha256="abc..." encoding="base64"
 *               sha256="def...">PROLLY1...</wb-history>
 *
 * Status: live. Phase-1 implementation ships depth-1 trees (single
 * leaf per commit, no rolling-hash chunking) backed by
 * runtime-wasm/src/prolly.rs — content-addressed chunks, parent-
 * chained commits, hash-verified deserialization. Three-way merge
 * + multi-level interior nodes land in Phase-2.
 */
export interface WorkbookHistory {
  id: string;
  format: "prolly-v1";
  /** sha256 of the current HEAD commit chunk. */
  headSha256: string;
  source:
    | { kind: "inline-base64"; base64: string; sha256: string }
    | { kind: "external"; src: string; sha256: string; bytes?: number };
}

interface WorkbookHtmlSpec {
  name: string;
  cells: Cell[];
  inputs: Record<string, unknown>;
  agents: AgentSpec[];
  data: WorkbookData[];
  memory: WorkbookMemory[];
  docs: WorkbookDoc[];
  history: WorkbookHistory[];
}

/**
 * Workbook identifier shape — used for cell ids, input names, agent
 * ids, and any other slot whose value flows into a CSS attribute
 * selector or HTML attribute. Locked to a conservative shape so the
 * later querySelectorAll(`wb-output[for="${id}"]`) call sites can't
 * be tricked into matching unintended nodes.
 *
 * Letters, digits, underscore, hyphen. Must start with a letter.
 * Max 64 characters. Enough for human-readable ids; rejects any
 * character that has special meaning in attribute selectors
 * (`"]`, `,`, whitespace, etc.). closes core-0id.3
 */
const VALID_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function validId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return VALID_ID.test(raw) ? raw : null;
}

/** Normalize comma/whitespace-separated ids; reject any malformed token. */
function validIdList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => VALID_ID.test(s))
    .slice(0, MAX_REFS_PER_LIST);
}

// ----------------------------------------------------------------------
// Schema caps. Defense-in-depth against pathological workbook inputs —
// a malicious or buggy workbook can't blow up parser memory or slip
// unrecognized cell languages into the runtime dispatch. closes core-0id.12
// ----------------------------------------------------------------------

const ALLOWED_LANGUAGES = new Set<CellLanguage>([
  "rhai",
  "polars",
  "sqlite",
  "candle-inference",
  "linfa-train",
  "wasm-fn",
  "chat",
]);

/**
 * Permissive enough to cover OpenRouter slugs (`openai/gpt-4o-mini`,
 * `anthropic/claude-sonnet-4-6`), HuggingFace ids
 * (`sentence-transformers/all-MiniLM-L6-v2`), version suffixes,
 * and dotted/colon variants — but rejects whitespace, quotes, angle
 * brackets, and any other character that has parsing meaning.
 */
const VALID_MODEL = /^[A-Za-z0-9._/:@-]{1,128}$/;

const MAX_CELLS = 256;
const MAX_INPUTS = 64;
const MAX_AGENTS = 32;
const MAX_TOOLS_PER_AGENT = 16;
const MAX_REFS_PER_LIST = 32;
const MAX_SOURCE_BYTES = 1 * 1024 * 1024;       // 1 MB per cell source
const MAX_SYSTEM_PROMPT_BYTES = 100 * 1024;     // 100 KB per agent prompt
const MAX_INPUT_DEFAULT_BYTES = 16 * 1024;      // 16 KB per input default

/**
 * `<wb-data>` caps. Tighter than cell source because data blocks
 * dominate workbook file size — a 50 MB inline blob bloats the HTML
 * past parser-friendly limits and torches first-paint. Authors that
 * need more push to external + sha256.
 */
const ALLOWED_DATA_MIMES = new Set<string>([
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/jsonl",
  "application/x-sqlite3",
  "application/parquet",
  "application/octet-stream",
]);
const TEXT_DATA_MIMES = new Set<string>([
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/jsonl",
]);
/** Lowercase hex sha-256. The hostBindings parser-side check; the
 *  resolver re-verifies on bytes. */
const VALID_SHA256 = /^[a-f0-9]{64}$/;
const MAX_DATA_BLOCKS = 32;
const MAX_INLINE_TEXT_BYTES = 5 * 1024 * 1024;        // 5 MB per text block
const MAX_INLINE_BASE64_CHARS = 14_000_000;            // ~10 MB binary after decode
const MAX_AGGREGATE_INLINE_BYTES = 25 * 1024 * 1024;  // 25 MB total inline
const MAX_EXTERNAL_DECLARED_BYTES = 500 * 1024 * 1024; // 500 MB declared size

/**
 * `<wb-memory>` caps. Tighter than data caps on count (memory blocks
 * tend to be fewer and larger; an explosion of memory ids is more
 * suspicious). Same per-block + aggregate limits as data — they
 * share the overall inline budget.
 */
const MAX_MEMORY_BLOCKS = 16;

/** `<wb-doc>` caps. Even tighter — a workbook with many CRDT docs is
 *  unusual, and each doc carries hierarchical state that scales fast. */
const MAX_DOC_BLOCKS = 8;
const ALLOWED_DOC_FORMATS = new Set<WorkbookDoc["format"]>(["yjs"]);

/** `<wb-history>` caps. A workbook should have at most one history
 *  block (the chain of commits that produced it). The cap is 2 to
 *  accommodate the unusual case of two parallel histories being
 *  reconciled mid-merge. */
const MAX_HISTORY_BLOCKS = 2;
const ALLOWED_HISTORY_FORMATS = new Set<WorkbookHistory["format"]>(["prolly-v1"]);

function clipString(raw: string, maxBytes: number): string {
  if (raw.length <= maxBytes) return raw;
  return raw.slice(0, maxBytes);
}

/** Parse + validate a `bytes=` attribute as a non-negative integer. */
function parseBytesAttr(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > MAX_EXTERNAL_DECLARED_BYTES) {
    return undefined;
  }
  return Math.floor(n);
}

/** http(s) only, well-formed URL. Host-allowlist enforcement happens
 *  in the resolver, not here — same split as model artifacts. */
function isFetchableUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export function parseWorkbookHtml(root: Element): WorkbookHtmlSpec {
  const name = root.getAttribute("name") ?? "html-workbook";
  const cells: Cell[] = [];
  const inputs: Record<string, unknown> = {};
  const agents: AgentSpec[] = [];
  const data: WorkbookData[] = [];
  const memory: WorkbookMemory[] = [];
  const docs: WorkbookDoc[] = [];
  const history: WorkbookHistory[] = [];
  let aggregateInlineBytes = 0;

  // Inputs.
  for (const el of root.querySelectorAll("wb-input")) {
    if (Object.keys(inputs).length >= MAX_INPUTS) break;
    const nm = validId(el.getAttribute("name"));
    if (!nm) continue;
    const type = el.getAttribute("type") ?? "text";
    const rawDef = el.getAttribute("default") ?? el.textContent?.trim() ?? "";
    const def = clipString(rawDef, MAX_INPUT_DEFAULT_BYTES);
    inputs[nm] = coerceValue(def, type);
  }

  // Cells.
  for (const el of root.querySelectorAll("wb-cell")) {
    if (cells.length >= MAX_CELLS) break;
    const id = validId(el.getAttribute("id"));
    if (!id) continue;
    const rawLang = el.getAttribute("language") ?? "rhai";
    if (!ALLOWED_LANGUAGES.has(rawLang as CellLanguage)) continue;
    const language = rawLang as CellLanguage;
    const reads = validIdList(el.getAttribute("reads"));
    const provides = validIdList(el.getAttribute("provides"));
    if (!provides.length) provides.push(id);
    const source = clipString(el.textContent?.trim() ?? "", MAX_SOURCE_BYTES);
    const cell: Cell = { id, language, source, dependsOn: reads, provides };
    cells.push(cell);
  }

  // Agents.
  for (const el of root.querySelectorAll("wb-agent")) {
    if (agents.length >= MAX_AGENTS) break;
    const id = validId(el.getAttribute("id"));
    if (!id) continue;
    const rawModel = el.getAttribute("model") ?? "openai/gpt-4o-mini";
    if (!VALID_MODEL.test(rawModel)) continue;
    const model = rawModel;
    const reads = validIdList(el.getAttribute("reads"));
    const systemEl = el.querySelector("wb-system");
    const systemPrompt = clipString(
      systemEl?.textContent?.trim() ?? "",
      MAX_SYSTEM_PROMPT_BYTES,
    );
    const tools = [...el.querySelectorAll("wb-tool")]
      .map((t) => validId(t.getAttribute("ref")))
      .filter((s): s is string => Boolean(s))
      .slice(0, MAX_TOOLS_PER_AGENT);
    agents.push({ id, model, systemPrompt, reads, tools });
  }

  // Data blocks. Cells join the same `reads=` namespace as upstream
  // cell outputs, so a `<wb-data id="orders">` is referenceable as
  // `reads="orders"` from any cell. Resolution + decode happens at
  // mount time via createWorkbookDataResolver (separate file).
  //
  // ID collisions: the `reads=` namespace is shared with <wb-input>
  // and <wb-cell> provides. A duplicate id between any of these
  // produces silent shadowing at mount (data > inputs > outputs).
  // Reject collisions here so the author sees the conflict instead.
  const usedIds = new Set<string>([
    ...Object.keys(inputs),
    ...cells.map((c) => c.id),
    ...cells.flatMap((c) => c.provides ?? []),
  ]);
  for (const el of root.querySelectorAll("wb-data")) {
    if (data.length >= MAX_DATA_BLOCKS) break;
    const id = validId(el.getAttribute("id"));
    if (!id) continue;
    if (usedIds.has(id)) continue;
    usedIds.add(id);
    const mime = (el.getAttribute("mime") ?? "").toLowerCase();
    if (!ALLOWED_DATA_MIMES.has(mime)) continue;

    const sha256Attr = (el.getAttribute("sha256") ?? "").toLowerCase();
    const sha256 = VALID_SHA256.test(sha256Attr) ? sha256Attr : null;

    const rawCompression = el.getAttribute("compression");
    const compression =
      rawCompression === "gzip" || rawCompression === "zstd"
        ? rawCompression
        : undefined;

    const rowsAttr = Number(el.getAttribute("rows"));
    const rows = Number.isFinite(rowsAttr) && rowsAttr >= 0 ? rowsAttr : undefined;

    const srcAttr = el.getAttribute("src");
    const encoding = (el.getAttribute("encoding") ?? "").toLowerCase();
    // Optional encryption envelope. Only "age-v1" supported in
    // Phase A; future versions add to the allowlist. Encrypted
    // blocks must be binary (inline-base64 or external) — no
    // encrypted-text form (the ciphertext is binary regardless).
    const encryptionAttr = el.getAttribute("encryption");
    const encryption: WorkbookDataEncryption | undefined =
      encryptionAttr === "age-v1" ? "age-v1" : undefined;

    // Optional Ed25519 signature over the canonical block bytes.
    // Pairs (pubkey, sig) — both required if either present.
    // See signature.ts for the canonical byte format.
    const pubkeyAttr = el.getAttribute("pubkey");
    const sigAttr = el.getAttribute("sig");
    // Cap to plausible base64 lengths (32-byte key → 44 chars,
    // 64-byte sig → 88 chars). Reject anything longer to stop
    // attribute-stuffing attacks that try to exhaust parser memory.
    const pubkey =
      pubkeyAttr && pubkeyAttr.length <= 64 && /^[A-Za-z0-9+/=]+$/.test(pubkeyAttr)
        ? pubkeyAttr
        : undefined;
    const sig =
      sigAttr && sigAttr.length <= 128 && /^[A-Za-z0-9+/=]+$/.test(sigAttr)
        ? sigAttr
        : undefined;

    let entry: WorkbookData | null = null;

    if (srcAttr) {
      // External form. sha256 + http(s) URL required.
      if (!sha256) continue;
      if (!isFetchableUrl(srcAttr)) continue;
      const bytes = parseBytesAttr(el.getAttribute("bytes"));
      entry = { id, mime, rows, compression, encryption, pubkey, sig, source: { kind: "external", src: srcAttr, sha256, bytes } };
    } else if (encoding === "base64") {
      // Inline binary. sha256 required; cap base64 char count to bound
      // decoded payload at ~10 MB.
      if (!sha256) continue;
      const raw = el.textContent ?? "";
      // Strip whitespace — base64 in HTML often line-wrapped.
      const base64 = raw.replace(/\s+/g, "");
      if (!base64) continue;
      if (base64.length > MAX_INLINE_BASE64_CHARS) continue;
      // Approximate decoded byte count for the aggregate budget.
      const approxBytes = Math.floor((base64.length * 3) / 4);
      if (aggregateInlineBytes + approxBytes > MAX_AGGREGATE_INLINE_BYTES) continue;
      aggregateInlineBytes += approxBytes;
      entry = { id, mime, rows, compression, encryption, pubkey, sig, source: { kind: "inline-base64", base64, sha256 } };
    } else if (TEXT_DATA_MIMES.has(mime)) {
      // Inline text. sha256 optional (editor-driven workbooks recompute
      // on save; readers verify when present).
      const content = clipString(el.textContent ?? "", MAX_INLINE_TEXT_BYTES);
      if (!content) continue;
      const byteLen = content.length;
      if (aggregateInlineBytes + byteLen > MAX_AGGREGATE_INLINE_BYTES) continue;
      aggregateInlineBytes += byteLen;
      entry = {
        id,
        mime,
        rows,
        compression,
        source: sha256
          ? { kind: "inline-text", content, sha256 }
          : { kind: "inline-text", content },
      };
    } else {
      // Binary mime without `encoding="base64"` and without `src=`
      // has no defined storage form — drop. (Authors who want raw
      // bytes inline must use base64 + sha256.)
      continue;
    }

    if (entry) data.push(entry);
  }

  // Memory blocks. Append-shaped tabular state, queryable as a Polars
  // table by id. Body must be an Arrow IPC stream — binary only, so
  // no inline-text form. Shares the inline byte budget with <wb-data>.
  for (const el of root.querySelectorAll("wb-memory")) {
    if (memory.length >= MAX_MEMORY_BLOCKS) break;
    const id = validId(el.getAttribute("id"));
    if (!id) continue;
    if (usedIds.has(id)) continue;
    usedIds.add(id);

    const sha256Attr = (el.getAttribute("sha256") ?? "").toLowerCase();
    const sha256 = VALID_SHA256.test(sha256Attr) ? sha256Attr : null;
    if (!sha256) continue; // sha256 required for any binary form

    const rowsAttr = Number(el.getAttribute("rows"));
    const rows = Number.isFinite(rowsAttr) && rowsAttr >= 0 ? rowsAttr : undefined;
    const schemaIdAttr = el.getAttribute("schema-id");
    const schemaId = schemaIdAttr && validId(schemaIdAttr) ? schemaIdAttr : undefined;

    const srcAttr = el.getAttribute("src");
    const encoding = (el.getAttribute("encoding") ?? "").toLowerCase();

    let entry: WorkbookMemory | null = null;

    if (srcAttr) {
      if (!isFetchableUrl(srcAttr)) continue;
      const bytes = parseBytesAttr(el.getAttribute("bytes"));
      entry = { id, schemaId, rows, source: { kind: "external", src: srcAttr, sha256, bytes } };
    } else if (encoding === "base64") {
      const raw = el.textContent ?? "";
      const base64 = raw.replace(/\s+/g, "");
      if (!base64) continue;
      if (base64.length > MAX_INLINE_BASE64_CHARS) continue;
      const approxBytes = Math.floor((base64.length * 3) / 4);
      if (aggregateInlineBytes + approxBytes > MAX_AGGREGATE_INLINE_BYTES) continue;
      aggregateInlineBytes += approxBytes;
      entry = { id, schemaId, rows, source: { kind: "inline-base64", base64, sha256 } };
    } else {
      // No defined storage form. Memory blocks must be binary
      // (Arrow IPC), so encoding="base64" or src= is required.
      continue;
    }

    if (entry) memory.push(entry);
  }

  // CRDT docs. Hierarchical mergeable state. Reuses the binary-only
  // storage shapes from <wb-memory> (inline-base64 or external),
  // plus a `format=` allowlist so additional CRDTs can be added
  // later without breaking existing parsers.
  for (const el of root.querySelectorAll("wb-doc")) {
    if (docs.length >= MAX_DOC_BLOCKS) break;
    const id = validId(el.getAttribute("id"));
    if (!id) continue;
    if (usedIds.has(id)) continue;
    usedIds.add(id);

    const formatAttr = el.getAttribute("format") as WorkbookDoc["format"] | null;
    if (!formatAttr || !ALLOWED_DOC_FORMATS.has(formatAttr)) continue;

    const sha256Attr = (el.getAttribute("sha256") ?? "").toLowerCase();
    const sha256 = VALID_SHA256.test(sha256Attr) ? sha256Attr : null;

    const srcAttr = el.getAttribute("src");
    const encoding = (el.getAttribute("encoding") ?? "").toLowerCase();
    const rawText = el.textContent ?? "";
    const inlineBase64 = encoding === "base64" ? rawText.replace(/\s+/g, "") : "";

    let entry: WorkbookDoc | null = null;

    if (srcAttr) {
      if (!isFetchableUrl(srcAttr)) continue;
      if (!sha256) continue; // external sources REQUIRE sha256 — integrity check
      const bytes = parseBytesAttr(el.getAttribute("bytes"));
      entry = {
        id,
        format: formatAttr,
        source: { kind: "external", src: srcAttr, sha256, bytes },
      };
    } else if (inlineBase64) {
      if (!sha256) continue; // inline-with-bytes also requires sha256
      if (inlineBase64.length > MAX_INLINE_BASE64_CHARS) continue;
      const approxBytes = Math.floor((inlineBase64.length * 3) / 4);
      if (aggregateInlineBytes + approxBytes > MAX_AGGREGATE_INLINE_BYTES) continue;
      aggregateInlineBytes += approxBytes;
      entry = {
        id,
        format: formatAttr,
        source: { kind: "inline-base64", base64: inlineBase64, sha256 },
      };
    } else {
      // Empty <wb-doc>: no src, no inline bytes. Author intent is
      // "create a fresh CRDT doc; mutations during the session land
      // back in this element on save". Common in app-shaped
      // workbooks (e.g. color.wave) that ship a blank state and use
      // the file-as-database round-trip.
      entry = {
        id,
        format: formatAttr,
        source: { kind: "empty" },
      };
    }

    if (entry) docs.push(entry);
  }

  // <wb-history> Prolly Tree blocks. Versioned commit chain of the
  // workbook itself. Format is locked here; real implementation
  // (chunk store + structural merge) is the dedicated Rust+WASM
  // Prolly-Tree epic — the resolver stub validates and throws until
  // it lands, but blocks parse cleanly so the file format doesn't
  // change when the implementation arrives.
  for (const el of root.querySelectorAll("wb-history")) {
    if (history.length >= MAX_HISTORY_BLOCKS) break;
    const id = validId(el.getAttribute("id"));
    if (!id) continue;
    if (usedIds.has(id)) continue;
    usedIds.add(id);

    const formatAttr = el.getAttribute("format") as WorkbookHistory["format"] | null;
    if (!formatAttr || !ALLOWED_HISTORY_FORMATS.has(formatAttr)) continue;

    const sha256Attr = (el.getAttribute("sha256") ?? "").toLowerCase();
    const sha256 = VALID_SHA256.test(sha256Attr) ? sha256Attr : null;
    if (!sha256) continue;

    const headShaAttr = (el.getAttribute("head-sha256") ?? "").toLowerCase();
    const headSha256 = VALID_SHA256.test(headShaAttr) ? headShaAttr : null;
    if (!headSha256) continue;

    const srcAttr = el.getAttribute("src");
    const encoding = (el.getAttribute("encoding") ?? "").toLowerCase();

    let entry: WorkbookHistory | null = null;

    if (srcAttr) {
      if (!isFetchableUrl(srcAttr)) continue;
      const bytes = parseBytesAttr(el.getAttribute("bytes"));
      entry = {
        id,
        format: formatAttr,
        headSha256,
        source: { kind: "external", src: srcAttr, sha256, bytes },
      };
    } else if (encoding === "base64") {
      const raw = el.textContent ?? "";
      const base64 = raw.replace(/\s+/g, "");
      if (!base64) continue;
      if (base64.length > MAX_INLINE_BASE64_CHARS) continue;
      const approxBytes = Math.floor((base64.length * 3) / 4);
      if (aggregateInlineBytes + approxBytes > MAX_AGGREGATE_INLINE_BYTES) continue;
      aggregateInlineBytes += approxBytes;
      entry = {
        id,
        format: formatAttr,
        headSha256,
        source: { kind: "inline-base64", base64, sha256 },
      };
    } else {
      continue;
    }

    if (entry) history.push(entry);
  }

  return { name, cells, inputs, agents, data, memory, docs, history };
}

function coerceValue(raw: string, type: string): unknown {
  if (type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  if (type === "boolean") return raw === "true" || raw === "1";
  return raw;
}

// ----------------------------------------------------------------------
// Mount — turn the DOM into a running workbook.
// ----------------------------------------------------------------------

export interface MountOptions {
  /** Required: how to load the wasm runtime. */
  loadWasm: RuntimeClientOptions["loadWasm"];
  /** Optional LLM client for agent + chat elements. */
  llmClient?: LlmClient;
  /** Override the document. Defaults to global `document`. */
  doc?: Document;
  /**
   * Per-mount cell registry. Lookups fall back to the module-global
   * registry (`registerWorkbookCell`) when a language isn't present here.
   * Use this on multi-workbook pages so plugins don't collide across
   * mounts. (core-0id.11)
   */
  cellRegistry?: WorkbookCellRegistry;
  /**
   * Override the resolver used to materialize `<wb-data>` blocks.
   * Default builds one with no `allowedHosts` (external blocks throw
   * unless the host is opted in). Pass a pre-configured resolver to
   * extend the allowlist or wire a custom fetch.
   */
  dataResolver?: WorkbookDataResolver;
  /**
   * Override the resolver used to materialize `<wb-memory>` blocks.
   * Default builds one with no `allowedHosts`. Same posture as
   * dataResolver.
   */
  memoryResolver?: WorkbookMemoryResolver;
  /**
   * Override the resolver used to materialize `<wb-doc>` CRDT blocks.
   * Default builds one with no `allowedHosts`. Constructs a fresh
   * Loro dispatcher per mount.
   */
  docResolver?: WorkbookDocResolver;
  /**
   * Override the resolver used to materialize `<wb-history>` Prolly
   * Tree blocks. Default builds a stub that verifies bytes and throws
   * on traversal — the real Prolly Tree reader is a dedicated epic.
   * Pass a configured resolver with `bytesOnly: true` to opt into
   * raw-bytes resolution if the host ships its own reader.
   */
  historyResolver?: WorkbookHistoryResolver;
  /**
   * Optional extra agent tools (core-547). Merged with the framework
   * default `bash` tool for any `<wb-agent>` whose `<wb-tool>` children
   * leave its tools array empty. Use this to register app-specific
   * mutation tools (e.g. studio-style composition.set wrappers) that
   * the standard read-only bash tool can't provide.
   *
   * Pass an empty array to OPT OUT of the default bash tool while
   * still leaving agent dispatch tool-aware.
   */
  agentTools?: AgentTool[];
  /**
   * Suppress the framework-default `bash` agent tool. When true, agents
   * with no <wb-tool> children fall back to the legacy zero-tool dispatch
   * regardless of agentTools. Useful for portable exports where the
   * just-bash dependency isn't available.
   */
  disableDefaultBashTool?: boolean;
  /**
   * Optional callback yielding skill markdown by key, surfaced to the
   * default bash tool under /workbook/skills/<key>.md. Pair with
   * `agentSkillKeys` to declare which keys to mount.
   */
  getSkillSource?: (key: string) => string | null | Promise<string | null>;
  /** Skill keys to mount in the bash tool's VFS. */
  agentSkillKeys?: string[];
}

export async function mountHtmlWorkbook(opts: MountOptions): Promise<{
  executor: ReactiveExecutor;
  ctx: WorkbookContext;
  spec: WorkbookHtmlSpec;
}> {
  const doc = opts.doc ?? document;
  const root = doc.querySelector("wb-workbook");
  if (!root) throw new Error("mountHtmlWorkbook: no <wb-workbook> in document");

  const spec = parseWorkbookHtml(root);

  // Per-mount → module-global lookup chain (core-0id.11).
  const localRegistry = opts.cellRegistry;
  const lookupCustom = (language: string): CustomCellExecutor | undefined =>
    localRegistry?.get(language) ?? customCellRegistry.get(language);

  // Build a runtime client that knows how to dispatch built-in cells via
  // wasm AND custom-registered cells via the plugin registry.
  const wasmClient = createRuntimeClient({
    loadWasm: opts.loadWasm,
    llmClient: opts.llmClient,
  });

  // Track memory block ids registered at mount so the cell-dispatch
  // wrapper can inject the right tables into RunCellRequest based on
  // the cell's `reads=` references.
  const registeredMemoryIds = new Set<string>(spec.memory.map((m) => m.id));

  // Wrap so custom cell types take precedence over wasm dispatch and
  // memory tables flow through to Polars-SQL cells without the
  // executor needing memory awareness.
  const client: RuntimeClient = {
    ...wasmClient,
    async runCell(req) {
      const custom = lookupCustom(req.cell.language);
      if (custom) {
        const outputs = await custom.execute({
          source: req.cell.source ?? "",
          params: (req.params ?? {}) as Record<string, unknown>,
          cellId: req.cell.id,
          ctx: ctxRef.current!,
        });
        return { outputs };
      }

      // Inject memory tables for any dependsOn id that resolves to a
      // registered <wb-memory> block. Cells of any language receive
      // them; only Polars-SQL routes through them today.
      const memoryTables: Record<string, Uint8Array> = {};
      for (const dep of req.cell.dependsOn ?? []) {
        if (registeredMemoryIds.has(dep) && wasmClient.exportMemory) {
          memoryTables[dep] = await wasmClient.exportMemory(dep);
        }
      }
      const enriched: typeof req = Object.keys(memoryTables).length > 0
        ? { ...req, memoryTables }
        : req;
      return wasmClient.runCell(enriched);
    },
  };

  // Expose the runtime client globally as soon as it exists — long
  // before the initial runAll resolves. SDK consumers (the cli's save
  // handler, the studio's loroBackend) poll this; setting it here
  // means their poll succeeds within ms of mount starting, not only
  // after data resolution + cell DAG run finish. The poll also waits
  // on getDocHandle, so registerDoc happening later in this function
  // is fine.
  if (typeof window !== "undefined") {
    (window as Window & { __wbRuntime?: unknown }).__wbRuntime = client;
  }

  // Forward-declared so the wrapper above can read it once we build it.
  const ctxRef: { current: WorkbookContext | null } = { current: null };

  // Track latest output per cell so agents/tools can read.
  const outputCache = new Map<string, CellOutput[]>();

  // Materialize <wb-data> blocks into the executor's input map. Cells
  // join the same `reads=` namespace, so a `reads="orders"` resolves
  // identically whether `orders` is a <wb-input>, a <wb-data>, or an
  // upstream cell output. Order: data > inputs > cell outputs (data
  // wins on collision; collisions discouraged but not parser-rejected
  // today).
  const dataResolver = opts.dataResolver ?? createWorkbookDataResolver();
  const resolvedData = await dataResolver.resolveAll(spec.data);
  const mergedInputs: Record<string, unknown> = { ...spec.inputs };
  for (const [id, resolved] of resolvedData) {
    mergedInputs[id] = resolved.value;
  }

  // Register <wb-memory> blocks as queryable tables on the runtime
  // client. Cells with `reads="memId"` will see the table by that
  // name in Polars-SQL queries. Memory differs from data: the bytes
  // don't flow through the executor's input map (cells query via
  // SQL, not as direct params).
  const memoryResolver = opts.memoryResolver ?? createWorkbookMemoryResolver();
  const resolvedMemory = await memoryResolver.resolveAll(spec.memory);
  for (const [id, resolved] of resolvedMemory) {
    if (client.registerMemory) {
      await client.registerMemory(id, resolved.bytes);
    }
  }

  // Resolve <wb-doc> CRDT blocks. The resolved handle is registered
  // on the runtime client so host code (agent tools, custom cells)
  // can mutate via client.docMutate(id, ops). Cells continue to
  // receive a JSON projection in the executor input map for cheap
  // read access; live mutation goes through the client.
  const docResolver = opts.docResolver ?? createWorkbookDocResolver();
  const resolvedDocs = await docResolver.resolveAll(spec.docs);
  for (const [id, resolved] of resolvedDocs) {
    if (client.registerDoc) {
      await client.registerDoc(id, resolved.handle);
    }
    mergedInputs[id] = resolved.handle.toJSON();
  }

  // Resolve <wb-history> blocks only when the host explicitly opts in
  // by passing a historyResolver. The default behavior is to leave
  // history blocks unresolved — workbooks that embed history but
  // whose host doesn't know how to read it should still mount cleanly.
  // The format is parsed and validated above; only traversal is gated.
  if (opts.historyResolver && spec.history.length > 0) {
    await opts.historyResolver.resolveAll(spec.history);
  }

  const executor = new ReactiveExecutor({
    client,
    cells: spec.cells,
    inputs: mergedInputs,
    workbookSlug: spec.name,
    onCellState: (state: CellState) => {
      if (state.status === "ok" && state.outputs) {
        outputCache.set(state.cellId, state.outputs);
      }
      // Push to any <wb-output for="cellId"> elements. cellId is
      // already locked to VALID_ID at parse time (core-0id.3) but
      // CSS.escape is cheap defense-in-depth — guarantees the
      // selector can't be tricked even if parser validation regresses.
      for (const out of doc.querySelectorAll(`wb-output[for="${CSS.escape(state.cellId)}"]`)) {
        renderOutputElement(out as HTMLElement, state, spec.cells, lookupCustom);
      }
    },
  });

  const ctx: WorkbookContext = {
    client,
    llmClient: opts.llmClient,
    read: (cellId) => outputCache.get(cellId),
    runCell: async (cellId) => {
      const cell = spec.cells.find((c) => c.id === cellId);
      if (!cell) throw new Error(`runCell: unknown cell '${cellId}'`);
      const params: Record<string, unknown> = {};
      for (const dep of cell.dependsOn ?? []) {
        const out = outputCache.get(dep);
        if (out?.[0]?.kind === "text") params[dep] = (out[0] as { content: string }).content;
        else if (spec.inputs[dep] !== undefined) params[dep] = spec.inputs[dep];
      }
      const resp = await client.runCell({
        runtimeId: "imperative",
        cell,
        params,
      });
      outputCache.set(cellId, resp.outputs);
      return resp.outputs;
    },
  };
  ctxRef.current = ctx;

  // Bind <wb-input> values to the executor.
  for (const inp of doc.querySelectorAll("wb-input")) {
    bindInputElement(inp as HTMLElement, executor);
  }

  // Resolve the per-agent tool surface (core-547). For each agent:
  //   1. If <wb-tool ref="..."> children declare cell-bound tools, the
  //      legacy path is unchanged (no framework default — author opted
  //      into a specific surface).
  //   2. Otherwise, default to [bash, ...opts.agentTools] unless
  //      disableDefaultBashTool is set or opts.agentTools is explicitly
  //      provided as []. The bash tool is constructed lazily — the
  //      just-bash module isn't loaded until the agent first runs it.
  const extraTools = opts.agentTools;
  const buildAgentTools = (agent: AgentSpec): AgentTool[] => {
    if (agent.tools.length > 0) {
      // Author specified <wb-tool ref="cellId"> children. The cell-bound
      // tool surface is a future epic (core-6ul) — for now we honor the
      // declaration shape but don't dispatch anything; same posture as
      // before this change.
      return [];
    }
    const tools: AgentTool[] = [];
    if (!opts.disableDefaultBashTool) {
      tools.push(
        createWorkbookBashTool({
          client,
          spec,
          getSkillSource: opts.getSkillSource,
          skillKeys: opts.agentSkillKeys,
        }),
      );
    }
    if (extraTools && extraTools.length > 0) tools.push(...extraTools);
    return tools;
  };

  // Wire <wb-chat> elements to their agents.
  for (const chat of doc.querySelectorAll("wb-chat")) {
    bindChatElement(chat as HTMLElement, ctx, spec, buildAgentTools);
  }

  // Wire <wb-agent> trigger buttons (manual run for now).
  for (const agentEl of doc.querySelectorAll("wb-agent")) {
    bindAgentElement(agentEl as HTMLElement, ctx, spec, buildAgentTools);
  }

  // (window.__wbRuntime is set immediately after the client is
  // built, far above — this lets store constructors that race
  // ahead of main.js's mountHtmlWorkbook await find the client
  // within ms instead of waiting for runAll to resolve.)

  await executor.runAll();
  return { executor, ctx, spec };
}

// ----------------------------------------------------------------------
// Element wiring.
// ----------------------------------------------------------------------

function bindInputElement(el: HTMLElement, executor: ReactiveExecutor): void {
  const name = el.getAttribute("name");
  if (!name) return;
  const type = el.getAttribute("type") ?? "text";
  const def = el.getAttribute("default") ?? "";

  // Replace the element's children with a real form control. (We keep
  // the wb-input element as the host so authors don't have to wrap.)
  if (el.querySelector("input, textarea, select")) return; // already wired

  const inputType = type === "number" ? "number" : type === "csv" ? "textarea" : "text";

  if (inputType === "textarea") {
    const ta = document.createElement("textarea");
    ta.value = def;
    ta.rows = 5;
    ta.style.width = "100%";
    ta.classList.add("wb-textarea");
    ta.addEventListener("input", () => executor.setInput(name, ta.value));
    el.appendChild(ta);
  } else {
    const input = document.createElement("input");
    input.type = inputType;
    input.value = def;
    input.classList.add("wb-input");
    if (inputType === "number") input.classList.add("num");
    else input.classList.add("text");
    input.addEventListener("input", () => {
      const v = inputType === "number" ? Number(input.value) : input.value;
      executor.setInput(name, v);
    });
    el.appendChild(input);
  }
}

function renderOutputElement(
  el: HTMLElement,
  state: CellState,
  cells: Cell[],
  lookupCustom: (language: string) => CustomCellExecutor | undefined,
): void {
  const cellId = el.getAttribute("for");
  if (!cellId) return;
  const cell = cells.find((c) => c.id === cellId);
  el.dataset.status = state.status;
  el.classList.toggle("wb-output-ok", state.status === "ok");
  el.classList.toggle("wb-output-running", state.status === "running");
  el.classList.toggle("wb-output-error", state.status === "error");
  el.classList.toggle("wb-output-stale", state.status === "stale");

  if (state.status === "running") {
    el.innerHTML = `<span class="wb-muted wb-mono" style="font-size: var(--t-sm);">running…</span>`;
    return;
  }
  if (state.status === "error") {
    el.innerHTML = `<div class="wb-out error">${escapeHtml(state.error ?? "(error)")}</div>`;
    return;
  }
  if (state.status !== "ok" || !state.outputs) return;

  // Custom output renderer wins.
  if (cell) {
    const custom = lookupCustom(cell.language);
    if (custom?.renderOutput) {
      el.innerHTML = "";
      custom.renderOutput(el, state.outputs);
      return;
    }
  }

  el.innerHTML = "";
  for (const o of state.outputs) {
    el.appendChild(renderOutput(o));
  }
}

function renderOutput(o: CellOutput): HTMLElement {
  if (o.kind === "image" && o.mime_type === "image/svg+xml") {
    const div = document.createElement("div");
    // SVG is not a safe subset of HTML. <svg><script>, on*= handlers,
    // and <foreignObject><iframe src=javascript:> all execute if we
    // drop raw SVG into innerHTML. closes core-0id.2
    div.innerHTML = sanitizeSvg(o.content);
    return div;
  }
  if (o.kind === "text" && o.mime_type === "text/csv") {
    return csvToTable(o.content);
  }
  if (o.kind === "text") {
    const div = document.createElement("div");
    div.style.whiteSpace = "pre-wrap";
    div.style.fontFamily = "var(--font-sans)";
    div.textContent = o.content;
    return div;
  }
  if (o.kind === "error") {
    const div = document.createElement("div");
    div.className = "wb-out error";
    div.textContent = `ERROR: ${o.message}`;
    return div;
  }
  const pre = document.createElement("pre");
  pre.className = "wb-code";
  pre.textContent = JSON.stringify(o, null, 2);
  return pre;
}

function csvToTable(csv: string): HTMLElement {
  const rows = csv.trim().split("\n").map(parseCsvRow);
  const t = document.createElement("table");
  t.className = "wb-table";
  const thead = document.createElement("thead");
  const tr = document.createElement("tr");
  for (const c of rows[0]) {
    const th = document.createElement("th");
    th.textContent = c;
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  t.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (let i = 1; i < rows.length; i++) {
    const r = document.createElement("tr");
    for (const c of rows[i]) {
      const td = document.createElement("td");
      td.textContent = c;
      if (!isNaN(Number(c)) && c !== "") td.className = "num";
      r.appendChild(td);
    }
    tbody.appendChild(r);
  }
  t.appendChild(tbody);
  return t;
}

function parseCsvRow(row: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    if (c === "&") return "&amp;";
    if (c === "<") return "&lt;";
    if (c === ">") return "&gt;";
    if (c === '"') return "&quot;";
    return "&#39;";
  });
}

// ----------------------------------------------------------------------
// Agent + Chat UI bindings.
// ----------------------------------------------------------------------

function bindAgentElement(
  el: HTMLElement,
  ctx: WorkbookContext,
  spec: WorkbookHtmlSpec,
  buildTools: (agent: AgentSpec) => AgentTool[],
): void {
  const id = el.getAttribute("id");
  if (!id) return;
  const agent = spec.agents.find((a) => a.id === id);
  if (!agent) return;

  // Inline content rendering — show the agent's last completion when
  // bound by a <wb-output for="agentId">. The chat element handles
  // multi-turn; standalone agent cells run once at mount or on click.
  if (el.hasAttribute("auto") || el.hasAttribute("trigger") === false) {
    runAgentOnce(el, ctx, agent, buildTools(agent)).catch((err) =>
      console.warn("agent run", err),
    );
  }
}

async function runAgentOnce(
  el: HTMLElement,
  ctx: WorkbookContext,
  agent: AgentSpec,
  tools: AgentTool[],
): Promise<void> {
  if (!ctx.llmClient) return;
  // Build context from the agent's `reads` cells.
  const contextLines: string[] = [];
  for (const ref of agent.reads) {
    const out = ctx.read(ref);
    if (out?.[0]?.kind === "text") {
      contextLines.push(`### ${ref}\n${(out[0] as { content: string }).content}`);
    }
  }
  const userMessage =
    contextLines.length > 0
      ? `Context:\n\n${contextLines.join("\n\n")}\n\nProvide your analysis.`
      : "Begin.";

  const result = await runAgentLoop({
    llmClient: ctx.llmClient,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    initialUserMessage: userMessage,
    tools,
  });

  // Find the matching <wb-output for=agent.id> and update. agent.id
  // is locked to VALID_ID at parse time (core-0id.3); CSS.escape is
  // defense-in-depth.
  const outputs = document.querySelectorAll(`wb-output[for="${CSS.escape(agent.id)}"]`);
  for (const o of outputs) {
    (o as HTMLElement).innerHTML = "";
    const div = document.createElement("div");
    div.style.whiteSpace = "pre-wrap";
    div.textContent = result.text;
    o.appendChild(div);
  }
}

function bindChatElement(
  el: HTMLElement,
  ctx: WorkbookContext,
  spec: WorkbookHtmlSpec,
  buildTools: (agent: AgentSpec) => AgentTool[],
): void {
  const agentId = el.getAttribute("for") ?? el.getAttribute("agent");
  if (!agentId) {
    el.innerHTML = `<div class="wb-out error">wb-chat: missing 'for' attribute</div>`;
    return;
  }
  const agentMatch = spec.agents.find((a) => a.id === agentId);
  if (!agentMatch) {
    // agentId is from getAttribute("for")/("agent"), workbook-controlled.
    // Escape before interpolating into the error message. closes core-0id.2 + .3
    el.innerHTML = `<div class="wb-out error">wb-chat: no agent with id '${escapeHtml(agentId)}'</div>`;
    return;
  }
  if (!ctx.llmClient) {
    el.innerHTML = `<div class="wb-out error">wb-chat: no llmClient configured</div>`;
    return;
  }
  // Re-bind to a non-nullable reference so the inner send() closure
  // doesn't lose the narrowing (TS can't track it through the function
  // boundary).
  const agent: AgentSpec = agentMatch;

  // Render chat shell.
  el.innerHTML = `
    <div class="wb-chat">
      <div class="wb-chat-history" data-history></div>
      <div class="wb-chat-compose">
        <textarea class="wb-textarea" rows="2" data-input placeholder="Message ${escapeHtml(agentId)}…"></textarea>
        <button class="wb-btn run" data-send>Send</button>
      </div>
    </div>
  `;

  const history: { role: "user" | "assistant"; content: string }[] = [];
  const historyEl = el.querySelector("[data-history]") as HTMLElement;
  const inputEl = el.querySelector("[data-input]") as HTMLTextAreaElement;
  const sendBtn = el.querySelector("[data-send]") as HTMLButtonElement;

  function renderHistory(streamingText?: string) {
    historyEl.innerHTML = "";
    for (const m of history) {
      const div = document.createElement("div");
      div.className = `wb-chat-msg wb-chat-msg-${m.role}`;
      div.textContent = m.content;
      historyEl.appendChild(div);
    }
    if (streamingText !== undefined) {
      const div = document.createElement("div");
      div.className = "wb-chat-msg wb-chat-msg-assistant streaming";
      div.textContent = streamingText;
      historyEl.appendChild(div);
    }
    historyEl.scrollTop = historyEl.scrollHeight;
  }

  async function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    history.push({ role: "user", content: text });
    inputEl.value = "";
    sendBtn.disabled = true;
    renderHistory("");

    // Build messages: system + agent's read-context + history.
    const contextLines: string[] = [];
    for (const ref of agent.reads) {
      const out = ctx.read(ref);
      if (out?.[0]?.kind === "text") {
        contextLines.push(`### ${ref}\n${(out[0] as { content: string }).content}`);
      }
    }
    const augmentedSystem = contextLines.length > 0
      ? `${agent.systemPrompt}\n\nAvailable context (cell outputs):\n\n${contextLines.join("\n\n")}`
      : agent.systemPrompt;

    let streamed = "";
    try {
      // Resolve the agent's tool surface lazily (per send) so
      // late-registered runtime state — newly appended memory rows,
      // mutated docs — is reflected when the bash tool builds its
      // VFS snapshot. core-547.
      const tools = buildTools(agent);
      if (tools.length > 0) {
        // Tool-aware path: route through runAgentLoop so the model can
        // call bash + any host-registered extras between turns.
        const result = await runAgentLoop({
          llmClient: ctx.llmClient!,
          model: agent.model,
          systemPrompt: augmentedSystem,
          initialUserMessage: text,
          tools,
          onDelta: (delta) => {
            streamed += delta;
            renderHistory(streamed);
          },
        });
        history.push({
          role: "assistant",
          content: result.text || streamed || "(empty response)",
        });
      } else {
        // Zero-tool path — preserve the original streaming-friendly
        // generateChat so chat-only agents see token-by-token deltas.
        const it = ctx.llmClient!.generateChat({
          model: agent.model,
          messages: [
            { role: "system", content: augmentedSystem },
            ...history.map((m) => ({ role: m.role, content: m.content })),
          ],
        });
        for await (const ev of it) {
          if (ev.kind === "delta") {
            streamed += ev.text;
            renderHistory(streamed);
          } else if (ev.kind === "done") {
            if (ev.errorMessage) {
              history.push({ role: "assistant", content: `[error] ${ev.errorMessage}` });
            } else {
              history.push({ role: "assistant", content: ev.finalText || streamed });
            }
          }
        }
      }
    } catch (err) {
      history.push({
        role: "assistant",
        content: `[error] ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      renderHistory();
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  sendBtn.addEventListener("click", send);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  });
}
