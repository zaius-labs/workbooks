// T2 — PWA-installed File System Access.
//
// When the workbook PWA is installed and the user opens a workbook
// .html file via the OS file association, the LaunchQueue API delivers
// FileSystemFileHandles directly to the PWA on launch — no picker, no
// permission prompt (the act of "open with PWA" is itself the grant).
//
// T2 is the silent-autosave path. T3 falls back when:
//   - PWA not installed
//   - user opened the file from a non-PWA browser tab
//   - launchQueue empty (e.g. PWA opened by clicking its icon)

import type {
  SubstrateTransport,
  CommitRequest,
  CommitResult,
  WriteSemantics,
} from "../transport";

interface FsaHandle {
  createWritable(opts?: { keepExistingData?: boolean }): Promise<{
    write(data: ArrayBufferView | ArrayBuffer | string): Promise<void>;
    close(): Promise<void>;
  }>;
  queryPermission?(opts?: { mode?: "read" | "readwrite" }): Promise<"granted" | "denied" | "prompt">;
  requestPermission?(opts?: { mode?: "read" | "readwrite" }): Promise<"granted" | "denied" | "prompt">;
}

export class PwaFsaTransport implements SubstrateTransport {
  private handle: FsaHandle | null = null;
  private listeners = new Set<(s: WriteSemantics["status"]) => void>();
  private status: WriteSemantics["status"] = "needs-permission";

  semantics(): WriteSemantics {
    return {
      canTrueAppend: false,
      rewriteCostPerCommit: "full",
      fingerprintAfterClose: "queryable",
      tier: "T2",
      status: this.status,
    };
  }

  /** Detect: is the runtime currently launched in PWA standalone mode? */
  static isInPwaContext(): boolean {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(display-mode: standalone)").matches
      || (window.navigator as any).standalone === true;
  }

  /** Subscribe to launchQueue and capture the first delivered handle.
   *  Must be called early in PWA boot — the LaunchQueue spec delivers
   *  files via setConsumer before the runtime user has a chance to do
   *  anything with them. */
  async prepare(): Promise<void> {
    if (this.handle) return;
    if (typeof window === "undefined" || !("launchQueue" in window)) {
      throw new Error("LaunchQueue API not available — not running in a PWA?");
    }
    const lq = (window as any).launchQueue;
    return new Promise<void>((resolve) => {
      lq.setConsumer(async (params: { files: FsaHandle[] }) => {
        if (!params.files || params.files.length === 0) {
          // PWA opened without a file (e.g. icon click) — T2 is unavailable
          // for this session. Caller should fall back to T3 or T4.
          resolve();
          return;
        }
        this.handle = params.files[0];
        // Permission is implicit in launchQueue delivery, but verify.
        if (this.handle.queryPermission) {
          const perm = await this.handle.queryPermission({ mode: "readwrite" });
          if (perm !== "granted") {
            const reqPerm = await this.handle.requestPermission?.({ mode: "readwrite" });
            if (reqPerm !== "granted") {
              this.handle = null;
              this.setStatus("needs-permission");
              resolve();
              return;
            }
          }
        }
        this.setStatus("saved-in-file");
        resolve();
      });
    });
  }

  async commitPatch(req: CommitRequest): Promise<CommitResult> {
    if (!this.handle) {
      return { kind: "error", message: "T2 transport has no handle (open file via PWA file_handlers)" };
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

  hasHandle(): boolean {
    return this.handle !== null;
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
