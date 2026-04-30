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
  getDoc,
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
  return probeMediaDurationFromSrc(dataUrl, kind);
}

async function probeMediaDurationFromSrc(src, kind) {
  if (kind !== "video" && kind !== "audio") return null;
  return new Promise((resolve) => {
    const el = document.createElement(kind === "video" ? "video" : "audio");
    el.preload = "metadata";
    el.src = src;
    const done = (v) => resolve(v);
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? +el.duration.toFixed(2) : null);
    el.onerror = () => done(null);
    setTimeout(() => done(null), 4000);
  });
}

function inferKindFromUrl(parsedUrl) {
  const ext = parsedUrl.pathname
    .toLowerCase()
    .split(".")
    .pop();
  if (!ext || ext === parsedUrl.pathname.toLowerCase()) return null;
  if (["png", "jpg", "jpeg", "gif", "webp", "avif"].includes(ext)) return "image";
  if (ext === "svg") return "svg";
  if (["mp4", "webm", "mov", "m4v", "ogv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(ext)) return "audio";
  return null;
}

class AssetsStore {
  // [{id, name, type, kind, dataUrl, size, duration, addedAt}]
  items = $state([]);
  hydrated = $state(false);

  constructor() {
    // Sync hydrate when main.js has already awaited bootstrap
    // (the standard entry path). Falls back to the async path if
    // a non-standard entry skipped the main.js await.
    if (getDoc()) {
      const stored = readAssets();
      if (stored.length > 0) this.items = stored;
      this.hydrated = true;
    } else {
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

  /**
   * Add a URL-linked asset (image / video / audio). The URL becomes
   * the `dataUrl` field; the composition embeds it via <img src=...>
   * etc. Bytes never load into the studio — the recipient's browser
   * fetches at playback. Cheaper than data URLs, but the rendered
   * artifact depends on the URL staying reachable.
   *
   * The asset is flagged `linked: true` so the UI can mark it
   * distinctly from embedded blobs.
   *
   * Kind is inferred from the URL extension; pass `opts.kind` to
   * override (useful for query-string-bearing URLs that don't end
   * in a recognizable extension). Duration is probed asynchronously
   * for video/audio; failure is silent (linked assets often disallow
   * cross-origin metadata reads).
   *
   * @param {string} url
   * @param {{ name?: string, kind?: "image"|"video"|"audio"|"svg" }} [opts]
   */
  async addFromUrl(url, opts = {}) {
    const trimmed = String(url ?? "").trim();
    if (!trimmed) throw new Error("URL is empty");

    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`'${trimmed}' isn't a valid URL`);
    }
    if (!/^https?:$/i.test(parsed.protocol)) {
      throw new Error(`URL protocol '${parsed.protocol}' isn't supported — use http(s).`);
    }

    const kind = opts.kind ?? inferKindFromUrl(parsed);
    if (!kind) {
      throw new Error(
        "Couldn't detect the asset kind from the URL. Pass it explicitly, " +
        "or use a URL ending in a recognizable extension (.png, .jpg, .svg, .mp4, .webm, .mp3, .wav).",
      );
    }

    const inferredName =
      opts.name ||
      decodeURIComponent(parsed.pathname.split("/").pop() || "") ||
      `${kind}-linked`;

    // Probe duration for video/audio. Some URLs reject cross-origin
    // metadata reads; we silently fall back to null in that case.
    const duration = await probeMediaDurationFromSrc(trimmed, kind);

    const id = `asset-${Math.random().toString(36).slice(2, 10)}`;
    const item = {
      id,
      name: inferredName,
      type: kind === "svg" ? "image/svg+xml" : `${kind}/*`,
      kind,
      dataUrl: trimmed,
      size: 0,                  // unknown for linked assets
      duration,
      addedAt: Date.now(),
      linked: true,
    };
    this.items = [...this.items, item];
    pushAsset(item);
    recordEdit(
      `asset:${item.id}`,
      { id: item.id, name: item.name, kind: item.kind, linked: true },
      `add linked asset ${item.name}`,
    );
    return item;
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
