/**
 * Autosave helpers for the workbook memory primitives.
 *
 * The memory primitives (<wb-data>, <wb-memory>, <wb-doc>, <wb-history>)
 * are passive state holders — they don't subscribe to anything and
 * don't auto-persist. Hosts that want save-on-edit semantics wire
 * change-listeners that re-serialize the workbook HTML and write it
 * back to disk / IndexedDB / a server.
 *
 * This module ships the boring half of that loop:
 *
 *   exportWorkbookHtml(client, root)
 *     pure function: walks <wb-doc>/<wb-memory>/<wb-history> elements,
 *     pulls current bytes from the runtime client + history handles,
 *     base64-encodes them back into element bodies, returns the new
 *     workbook outerHTML.
 *
 *   installAutosave({ client, root, persist, debounceMs })
 *     wrapper that attaches a debounce loop. Hosts call markDirty()
 *     after each mutation; the loop rate-limits and calls persist()
 *     with the new HTML when idle.
 *
 * What hosts still own:
 *   - calling markDirty() after their mutation (we don't observe
 *     LoroDoc subscribe events here — too many ways to miss writes
 *     coming from custom cells, agent tools, etc.)
 *   - the persist() implementation (file write, IndexedDB, server PUT)
 *   - registering <wb-history> handles so the autosave can find them
 *     (registerHistoryHandle below)
 */

import type { RuntimeClient } from "./wasmBridge";
import type { HistoryHandle } from "./workbookHistoryResolver";

function bytesToBase64(bytes: Uint8Array): string {
  // chunk to avoid argument-count limits on String.fromCharCode
  const CHUNK = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.byteLength)));
  }
  return btoa(s);
}

async function sha256HexFromBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Walk the workbook root and re-serialize every memory primitive into
 * its element body. Returns the workbook's outerHTML after writes.
 *
 * History handles are passed in via `historyHandles` — the resolver
 * yields them at mount; the host caches them and threads here. (We
 * don't reach into the resolver from here to avoid a circular dep.)
 */
export async function exportWorkbookHtml(
  client: RuntimeClient,
  root: Element,
  historyHandles: Map<string, HistoryHandle> = new Map(),
): Promise<string> {
  // <wb-doc> blocks → live LoroDoc snapshot
  for (const el of root.querySelectorAll("wb-doc")) {
    const id = el.getAttribute("id");
    if (!id || !client.exportDoc) continue;
    try {
      const bytes = await client.exportDoc(id);
      const sha256 = await sha256HexFromBytes(bytes);
      el.setAttribute("encoding", "base64");
      el.setAttribute("sha256", sha256);
      el.textContent = bytesToBase64(bytes);
    } catch {
      // Doc not registered (e.g. resolver failed at mount) — leave
      // the element untouched.
    }
  }

  // <wb-memory> blocks → current Arrow IPC stream
  for (const el of root.querySelectorAll("wb-memory")) {
    const id = el.getAttribute("id");
    if (!id || !client.exportMemory) continue;
    try {
      const bytes = await client.exportMemory(id);
      const sha256 = await sha256HexFromBytes(bytes);
      el.setAttribute("encoding", "base64");
      el.setAttribute("sha256", sha256);
      el.textContent = bytesToBase64(bytes);
    } catch {
      // Not registered — leave untouched.
    }
  }

  // <wb-history> blocks → handle.bytes() + computed HEAD
  for (const el of root.querySelectorAll("wb-history")) {
    const id = el.getAttribute("id");
    if (!id) continue;
    const handle = historyHandles.get(id);
    if (!handle) continue;
    const bytes = handle.bytes();
    const sha256 = await sha256HexFromBytes(bytes);
    el.setAttribute("encoding", "base64");
    el.setAttribute("sha256", sha256);
    el.setAttribute("head-sha256", handle.head());
    el.textContent = bytesToBase64(bytes);
  }

  // Find the document root for outerHTML — root element might be
  // <wb-workbook> deep inside an <html>; persist whichever is the
  // outermost document the host expects to save.
  return root.ownerDocument?.documentElement.outerHTML ?? root.outerHTML;
}

export interface AutosaveOptions {
  client: RuntimeClient;
  root: Element;
  /** Called after each successful save with the new HTML. */
  persist: (html: string) => void | Promise<void>;
  /** Idle window before flushing pending changes. Default 500ms. */
  debounceMs?: number;
  /**
   * History handles registered on the runtime. Optional — workbooks
   * without <wb-history> blocks pass nothing.
   */
  historyHandles?: Map<string, HistoryHandle>;
  /** Called on save errors. Default: console.error. */
  onError?: (err: unknown) => void;
  /** Called after a successful save with the resulting size. */
  onSave?: (info: { bytes: number; ms: number }) => void;
}

export interface AutosaveHandle {
  /** Called by the host after every mutation. Schedules a save. */
  markDirty(): void;
  /** Force an immediate save (e.g. on Ctrl+S). Resolves when persisted. */
  flush(): Promise<void>;
  /** Cancel any pending save and stop accepting new dirty marks. */
  dispose(): void;
}

/**
 * Wraps exportWorkbookHtml in a debounced loop. The host calls
 * markDirty() after every mutation; the loop rate-limits and calls
 * persist() with the new HTML when idle.
 */
export function installAutosave(opts: AutosaveOptions): AutosaveHandle {
  const debounceMs = opts.debounceMs ?? 500;
  const historyHandles = opts.historyHandles ?? new Map();
  const onError = opts.onError ?? ((err) => console.error("autosave error:", err));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let pending = false;
  let disposed = false;

  async function doSave(): Promise<void> {
    if (disposed) return;
    const start = performance.now();
    try {
      const html = await exportWorkbookHtml(opts.client, opts.root, historyHandles);
      await opts.persist(html);
      opts.onSave?.({ bytes: html.length, ms: performance.now() - start });
    } catch (err) {
      onError(err);
    }
  }

  async function flushIfPending(): Promise<void> {
    if (!pending) return;
    pending = false;
    inFlight = doSave();
    await inFlight;
    inFlight = null;
    // If new dirty marks landed during the save, kick another round.
    if (pending && !disposed) await flushIfPending();
  }

  return {
    markDirty() {
      if (disposed) return;
      pending = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        flushIfPending().catch(onError);
      }, debounceMs);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) await inFlight;
      pending = true;
      await flushIfPending();
    },
    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
