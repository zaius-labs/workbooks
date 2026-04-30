// Workbook state backed by a real Loro CRDT.
//
// One Loro doc carries everything that benefits from CRDT semantics:
//
//   getText("composition")               source HTML — char-level merge
//   getList("assets")                    list of JSON-encoded asset entries
//
// Two sessions on different machines can fork-and-merge automatically.
//
// Composition uses LoroText: writeComposition shrinks the common
// prefix + suffix between the old and new strings and emits one
// delete + one insert at the diverging region. Concurrent edits at
// different positions in a long composition merge cleanly; concurrent
// edits to the same byte range still resolve deterministically via
// Loro's RGA-flavored text CRDT.
//
// Assets use Loro List semantics — concurrent push lands cleanly via
// the list CRDT.
//
// Storage: one Loro snapshot bytes blob round-trips through IDB
// under WORKBOOK_KEY. We migrate older keys once on first boot:
//
//   workbook.loro       (current)         ← canonical
//   composition.loro    (prior shape)     ← imports once, dormant
//   composition         (legacy plain)    ← imports html into Text
//   assets              (legacy IDB blob) ← imports into list, dormant
//
// Earlier shapes used getMap("composition").set("html", …); on
// migration we copy any Map state into the Text container so the
// canonical home is always the Text. Map state is left in place for
// readers that still consult it but is no longer written to.

import { loadState, markDirty } from "./persistence.svelte.js";
// Static import — vite-plugin-singlefile mishandles the dynamic
// `import("loro-crdt")` form by flattening all chunks into one inline
// <script> with broken hoist order. Static resolves the dep graph at
// build time so vite-plugin-wasm can transform consistently.
import { LoroDoc } from "loro-crdt";

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
    const doc = new LoroDoc();

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
          doc.getText("composition").insert(0, legacy.html);
          doc.commit();
        }
      }
      // Migrate prior Map-backed composition into the Text container.
      // The Map was used by the earlier Phase-1 of #27; the Text is
      // the canonical home from #32 onward. We don't clear the Map
      // (older readers still consult it) but new writes go to Text.
      const priorMap = doc.getMap("composition").get("html");
      const currentText = doc.getText("composition").toString();
      if (typeof priorMap === "string" && priorMap.length > 0 && currentText.length === 0) {
        doc.getText("composition").insert(0, priorMap);
        doc.commit();
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

/** Read the current composition html from the Loro Text container.
 *  Returns "" if the doc isn't bootstrapped or the Text is empty. */
export function readComposition() {
  if (!_doc) return "";
  return _doc.getText("composition").toString();
}

/** Compute the diverging region between two strings as
 *  {start, deleteLen, insertText} — strip common prefix + suffix,
 *  return the middle. Replaces the most common edit shapes
 *  (full-string set, prepend, append, in-place patch) with one
 *  delete + one insert at the right position, so concurrent edits
 *  to non-overlapping regions of the composition merge cleanly via
 *  Loro's text CRDT. Optimal-diff (Myers et al.) is a future
 *  optimization for many-small-edits scenarios. */
function diffShrink(oldStr, newStr) {
  const oldLen = oldStr.length;
  const newLen = newStr.length;
  let prefix = 0;
  const minLen = Math.min(oldLen, newLen);
  while (prefix < minLen && oldStr.charCodeAt(prefix) === newStr.charCodeAt(prefix)) {
    prefix++;
  }
  let suffix = 0;
  const maxSuffix = minLen - prefix;
  while (
    suffix < maxSuffix &&
    oldStr.charCodeAt(oldLen - 1 - suffix) === newStr.charCodeAt(newLen - 1 - suffix)
  ) {
    suffix++;
  }
  return {
    start: prefix,
    deleteLen: oldLen - prefix - suffix,
    insertText: newStr.slice(prefix, newLen - suffix),
  };
}

/** Apply a new composition html as Loro Text ops + commit. The
 *  snapshot save is debounced via markDirty in the persistence
 *  coordinator. Awaits bootstrap so writes that fire before the
 *  Loro WASM finishes loading are queued and applied as soon as
 *  the doc is ready (instead of silently dropping). */
export async function writeComposition(html) {
  await bootstrapLoro();
  if (!_doc) return;
  const next = String(html ?? "");
  const text = _doc.getText("composition");
  const cur = text.toString();
  if (cur === next) return; // no-op; don't churn the op log
  const { start, deleteLen, insertText } = diffShrink(cur, next);
  if (deleteLen > 0) text.delete(start, deleteLen);
  if (insertText.length > 0) text.insert(start, insertText);
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

/** Append one asset to the list. Awaits bootstrap so pre-init
 *  pushes don't silently drop. */
export async function pushAsset(asset) {
  await bootstrapLoro();
  if (!_doc) return;
  _doc.getList("assets").push(JSON.stringify(asset));
  _doc.commit();
  scheduleSave();
}

/** Remove an asset by id — walks the list, finds the first matching
 *  entry, deletes it. No-op if not found. */
export async function removeAssetById(id) {
  await bootstrapLoro();
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
export async function replaceAssets(items) {
  await bootstrapLoro();
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
