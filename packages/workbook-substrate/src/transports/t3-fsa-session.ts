// T3 — Per-session File System Access.
//
// User-visible: clicks "Allow saving to this file" once per browser tab
// session. We call showSaveFilePicker (or showOpenFilePicker, as
// configured), receive a FileSystemFileHandle, and use it for every
// commitPatch in this session. Handle is lost on tab close; next visit
// re-prompts.
//
// We DO NOT persist the handle to IndexedDB by default. The user said
// "no browser cache" and storing the handle would technically be
// browser-side metadata. T2 (PWA-installed) is the path that gives
// silent reopens.

import type {
  SubstrateTransport,
  CommitRequest,
  CommitResult,
  WriteSemantics,
} from "../transport";

export interface T3Options {
  /** Suggested filename in the save picker. Defaults to a guess from
   *  location.pathname or "workbook.html". */
  suggestedName?: string;
  /** Translator for "Allow saving" button copy. */
  promptText?: string;
}

interface FsaHandle {
  createWritable(opts?: { keepExistingData?: boolean }): Promise<FsaWritableStream>;
  getFile(): Promise<File>;
  queryPermission?(opts?: { mode?: "read" | "readwrite" }): Promise<"granted" | "denied" | "prompt">;
  requestPermission?(opts?: { mode?: "read" | "readwrite" }): Promise<"granted" | "denied" | "prompt">;
}
interface FsaWritableStream {
  write(data: ArrayBufferView | ArrayBuffer | string): Promise<void>;
  close(): Promise<void>;
}

export class FsaSessionTransport implements SubstrateTransport {
  private handle: FsaHandle | null = null;
  private listeners = new Set<(s: WriteSemantics["status"]) => void>();
  private status: WriteSemantics["status"] = "needs-permission";

  constructor(private opts: T3Options = {}) {}

  semantics(): WriteSemantics {
    return {
      canTrueAppend: false,
      rewriteCostPerCommit: "full",
      fingerprintAfterClose: "queryable",
      tier: "T3",
      status: this.status,
    };
  }

  /** Prepare = the user-gesture-triggered call that opens the picker.
   *  Must be called from a click handler; cannot be auto-invoked. */
  async prepare(): Promise<void> {
    if (this.handle) return;
    if (typeof globalThis === "undefined" || !("showSaveFilePicker" in globalThis as any)) {
      throw new Error("FSA showSaveFilePicker not available in this environment");
    }
    const w = globalThis as any;
    this.handle = await w.showSaveFilePicker({
      suggestedName: this.opts.suggestedName ?? guessFileName(),
      types: [
        {
          description: "Workbook HTML",
          accept: { "text/html": [".html", ".html"] },
        },
      ],
    });
    this.setStatus("saved-in-file");
  }

  async commitPatch(req: CommitRequest): Promise<CommitResult> {
    if (!this.handle) {
      return { kind: "error", message: "T3 transport not prepared (call prepare() first via user gesture)" };
    }
    // Optional: verify queryPermission before write — request if needed.
    if (this.handle.queryPermission) {
      const perm = await this.handle.queryPermission({ mode: "readwrite" });
      if (perm !== "granted") {
        const reqPerm = await this.handle.requestPermission?.({ mode: "readwrite" });
        if (reqPerm !== "granted") {
          this.setStatus("needs-permission");
          return { kind: "error", message: "FSA write permission denied" };
        }
      }
    }
    try {
      const writable = await this.handle.createWritable();
      await writable.write(req.newImage.html);
      await writable.close();
      this.setStatus("saved-in-file");
      return { kind: "ok", durableAt: Date.now() };
    } catch (e) {
      this.setStatus("needs-permission");
      return { kind: "error", message: (e as Error).message };
    }
  }

  onStatusChange(fn: (s: WriteSemantics["status"]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async dispose(): Promise<void> {
    this.handle = null;
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
