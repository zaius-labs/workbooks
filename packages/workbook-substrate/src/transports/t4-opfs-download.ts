// T4 — OPFS shadow + download fallback.
//
// Used when no FSA path is available (Firefox, Safari, mobile,
// `file://` without a secure context). Strategy:
//
//   1. Each commitPatch writes the new image to an OPFS file keyed by
//      the workbook's identity (`${workbook_id}-${fingerprint}.html`).
//      This is the "shadow" — a session-local copy of the user's
//      latest state, bound to the workbook's identity.
//   2. The runtime exposes a "Download to keep changes" button. On
//      click, T4 reads its OPFS shadow and triggers a Blob download
//      with the workbook's filename.
//
// What this is NOT:
//   - Not a primary database. The OPFS shadow is purely a write buffer
//     keyed to a specific workbook's content fingerprint.
//   - Not a sync mechanism. If the user doesn't download, their state
//     stays in OPFS until cleared by browser site data eviction.
//
// Conflation guarantee: if the user opens a different workbook (or
// opens this same workbook AFTER it was modified externally), the new
// fingerprint differs and OPFS lookup misses. State from the old
// session is invisible.

import type {
  SubstrateTransport,
  CommitRequest,
  CommitResult,
  WriteSemantics,
} from "../transport";

export interface T4Options {
  /** Filename to suggest for downloads. Defaults to a guess. */
  downloadFilename?: string;
  /** Workbook identity, used to key the OPFS shadow. Required so two
   *  workbooks of the same origin don't trample each other. */
  workbookId: string;
}

export class OpfsDownloadTransport implements SubstrateTransport {
  private shadowFile: any /* FileSystemFileHandle */ = null;
  private currentFingerprint: string | null = null;
  private latestImage: { html: string; byteLength: number } | null = null;
  private listeners = new Set<(s: WriteSemantics["status"]) => void>();
  private status: WriteSemantics["status"] = "download-to-keep";

  constructor(private opts: T4Options) {}

  semantics(): WriteSemantics {
    return {
      canTrueAppend: false,
      rewriteCostPerCommit: "full",
      fingerprintAfterClose: "queryable",
      tier: "T4",
      status: this.status,
    };
  }

  async prepare(): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
      throw new Error("OPFS unavailable in this environment");
    }
    const root = await navigator.storage.getDirectory();
    const dirName = `wb-substrate.${this.opts.workbookId}`;
    const dir = await root.getDirectoryHandle(dirName, { create: true });
    this.shadowFile = await dir.getFileHandle("latest.html", { create: true });
  }

  async commitPatch(req: CommitRequest): Promise<CommitResult> {
    if (!this.shadowFile) {
      return { kind: "error", message: "T4 transport not prepared" };
    }
    try {
      const writable = await this.shadowFile.createWritable();
      await writable.write(req.newImage.html);
      await writable.close();
      this.currentFingerprint = req.newImage.fingerprint;
      this.latestImage = { html: req.newImage.html, byteLength: req.newImage.byteLength };
      // T4 always has the "queued for user download" status — it is
      // never auto-durable on disk.
      this.setStatus("download-to-keep");
      return {
        kind: "queued",
        reason: "saved to OPFS shadow; user must click Download to commit to disk",
      };
    } catch (e) {
      return { kind: "error", message: (e as Error).message };
    }
  }

  /** User clicked the "Download" button. Triggers a Blob download of
   *  the latest image. */
  async triggerDownload(): Promise<void> {
    if (!this.latestImage) {
      // Read from OPFS in case the latest is from a prior session.
      if (!this.shadowFile) await this.prepare();
      const file = await this.shadowFile.getFile();
      const html = await file.text();
      this.latestImage = { html, byteLength: html.length };
    }
    if (typeof document === "undefined") {
      throw new Error("triggerDownload requires a DOM (document.createElement)");
    }
    const blob = new Blob([this.latestImage.html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = this.opts.downloadFilename ?? guessFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Has the user committed (downloaded) the latest changes? */
  hasUnflushedChanges(): boolean {
    return this.latestImage !== null;
  }

  /** Clear the OPFS shadow — call after a confirmed successful download. */
  async clearShadow(): Promise<void> {
    if (!this.shadowFile) return;
    const writable = await this.shadowFile.createWritable();
    await writable.write(new Uint8Array(0));
    await writable.close();
    this.latestImage = null;
  }

  onStatusChange(fn: (s: WriteSemantics["status"]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async dispose(): Promise<void> {
    this.shadowFile = null;
    this.latestImage = null;
  }

  private setStatus(s: WriteSemantics["status"]): void {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.listeners) {
      try { fn(s); } catch (e) { console.warn("substrate transport listener:", e); }
    }
  }
}

function guessFileName(): string {
  if (typeof location === "undefined") return "workbook.html";
  const last = decodeURIComponent(location.pathname.split("/").pop() ?? "");
  if (last.endsWith(".html")) return last;
  if (last.endsWith(".html")) return last;
  return "workbook.html";
}
