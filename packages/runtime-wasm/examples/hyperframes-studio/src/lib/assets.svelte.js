// Asset library — image / video / audio / svg files the user has
// loaded into this session. Stored in-memory as base64 data URLs
// so they're portable (no disk paths, no dev-server proxy) and
// can be embedded directly into the composition HTML.
//
// Why data URLs instead of blob URLs:
//   - blob URLs are scoped to the document that created them and
//     don't transfer cleanly to a sandboxed iframe with
//     `srcdoc` (different document context). Rebuilding the blob
//     in the iframe defeats the point.
//   - data URLs are origin-independent: they work in any iframe,
//     in any srcdoc, and survive when the composition is exported
//     as a standalone .html file.
//   - Cost: ~33% size inflation (base64), and the whole asset
//     lives in the JS heap. We don't accept files > ~50 MB.
//
// Persistence: a top-level Loro List inside the workbook's CRDT doc
// (see loroBackend.svelte.js). Concurrent asset adds across forks
// merge cleanly via the list CRDT. Reload rehydrates from the doc.
// Asset add/remove also records a Prolly Tree commit for audit.

import { recordEdit, recordDelete } from "./historyBackend.svelte.js";
import {
  bootstrapLoro,
  readAssets,
  pushAsset,
  removeAssetById,
  replaceAssets,
} from "./loroBackend.svelte.js";

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB hard cap per asset

function classify(file) {
  const t = file?.type ?? "";
  if (t === "image/svg+xml") return "svg";
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  return null;
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error("FileReader failed"));
    r.readAsDataURL(file);
  });
}

async function probeMediaDuration(dataUrl, kind) {
  if (kind !== "video" && kind !== "audio") return null;
  return new Promise((resolve) => {
    const el = document.createElement(kind === "video" ? "video" : "audio");
    el.preload = "metadata";
    el.src = dataUrl;
    const done = (v) => resolve(v);
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? +el.duration.toFixed(2) : null);
    el.onerror = () => done(null);
    setTimeout(() => done(null), 4000);
  });
}

class AssetsStore {
  // [{id, name, type, kind, dataUrl, size, duration, addedAt}]
  items = $state([]);
  hydrated = $state(false);

  constructor() {
    bootstrapLoro()
      .then(() => {
        const stored = readAssets();
        if (stored.length > 0) this.items = stored;
        this.hydrated = true;
      })
      .catch((e) => {
        console.warn("assets: hydrate failed:", e?.message ?? e);
        this.hydrated = true;
      });
  }

  async addFromFile(file) {
    const kind = classify(file);
    if (!kind) throw new Error(`Unsupported type: ${file?.type || "unknown"}`);
    if (file.size > MAX_BYTES) {
      throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB) — limit is 50 MB. Use the HyperFrames CLI for large media.`);
    }
    const dataUrl = await readAsDataUrl(file);
    const duration = await probeMediaDuration(dataUrl, kind);
    const id = `asset-${Math.random().toString(36).slice(2, 10)}`;
    const item = {
      id,
      name: file.name || `${kind}-${id}`,
      type: file.type,
      kind,
      dataUrl,
      size: file.size,
      duration,
      addedAt: Date.now(),
    };
    this.items = [...this.items, item];
    pushAsset(item);
    // Audit-chain entry: omit the dataUrl since the bytes already
    // live in the Loro list; the audit just records identity.
    recordEdit(
      `asset:${item.id}`,
      { id: item.id, name: item.name, kind: item.kind, mime: item.type, size: item.size, duration: item.duration },
      `add asset ${item.name}`,
    );
    return item;
  }

  async addFromFiles(fileList) {
    const out = [];
    const errors = [];
    for (const f of fileList) {
      try { out.push(await this.addFromFile(f)); }
      catch (e) { errors.push(`${f.name}: ${e.message ?? e}`); }
    }
    return { added: out, errors };
  }

  remove(id) {
    this.items = this.items.filter((a) => a.id !== id);
    removeAssetById(id);
    recordDelete(`asset:${id}`, `remove asset ${id}`);
  }

  /** Replace the entire registry with the supplied items in one
   *  reactive update. Used by importProjectFile to apply a project
   *  state without firing per-item subscribers. */
  replaceAll(items) {
    this.items = (items ?? []).slice();
    replaceAssets(this.items);
  }

  get(id) { return this.items.find((a) => a.id === id) ?? null; }

  get totalBytes() {
    return this.items.reduce((s, a) => s + (a.size ?? 0), 0);
  }
}

export const assets = new AssetsStore();

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
