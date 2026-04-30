// Chat thread persistence backed by <wb-memory>-shaped Arrow IPC.
//
// Each completed agent turn becomes one row in an Arrow batch:
//
//   turn_id        utf8       stable random id
//   timestamp_ms   i64        Date.now() at append time
//   role           utf8       "user" | "assistant"
//   segments_json  utf8       JSON of the heterogeneous segments[]
//                            array (text + tool-call entries)
//
// The IPC stream is the canonical persistence shape; we keep the
// snapshot bytes in IDB. On hydration we decode the whole stream
// back into the agent thread shape. This is the same shape Polars
// cells would query if you added a wb-memory cell over the thread —
// audit trails for free.
//
// Encode / decode happen in the runtime WASM (arrowEncodeJsonRows /
// arrowDecodeToJsonRows). No Apache Arrow JS dep on the page.
//
// Why not LoroDoc for the chat thread:
//   The thread is naturally append-only with no merge needs (each
//   turn is atomic, no concurrent edits to a single turn). Arrow
//   IPC is leaner per-row + queryable. If we ever want collaborative
//   chat threads, switching to a LoroList of turns is mechanical.

import { loadState, markDirty } from "./persistence.svelte.js";
import { loadRuntime } from "virtual:workbook-runtime";
import { recordEdit } from "./historyBackend.svelte.js";

const MEM_KEY = "agentThread.arrow";
const SCHEMA = {
  fields: [
    { name: "turn_id", type: "utf8" },
    { name: "timestamp_ms", type: "i64" },
    { name: "role", type: "utf8" },
    { name: "segments_json", type: "utf8" },
  ],
};
const SCHEMA_JSON = JSON.stringify(SCHEMA);

let _wasmPromise = null;
async function getWasm() {
  if (!_wasmPromise) {
    _wasmPromise = (async () => {
      const { bundle, wasm } = await loadRuntime();
      // The runtime client lazy-initializes wasm on first call. We
      // can use the wasm module directly for the JSON encoder.
      void bundle;
      return wasm;
    })();
  }
  return _wasmPromise;
}

function newTurnId() {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Append a single completed turn. Schedules a debounced IDB save
 *  of the new aggregate Arrow IPC bytes. */
export async function appendTurn({ role, segments }) {
  const wasm = await getWasm();
  if (!wasm.arrowEncodeJsonRows || !wasm.appendArrowIpc) {
    // Runtime build doesn't expose the Arrow encoder bindings — skip
    // persistence rather than crash the chat path.
    console.warn("hf memory: arrow_json bindings missing; turn not persisted");
    return;
  }

  const row = {
    turn_id: newTurnId(),
    timestamp_ms: Date.now(),
    role: String(role ?? "assistant"),
    segments_json: JSON.stringify(segments ?? []),
  };
  const newBatch = wasm.arrowEncodeJsonRows(SCHEMA_JSON, JSON.stringify([row]));

  const existing = await loadState(MEM_KEY);
  const combined =
    existing instanceof Uint8Array && existing.byteLength > 0
      ? wasm.appendArrowIpc(existing, newBatch)
      : newBatch;

  // Schedule debounced save. The getValue captures `combined` by
  // closure so we can return synchronously even if the save fires
  // later.
  markDirty(MEM_KEY, () => combined);

  // Record the turn in the audit chain too. Fire-and-forget; the
  // history layer catches its own errors.
  const segCount = Array.isArray(segments) ? segments.length : 0;
  recordEdit(`turn:${row.turn_id}`, row, `${row.role} turn (${segCount} seg${segCount === 1 ? "" : "s"})`);
}

/** Replace the entire stored thread with a fresh stream. Used by
 *  agent.clearThread() to reset the persistence layer atomically. */
export async function clearTurns() {
  markDirty(MEM_KEY, () => null);
}

/** Read all stored turns in chronological order. Returns an empty
 *  array on first run / after clearTurns. */
export async function readAllTurns() {
  const stored = await loadState(MEM_KEY);
  if (!(stored instanceof Uint8Array) || stored.byteLength === 0) return [];
  const wasm = await getWasm();
  if (!wasm.arrowDecodeToJsonRows) {
    console.warn("hf memory: arrow_json decoder missing; can't rehydrate thread");
    return [];
  }
  let rows;
  try {
    const json = wasm.arrowDecodeToJsonRows(stored);
    rows = JSON.parse(json);
  } catch (e) {
    console.warn("hf memory: decode failed:", e?.message ?? e);
    return [];
  }
  // Materialize back into the in-memory thread shape. Sort defensively
  // by timestamp; the Arrow stream is naturally ordered but a future
  // schema migration might reorder.
  rows.sort((a, b) => (a.timestamp_ms ?? 0) - (b.timestamp_ms ?? 0));
  return rows.map((r) => ({
    role: r.role,
    segments: safeParseSegments(r.segments_json),
  }));
}

function safeParseSegments(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
