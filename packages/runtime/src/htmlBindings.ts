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
import { runAgentLoop } from "./agentLoop";
import { sanitizeSvg } from "./util/sanitize";
import {
  createWorkbookDataResolver,
  type WorkbookDataResolver,
} from "./workbookDataResolver";
import {
  createWorkbookMemoryResolver,
  type WorkbookMemoryResolver,
} from "./workbookMemoryResolver";

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
 */
export interface WorkbookData {
  id: string;
  mime: string;
  /** Optional row count hint for UI; never trusted by the runtime. */
  rows?: number;
  /** Optional pre-decompression algorithm. */
  compression?: "gzip" | "zstd";
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
 * First supported format is Loro (Rust+WASM, shallow snapshots).
 * Automerge / Yjs may follow as additional `format=` values; the
 * resolver dispatches by format. Loro-crdt is an optional peer dep
 * lazy-loaded only when a workbook contains a <wb-doc>.
 *
 *   <wb-doc id="agent-state" format="loro" history-horizon="100"
 *           encoding="base64" sha256="...">AQEBAAhz...</wb-doc>
 *
 * Initial ship is read-only: cells read the doc as a JSON projection
 * via reads=. Mutation API (host-driven, mirrors appendMemory) lands
 * in a follow-up.
 */
export interface WorkbookDoc {
  id: string;
  format: "loro";
  /**
   * Optional shallow-snapshot history horizon — the number of
   * recent ops to retain in full DAG form before older history is
   * collapsed into a frozen baseline. Format-specific; today only
   * Loro honors it. UI hint only at parse time.
   */
  historyHorizon?: number;
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
const ALLOWED_DOC_FORMATS = new Set<WorkbookDoc["format"]>(["loro"]);

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

    let entry: WorkbookData | null = null;

    if (srcAttr) {
      // External form. sha256 + http(s) URL required.
      if (!sha256) continue;
      if (!isFetchableUrl(srcAttr)) continue;
      const bytes = parseBytesAttr(el.getAttribute("bytes"));
      entry = { id, mime, rows, compression, source: { kind: "external", src: srcAttr, sha256, bytes } };
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
      entry = { id, mime, rows, compression, source: { kind: "inline-base64", base64, sha256 } };
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
  // plus a `format=` allowlist so non-Loro CRDTs can be added later
  // without breaking existing parsers.
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
    if (!sha256) continue;

    const horizonAttr = Number(el.getAttribute("history-horizon"));
    const historyHorizon =
      Number.isFinite(horizonAttr) && horizonAttr >= 0 ? horizonAttr : undefined;

    const srcAttr = el.getAttribute("src");
    const encoding = (el.getAttribute("encoding") ?? "").toLowerCase();

    let entry: WorkbookDoc | null = null;

    if (srcAttr) {
      if (!isFetchableUrl(srcAttr)) continue;
      const bytes = parseBytesAttr(el.getAttribute("bytes"));
      entry = {
        id,
        format: formatAttr,
        historyHorizon,
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
        historyHorizon,
        source: { kind: "inline-base64", base64, sha256 },
      };
    } else {
      continue;
    }

    if (entry) docs.push(entry);
  }

  return { name, cells, inputs, agents, data, memory, docs };
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

  // Wire <wb-chat> elements to their agents.
  for (const chat of doc.querySelectorAll("wb-chat")) {
    bindChatElement(chat as HTMLElement, ctx, spec);
  }

  // Wire <wb-agent> trigger buttons (manual run for now).
  for (const agentEl of doc.querySelectorAll("wb-agent")) {
    bindAgentElement(agentEl as HTMLElement, ctx, spec);
  }

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
): void {
  const id = el.getAttribute("id");
  if (!id) return;
  const agent = spec.agents.find((a) => a.id === id);
  if (!agent) return;

  // Inline content rendering — show the agent's last completion when
  // bound by a <wb-output for="agentId">. The chat element handles
  // multi-turn; standalone agent cells run once at mount or on click.
  if (el.hasAttribute("auto") || el.hasAttribute("trigger") === false) {
    runAgentOnce(el, ctx, agent).catch((err) => console.warn("agent run", err));
  }
}

async function runAgentOnce(
  el: HTMLElement,
  ctx: WorkbookContext,
  agent: AgentSpec,
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
    tools: [], // tool-use agent layer comes next
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
): void {
  const agentId = el.getAttribute("for") ?? el.getAttribute("agent");
  if (!agentId) {
    el.innerHTML = `<div class="wb-out error">wb-chat: missing 'for' attribute</div>`;
    return;
  }
  const agent = spec.agents.find((a) => a.id === agentId);
  if (!agent) {
    // agentId is from getAttribute("for")/("agent"), workbook-controlled.
    // Escape before interpolating into the error message. closes core-0id.2 + .3
    el.innerHTML = `<div class="wb-out error">wb-chat: no agent with id '${escapeHtml(agentId)}'</div>`;
    return;
  }
  if (!ctx.llmClient) {
    el.innerHTML = `<div class="wb-out error">wb-chat: no llmClient configured</div>`;
    return;
  }

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
