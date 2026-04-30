// Cryptographic edit-log backed by the Prolly Tree primitive.
//
// Every meaningful edit (composition save, asset add/remove, agent
// turn finished) commits a (key, value) into a content-addressed
// Merkle commit chain. The chain serializes to a single byte blob
// that round-trips through IDB.
//
// What's recorded
// ---------------
//   key                       value                         message
//   ─────────────────────     ──────────────────────────    ─────────────────
//   "composition"             current html                  composition save (N chars)
//   "asset:<id>"              JSON of the asset entry       add asset <name>
//   "asset:<id>" (deleted)    null marker                   remove asset <id>
//   "turn:<turn_id>"          JSON of the turn              <role> turn (N segs)
//
// Everything since the last commit is one chunk; the parent pointer
// chains commits, sha256 verifies integrity. Reload-detect on the
// IDB key, or full reset via prollyInit.
//
// What this primitive unlocks (future, not built yet)
// ---------------------------------------------------
//   - "show me what I changed in the last hour" via prollyLog
//   - "checkout previous composition state" via prollyCheckout
//   - tamper-evident audit when sharing a workbook (the head-sha256
//     attribute on <wb-history> in the exported zip is the proof)
//
// We don't ship UI for these yet; the wiring captures the events so
// the data is there when a History panel lands.

import { loadState, markDirty } from "./persistence.svelte.js";
import { loadRuntime } from "virtual:workbook-runtime";

const HISTORY_KEY = "history.prolly";
const INIT_MESSAGE = "hyperframes session start";

/** Per-key debounce for recordEdit/recordDelete. A drag operation
 *  fires composition.set() many times per second; without this,
 *  every frame produces a Prolly commit + a fresh leaf chunk
 *  carrying the whole composition. With it, we wait for the burst
 *  to settle and commit ONE entry with the final state. The audit
 *  chain stays useful (one logical edit = one commit) and storage
 *  doesn't balloon. */
const RECORD_DEBOUNCE_MS = 1000;
const _pendingEdits = new Map();  // key -> { kind, value, message, timer }

// ─── Cursor (undo/redo position) ────────────────────────────────
//
// The cursor is a separate pointer from HEAD that tracks WHERE THE
// USER IS LOOKING in the chain. Default: cursor follows HEAD. When
// the user clicks "undo to here" on a past commit, the cursor moves
// back without modifying the chain. The next edit truncates the
// chain so the new commit's parent is the cursor — making any
// commits after the cursor (the "redo space") unreachable.
//
// This is the destructive-undo model: redo space exists only until
// the user makes a new edit, then it's gone. Matches Cmd+Z / Cmd+Y
// semantics in editors, and matches the user's mental model of
// "moving back in the timeline."

let _cursorHash = null;            // null = follow HEAD
const _cursorListeners = new Set();

/** Subscribe to cursor changes — used by the panel to re-render. */
export function onCursorChange(cb) {
  _cursorListeners.add(cb);
  return () => _cursorListeners.delete(cb);
}

function notifyCursorChange() {
  for (const cb of _cursorListeners) {
    try { cb(); } catch (e) { console.warn("cursor listener threw:", e); }
  }
}

/** Move the cursor to a past commit. Pass null to release back to
 *  HEAD (cursor "follows HEAD"). Doesn't touch the chain. */
export function setCursor(hash) {
  _cursorHash = hash;
  notifyCursorChange();
}

/** Read current cursor — null means "follows HEAD." */
export function getCursor() { return _cursorHash; }

let _wasmPromise = null;
let _bytesPromise = null;

// ─── Change subscription ─────────────────────────────────────────
//
// Components that surface the audit chain (HistoryPanel) subscribe
// here so the UI updates as edits happen, not just on tab-focus.
// The notify is debounced — a burst of recordEdit calls during a
// drag operation collapses to one panel refresh.

const _listeners = new Set();
let _notifyTimer = null;

/** Subscribe to "history changed" events. Returns an unsubscribe
 *  fn the caller invokes on cleanup. */
export function onHistoryChange(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

function notifyHistoryChange() {
  if (_notifyTimer) return; // already scheduled
  _notifyTimer = setTimeout(() => {
    _notifyTimer = null;
    for (const cb of _listeners) {
      try { cb(); } catch (e) { console.warn("history listener threw:", e); }
    }
  }, 50); // tiny debounce so a burst of edits collapses to one refresh
}

async function getWasm() {
  if (!_wasmPromise) {
    _wasmPromise = loadRuntime().then((r) => r.wasm);
  }
  return _wasmPromise;
}

/** Lazy bootstrap: load saved bytes from IDB, or call prollyInit
 *  to create a fresh chain. Subsequent calls reuse the same promise.
 *  Returns the current serialized history bytes. */
async function ensureBytes() {
  if (!_bytesPromise) {
    _bytesPromise = (async () => {
      const wasm = await getWasm();
      if (!wasm.prollyInit) {
        throw new Error("history: runtime build missing prolly* bindings");
      }
      const saved = await loadState(HISTORY_KEY);
      if (saved instanceof Uint8Array && saved.byteLength > 0) {
        // Validate by reading HEAD — if corrupted, fall back to fresh.
        try {
          wasm.prollyHead(saved);
          return saved;
        } catch (e) {
          console.warn("history: stored Prolly blob unreadable, starting fresh:", e?.message ?? e);
        }
      }
      return wasm.prollyInit(INIT_MESSAGE);
    })();
  }
  return _bytesPromise;
}

/** Schedule a (key, value) commit, coalesced per-key over a 1s window.
 *  Calling repeatedly with the same key during a burst (e.g. a drag)
 *  collapses to one final commit carrying the latest value. The
 *  message of the latest call wins. Fire-and-forget; errors are
 *  caught and logged but never thrown back to the caller. */
export function recordEdit(key, value, message) {
  scheduleRecord(key, { kind: "set", value, message });
}

/** Schedule a key removal. Same per-key debounce as recordEdit. */
export function recordDelete(key, message) {
  scheduleRecord(key, { kind: "delete", message });
}

function scheduleRecord(key, op) {
  const existing = _pendingEdits.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  const entry = { ...op, timer: null };
  entry.timer = setTimeout(() => {
    _pendingEdits.delete(key);
    flushRecord(key, entry).catch((e) => {
      console.warn(`history: flush ${key} failed:`, e?.message ?? e);
    });
  }, RECORD_DEBOUNCE_MS);
  _pendingEdits.set(key, entry);
}

async function flushRecord(key, op) {
  let wasm;
  try { wasm = await getWasm(); }
  catch { return; } // runtime not loadable — silently skip
  let current = await ensureBytes();

  // If the cursor is behind HEAD, truncate the chain to the cursor
  // BEFORE appending. This is the destructive-redo step: the new
  // commit's parent becomes the cursor, and the redo space is
  // gone (chunks dropped from the chain bytes).
  if (_cursorHash && wasm.prollyTruncateTo && wasm.prollyHead) {
    const head = wasm.prollyHead(current);
    if (_cursorHash !== head) {
      try {
        current = wasm.prollyTruncateTo(current, _cursorHash);
        // Cursor is now the new HEAD, so release the cursor — back
        // to "follow HEAD" mode.
        _cursorHash = null;
        notifyCursorChange();
      } catch (e) {
        console.warn("history: truncate-on-edit failed:", e?.message ?? e);
        // Fall through and append without truncation. The redo space
        // stays but the edit still lands.
      }
    }
  }

  let next;
  if (op.kind === "set") {
    if (!wasm.prollySet) return;
    const valueStr = typeof op.value === "string"
      ? op.value
      : JSON.stringify(op.value ?? null);
    const valueBytes = new TextEncoder().encode(valueStr);
    next = wasm.prollySet(current, key, valueBytes, op.message);
  } else {
    if (!wasm.prollyDelete) return;
    next = wasm.prollyDelete(current, key, op.message);
  }
  _bytesPromise = Promise.resolve(next);
  // Route through markDirty so the IDB save inherits the
  // persistence-coordinator throttle (≤ 1 save / sec).
  markDirty(HISTORY_KEY, () => next);
  notifyHistoryChange();
}

/** Force an immediate flush of any pending recorded edits — useful
 *  before tab unload so a debounced commit isn't lost. */
export async function flushPendingHistory() {
  const pending = Array.from(_pendingEdits.entries());
  _pendingEdits.clear();
  for (const [key, op] of pending) {
    if (op.timer) clearTimeout(op.timer);
    try { await flushRecord(key, op); }
    catch (e) { console.warn(`history: flush ${key} failed:`, e?.message ?? e); }
  }
}

/** Walk the parent chain from HEAD. Returns CommitInfo[] in newest-
 *  first order — same shape the runtime's prollyLog binding produces.
 *  Empty array if the chain isn't bootstrapped yet. */
export async function readLog() {
  let wasm;
  try { wasm = await getWasm(); } catch { return []; }
  if (!wasm.prollyLog) return [];
  try {
    const current = await ensureBytes();
    return wasm.prollyLog(current);
  } catch (e) {
    console.warn("history: readLog failed:", e?.message ?? e);
    return [];
  }
}

/** Materialize the leaf at a past commit. Returns key→value (utf-8
 *  decoded). Caller decides how to apply the keys back to live state.
 *  Throws with a descriptive message on error rather than returning
 *  null silently — caller can surface the message to UI. */
export async function readCommit(commitHashHex) {
  const wasm = await getWasm(); // may throw if runtime can't load
  if (!wasm.prollyCheckout) {
    throw new Error("runtime build missing prollyCheckout binding");
  }
  const current = await ensureBytes();
  const pairs = wasm.prollyCheckout(current, commitHashHex);
  const out = {};
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for (const [key, valueBytes] of pairs) {
    // serde-wasm-bindgen serializes Rust Vec<u8> as a JS Array<number>
    // by default, NOT Uint8Array. TextDecoder.decode requires a
    // BufferSource (TypedArray / ArrayBuffer), so coerce here.
    const u8 = valueBytes instanceof Uint8Array
      ? valueBytes
      : new Uint8Array(valueBytes);
    out[key] = decoder.decode(u8);
  }
  return out;
}

/** Snapshot the raw bytes for the Package zip. Returns null if the
 *  chain hasn't been bootstrapped (no edits yet recorded). */
export async function snapshotHistoryBytes() {
  // Don't force bootstrap if it hasn't happened — that would imply
  // an empty session has history to save, which it doesn't.
  if (!_bytesPromise) return null;
  return _bytesPromise;
}

/** Snapshot bytes + HEAD hash for embedding in a <wb-history>
 *  element. Returns null when no edits have been recorded. */
export async function snapshotForEmbed() {
  if (!_bytesPromise) return null;
  let wasm;
  try { wasm = await getWasm(); } catch { return null; }
  if (!wasm.prollyHead) return null;
  const bytes = await _bytesPromise;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return null;
  try {
    const head = wasm.prollyHead(bytes);
    return { bytes, head };
  } catch (e) {
    console.warn("history: snapshotForEmbed head read failed:", e?.message ?? e);
    return null;
  }
}

/** Replace the entire chain with a fresh init. Used by a
 *  "reset history" affordance — currently unwired but kept for
 *  symmetry with clearAll() in persistence. */
export async function resetHistory() {
  let wasm;
  try { wasm = await getWasm(); } catch { return; }
  if (!wasm.prollyInit) return;
  const fresh = wasm.prollyInit(INIT_MESSAGE);
  _bytesPromise = Promise.resolve(fresh);
  saveState(HISTORY_KEY, fresh);
}
