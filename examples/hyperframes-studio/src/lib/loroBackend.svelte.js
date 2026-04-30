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
 * <wb-doc id="hyperframes-state"> element.
 *
 * Polls window.__wbRuntime + getDocHandle so this works regardless of
 * whether the caller fires BEFORE or AFTER main.js completes its
 * mountHtmlWorkbook await — composition / asset / userSkill store
 * constructors race ahead of main.js at module-load time, and we
 * don't want them to cache a failed promise.
 *
 * Idempotent — once resolved, subsequent calls reuse the cached doc.
 * If a previous attempt threw, we retry on the next call.
 */
const RUNTIME_POLL_TIMEOUT_MS = 10_000;
const RUNTIME_POLL_INTERVAL_MS = 25;

export function bootstrapLoro() {
  if (_doc) return Promise.resolve(_doc);
  if (_bootPromise) return _bootPromise;

  const promise = (async () => {
    const start = Date.now();
    while (Date.now() - start < RUNTIME_POLL_TIMEOUT_MS) {
      const rt = typeof window !== "undefined" ? window.__wbRuntime : null;
      if (rt && typeof rt.getDocHandle === "function") {
        const handle = rt.getDocHandle(DOC_ID);
        if (handle && typeof handle.inner === "function") {
          _doc = handle.inner();
          return _doc;
        }
      }
      await new Promise((r) => setTimeout(r, RUNTIME_POLL_INTERVAL_MS));
    }
    // Timeout — clear the cached promise so the NEXT caller can retry
    // (e.g. if the user reloads or the runtime mounts late).
    _bootPromise = null;
    throw new Error(
      `loroBackend: timed out (${RUNTIME_POLL_TIMEOUT_MS}ms) waiting for ` +
      `<wb-doc id="${DOC_ID}"> to register. Make sure index.html has ` +
      `<wb-workbook><wb-doc id="${DOC_ID}" format="loro" /></wb-workbook> ` +
      `and main.js calls bundle.mountHtmlWorkbook(...).`,
    );
  })();

  // Clear cache on rejection so retries work; keep on success so we
  // return the cached doc immediately on every subsequent call.
  promise.catch(() => { _bootPromise = null; });
  _bootPromise = promise;
  return promise;
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

// ─── User-uploaded skills ─────────────────────────────────────────
//
// Skill markdown files the user has dragged into the Skills Manager.
// Same JSON-string-in-Loro-list pattern as assets. Round-trips
// through the .workbook.html save flow alongside everything else.

/** Read all user skills. Returns [{ name, content }, ...]. */
export function readUserSkills() {
  if (!_doc) return [];
  const list = _doc.getList("user-skills");
  const out = [];
  for (const v of list.toArray()) {
    if (typeof v !== "string") continue;
    try { out.push(JSON.parse(v)); } catch { /* skip */ }
  }
  return out;
}

/** Append one user skill. */
export async function pushUserSkill(skill) {
  await bootstrapLoro();
  if (!_doc) return;
  _doc.getList("user-skills").push(JSON.stringify(skill));
  _doc.commit();
}

/** Remove a user skill by name. */
export async function removeUserSkillByName(name) {
  await bootstrapLoro();
  if (!_doc) return;
  const list = _doc.getList("user-skills");
  const arr = list.toArray();
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (typeof v !== "string") continue;
    try {
      const parsed = JSON.parse(v);
      if (parsed?.name === name) {
        list.delete(i, 1);
        _doc.commit();
        return;
      }
    } catch { /* skip */ }
  }
}
