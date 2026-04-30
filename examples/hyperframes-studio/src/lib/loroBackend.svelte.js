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
// Persistence — file-as-database. The Loro doc is registered with the
// workbook runtime via the <wb-doc id="hyperframes-state"> element in
// index.html. The runtime's save handler exports the doc's bytes back
// into that element on Cmd+S, so all state lives in the
// .workbook.html file. NO IndexedDB. NO localStorage. Two copies of
// the file can never share state — each saved file is its own
// universe.
//
// On load, the runtime parses any prior bytes in the <wb-doc> element
// and instantiates a LoroDoc from them; bootstrapLoro() retrieves the
// resulting handle from window.__wbRuntime.

const DOC_ID = "hyperframes-state";

let _doc = null;            // raw LoroDoc (handle.inner())
let _bootPromise = null;

/**
 * Resolve the raw LoroDoc registered by the workbook runtime for our
 * <wb-doc id="hyperframes-state"> element. Idempotent — subsequent
 * calls reuse the cached promise.
 *
 * Returns the LoroDoc; throws if the runtime never registered the
 * doc (e.g. main.js skipped mountHtmlWorkbook). Callers that prefer
 * graceful degradation can wrap in try/catch.
 */
export function bootstrapLoro() {
  if (_bootPromise) return _bootPromise;
  _bootPromise = (async () => {
    // The runtime exposes its client at window.__wbRuntime after
    // mountHtmlWorkbook resolves. main.js awaits both before we're
    // called, so the handle should be present.
    const rt = typeof window !== "undefined"
      ? window.__wbRuntime
      : null;
    if (!rt || typeof rt.getDocHandle !== "function") {
      throw new Error(
        "loroBackend: window.__wbRuntime not initialized — " +
        "did main.js call mountHtmlWorkbook before bootstrapLoro?",
      );
    }
    const handle = rt.getDocHandle(DOC_ID);
    if (!handle || typeof handle.inner !== "function") {
      throw new Error(
        `loroBackend: <wb-doc id="${DOC_ID}"> wasn't registered. ` +
        `Make sure index.html has <wb-workbook><wb-doc id="${DOC_ID}" format="loro" /></wb-workbook>.`,
      );
    }
    _doc = handle.inner();
    return _doc;
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
 *  Loro's text CRDT. */
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

/** Apply a new composition html as Loro Text ops + commit. Awaits
 *  bootstrap so writes fired before the runtime finishes loading
 *  are queued and applied as soon as the doc is ready. */
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
}

/** Force-export the current snapshot synchronously. Used by the
 *  Package flow when it needs canonical bytes for an external file
 *  format (zip export). Returns null if the doc isn't bootstrapped. */
export function snapshotCompositionBytes() {
  return _doc ? _doc.export({ mode: "snapshot" }) : null;
}

// ─── Asset list backing ─────────────────────────────────────────
//
// Asset entries serialize as JSON strings inside a top-level Loro
// List. Reads parse back into the in-memory shape the assets store
// uses. Concurrent forks merge via Loro's List CRDT.

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
}
