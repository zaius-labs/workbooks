// No-op persistence stub.
//
// Hyperframes-studio used to mirror its state to IndexedDB through
// this module. That layer caused a known footgun — every copy of the
// file shared the same IDB origin on the same browser, so opening
// two saved copies (yours, mine) would show the same state.
//
// The studio now uses the workbook runtime's <wb-doc> primitive
// (see loroBackend.svelte.js) for composition + asset state. The
// SDK's save handler on Cmd+S exports the doc's current bytes back
// into the .workbook.html file. State lives in the file, not the
// browser.
//
// This module remains as a no-op to keep the existing import sites
// (memoryBackend / historyBackend / App.svelte chrome) compiling
// without a wider refactor. Future work migrates those subsystems
// to <wb-memory> primitives so chat thread + history persist via
// the file as well — tracked as a follow-up.

/** Stub: always resolves to null. Was: read a snapshot from IDB. */
export async function loadState(_id) {
  return null;
}

/** Stub: silently accepts but doesn't persist. Was: schedule a
 *  debounced IDB write of the snapshot returned by getValue. */
export function markDirty(_id, _getValue) {
  // No-op. The SDK save handler captures <wb-doc> state on Cmd+S.
}

/** Stub: resolves immediately. Was: clear all stored state. */
export async function clearAll() {
  // No-op.
}

// ─── Status indicator API ──────────────────────────────────────
//
// The chrome's autosave indicator subscribes to status changes via
// onStatusChange and triggers flushes via flushNow on Cmd+S. With
// IDB removed, "saving" is no longer a thing the chrome owns —
// Cmd+S is handled by the SDK save handler globally, which has its
// own toast. We keep these as no-ops so App.svelte doesn't break;
// future cleanup removes the chrome's stale indicator.

/** Stub: never fires. Caller's listener is never invoked. */
export function onStatusChange(_listener) {
  return () => { /* no unsubscribe-able subscription */ };
}

/** Stub: resolves immediately. */
export async function flushNow() {
  // No-op. The SDK save handler's Cmd+S keybind handles real saves.
}
