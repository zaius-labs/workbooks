// Workbook state backed by a real Loro CRDT.
//
// One Loro doc carries everything that benefits from CRDT semantics:
//
//   getMap("composition").get("html")   string — composition source
//   getList("assets")                    list of JSON-encoded asset entries
//
// Two sessions on different machines can fork-and-merge automatically.
// Composition uses LWW on the "html" key (Phase-1; LoroText for
// char-level merge is task #32). Assets use Loro List semantics —
// concurrent push lands cleanly via the list CRDT.
//
// Storage: one Loro snapshot bytes blob round-trips through IDB
// under WORKBOOK_KEY. We migrate older keys (composition-only or
// plain-string) once on first boot, then they're dormant.

import { loadState, markDirty } from "./persistence.svelte.js";

const WORKBOOK_KEY = "workbook.loro";
const PRIOR_LORO_KEY = "composition.loro";  // earlier shape: composition only
const LEGACY_KEY = "composition";             // earliest: plain-string IDB blob

let _doc = null;            // populated post-bootstrap
let _bootPromise = null;

/** Bootstrap the Loro doc once. Subsequent calls reuse the cached
 *  promise; sync callers use getDoc() after awaiting bootstrap(). */
export function bootstrapLoro() {
  if (_bootPromise) return _bootPromise;
  _bootPromise = (async () => {
    let loro;
    try {
      loro = await import("loro-crdt");
    } catch (e) {
      console.warn("hf loro: peer dep missing, falling back to plain string IDB:", e?.message ?? e);
      // No-op stub — composition.set() calls below will still
      // markDirty under the legacy key, so persistence still works.
      _doc = null;
      return null;
    }
    const doc = new loro.LoroDoc();

    // Try the current key first; then the prior composition-only key;
    // then the original plain-string blob. Earliest match wins as
    // canonical state and migrates forward on next save.
    const savedBytes = await loadState(WORKBOOK_KEY);
    if (savedBytes instanceof Uint8Array && savedBytes.byteLength > 0) {
      try {
        doc.import(savedBytes);
      } catch (e) {
        console.warn("hf loro: snapshot import failed, starting fresh:", e?.message ?? e);
      }
    } else {
      const priorBytes = await loadState(PRIOR_LORO_KEY);
      if (priorBytes instanceof Uint8Array && priorBytes.byteLength > 0) {
        try { doc.import(priorBytes); }
        catch (e) { console.warn("hf loro: prior snapshot import failed:", e?.message ?? e); }
      } else {
        const legacy = await loadState(LEGACY_KEY);
        if (legacy && typeof legacy.html === "string" && legacy.html.length > 0) {
          doc.getMap("composition").set("html", legacy.html);
          doc.commit();
        }
      }
      // Migrate the prior asset-list IDB blob ("assets") into the doc
      // if no list state has landed in Loro yet. After this commit it
      // becomes dormant.
      const legacyAssets = await loadState("assets");
      if (legacyAssets && Array.isArray(legacyAssets.items) && doc.getList("assets").length === 0) {
        const list = doc.getList("assets");
        for (const a of legacyAssets.items) {
          try { list.push(JSON.stringify(a)); } catch { /* skip bad entries */ }
        }
        doc.commit();
      }
    }

    _doc = doc;
    return doc;
  })();
  return _bootPromise;
}

/** Synchronous access — returns null until bootstrapLoro() resolves. */
export function getDoc() { return _doc; }

/** Read the current composition html from Loro. Returns "" if the
 *  doc has no html set yet. */
export function readComposition() {
  if (!_doc) return "";
  const v = _doc.getMap("composition").get("html");
  return typeof v === "string" ? v : "";
}

/** Apply a new composition html as a single Loro op + commit. The
 *  snapshot save is debounced via markDirty in the persistence
 *  coordinator. Safe to call before bootstrap (no-op until ready). */
export function writeComposition(html) {
  if (!_doc) return;
  _doc.getMap("composition").set("html", String(html ?? ""));
  _doc.commit();
  scheduleSave();
}

/** Force-export the current snapshot synchronously. Used by the
 *  Package flow when it needs canonical bytes regardless of debounce
 *  state. Returns null if the doc isn't bootstrapped yet. */
export function snapshotCompositionBytes() {
  return _doc ? _doc.export({ mode: "snapshot" }) : null;
}

// ─── Asset list backing ─────────────────────────────────────────
//
// Asset entries serialize as JSON strings inside a top-level Loro
// List. Reads parse back into the in-memory shape the assets store
// uses. Concurrent forks merge via Loro's List CRDT (RGA-flavored
// for ordered list inserts).

/** Read all assets from the Loro list. Returns [] if the doc isn't
 *  bootstrapped or the list is empty. Drops entries that fail to
 *  parse (defensive — bad data shouldn't break the editor). */
export function readAssets() {
  if (!_doc) return [];
  const list = _doc.getList("assets");
  const out = [];
  for (const v of list.toArray()) {
    if (typeof v !== "string") continue;
    try { out.push(JSON.parse(v)); } catch { /* skip */ }
  }
  return out;
}

/** Append one asset to the list. */
export function pushAsset(asset) {
  if (!_doc) return;
  _doc.getList("assets").push(JSON.stringify(asset));
  _doc.commit();
  scheduleSave();
}

/** Remove an asset by id — walks the list, finds the first matching
 *  entry, deletes it. No-op if not found. */
export function removeAssetById(id) {
  if (!_doc) return;
  const list = _doc.getList("assets");
  const arr = list.toArray();
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (typeof v !== "string") continue;
    try {
      const parsed = JSON.parse(v);
      if (parsed?.id === id) {
        list.delete(i, 1);
        _doc.commit();
        scheduleSave();
        return;
      }
    } catch { /* skip */ }
  }
}

/** Replace the entire asset list in one commit. Used by import flows
 *  that swap state wholesale. */
export function replaceAssets(items) {
  if (!_doc) return;
  const list = _doc.getList("assets");
  if (list.length > 0) list.delete(0, list.length);
  for (const a of items ?? []) {
    list.push(JSON.stringify(a));
  }
  _doc.commit();
  scheduleSave();
}

function scheduleSave() {
  markDirty(WORKBOOK_KEY, () => {
    return _doc ? _doc.export({ mode: "snapshot" }) : null;
  });
}
