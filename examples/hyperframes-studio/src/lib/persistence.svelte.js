// Workbook-state persistence for hyperframes-studio.
//
// The Studio is a portable .workbook.html SPA — closing the tab loses
// every in-memory state without persistence. This layer mirrors the
// composition / asset registry / chat thread to IndexedDB so the next
// page load rehydrates them. Round-tripping through the Package zip
// remains the cross-machine path; IDB is the same-machine cache.
//
// Storage shape mirrors the @work.books/runtime memory primitives:
//   - one record per logical "block" id (composition, assets, chatTrace)
//   - each record is a JSON blob keyed by id
//   - on save: the WHOLE state object replaces the prior record (cheap
//     for hyperframes-shaped state under a few hundred KB)
//   - on load: each store reads its own id independently
//
// Why IDB and not localStorage:
//   localStorage is sync + ~5 MB cap + string-only. A few base64 video
//   thumbnails can blow the cap. IDB has no practical cap on origin
//   storage (~quota fraction of available disk) and supports binary.
//
// Why one big-blob-per-id rather than one entry per asset:
//   We're optimizing for write-amplification, not query speed. The
//   debounced save serializes everything every N ms; per-asset records
//   would need diff logic to avoid re-writing unchanged entries. The
//   blob shape keeps the loop simple.

const DB_NAME = "hyperframes-studio";
const STORE_NAME = "state";
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

/** Read a single state record by id. Returns undefined if not stored. */
export async function loadState(id) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    // IDB unavailable (private browsing, file:// without permission, etc.)
    // — fail soft so the UI still loads with defaults.
    console.warn("hf persistence: load failed for", id, e?.message ?? e);
    return undefined;
  }
}

/** Write a single state record by id. Overwrites any prior value. */
export async function saveState(id, value) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const req = tx.objectStore(STORE_NAME).put(value, id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn("hf persistence: save failed for", id, e?.message ?? e);
  }
}

/** Drop everything (used by the "Reset workspace" affordance). */
export async function clearAll() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const req = tx.objectStore(STORE_NAME).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn("hf persistence: clear failed", e?.message ?? e);
  }
}

// ─── Hybrid throttle + debounce save coordinator ────────────────
//
// Stores call markDirty(id, getValue) after every mutation. The
// coordinator collects ids and schedules a flush with two rules:
//
//   trailing debounce: save fires DEBOUNCE_MS after the last
//     dirty mark — gives a typing burst time to settle so we don't
//     write on every keystroke
//
//   throttle ceiling: saves never run more often than once every
//     MIN_INTERVAL_MS — during continuous activity (long drag,
//     stream of agent tool calls), the debounce keeps deferring;
//     this cap forces a save once per interval anyway so we never
//     go too long without persisting
//
// Tunables: 600 ms debounce + 1000 ms throttle means an idle burst
// lands ~600 ms after the last edit, and continuous activity lands
// roughly once per second.

const SAVE_DEBOUNCE_MS = 600;
const MIN_INTERVAL_MS = 1000;

const pending = new Map();        // id → getValue function (latest wins)
let timer = null;
let saving = false;
let lastSaveAt = 0;               // wall clock of most recent flush completion
let _onStatusChange = null;       // optional UI hook
let lastError = null;

function notify(status) {
  if (_onStatusChange) _onStatusChange(status, lastError);
}

async function flush() {
  timer = null;
  if (pending.size === 0) return;
  saving = true;
  notify("saving");
  // Snapshot pending so concurrent markDirty calls during the await
  // accumulate into the next round.
  const round = Array.from(pending.entries());
  pending.clear();
  try {
    // getValue() may return null if its backend isn't ready yet
    // (e.g. Loro doc still bootstrapping when the debounce fires).
    // Skip those — the next mutation will mark dirty again. Without
    // this skip, a null overwrite would wipe whatever valid state
    // had been saved earlier.
    const writes = [];
    const requeue = [];
    for (const [id, getValue] of round) {
      let value;
      try { value = getValue(); } catch (e) {
        console.warn(`hf persistence: getValue('${id}') threw:`, e?.message ?? e);
        continue;
      }
      if (value === null || value === undefined) {
        // Backend wasn't ready — re-queue so the next debounce window
        // catches the now-ready state.
        requeue.push([id, getValue]);
        continue;
      }
      writes.push(saveState(id, value));
    }
    await Promise.all(writes);
    for (const [id, getValue] of requeue) {
      pending.set(id, getValue);
    }
    lastError = null;
    saving = false;
    lastSaveAt = Date.now();
    if (pending.size > 0) {
      // More dirty marks landed during the save (or pending re-queues
      // from above) — kick another round, honoring the min-interval.
      schedule();
      return;
    }
    notify("saved");
  } catch (e) {
    lastError = e?.message ?? String(e);
    saving = false;
    lastSaveAt = Date.now(); // even errors count toward the throttle window
    notify("error");
  }
}

function schedule() {
  // Wait at least DEBOUNCE_MS for the burst to settle, AND at least
  // MIN_INTERVAL_MS since the last save completed. Whichever is
  // longer wins — that's the throttle ceiling enforcing 1 save per
  // MIN_INTERVAL_MS during continuous activity.
  const sinceLastSave = Date.now() - lastSaveAt;
  const throttleWait = Math.max(0, MIN_INTERVAL_MS - sinceLastSave);
  const wait = Math.max(SAVE_DEBOUNCE_MS, throttleWait);
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, wait);
}

/** Mark a logical state id as dirty. The coordinator will read
 *  `getValue()` after the debounce window elapses. */
export function markDirty(id, getValue) {
  pending.set(id, getValue);
  if (!saving) schedule();
}

/** Force an immediate save of any pending writes. */
export async function flushNow() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await flush();
}

/** Subscribe to save lifecycle changes — for the toolbar indicator.
 *  The callback receives ("idle" | "saving" | "saved" | "error", err?). */
export function onStatusChange(cb) {
  _onStatusChange = cb;
  notify(saving ? "saving" : "idle");
}
