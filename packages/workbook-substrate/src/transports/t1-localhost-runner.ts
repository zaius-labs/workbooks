// T1 — Localhost runner transport.
//
// When the workbook is running inside the polyglot APE binary
// (workbook-runner), the binary exposes:
//   GET /_runner/info         { runner: "workbook-runner/x.y", self: "...", payload_bytes: N, self_rewrite: true }
//   PUT /save                 body = full HTML to persist
//
// This transport detects T1 mode by probing /_runner/info on the
// current origin. If found, every commitPatch routes through PUT /save
// against the runner — silent autosave, no picker, no permission.
//
// The runner atomically rewrites the binary on disk per save. The file
// IS the database. T1 is the silent path; user never sees a save dialog.

import type {
  SubstrateTransport,
  CommitRequest,
  CommitResult,
  WriteSemantics,
} from "../transport";

interface RunnerInfo {
  runner: string;
  self: string;
  payload_bytes: number;
  self_rewrite: boolean;
}

export class LocalhostRunnerTransport implements SubstrateTransport {
  private listeners = new Set<(s: WriteSemantics["status"]) => void>();
  private status: WriteSemantics["status"] = "saved-in-file";
  private origin: string;
  private info: RunnerInfo | null = null;

  constructor(origin: string = (typeof location !== "undefined" ? location.origin : "")) {
    this.origin = origin;
  }

  /** Probe the current origin for a workbook runner. Resolves true if
   *  the runner is reachable; the negotiator uses this as the
   *  availability signal. */
  static async detect(origin?: string): Promise<{ available: boolean; info?: RunnerInfo }> {
    const o = origin ?? (typeof location !== "undefined" ? location.origin : "");
    if (!o) return { available: false };
    try {
      const res = await fetch(`${o}/_runner/info`, { method: "GET", cache: "no-store" });
      if (!res.ok) return { available: false };
      const info = (await res.json()) as RunnerInfo;
      if (typeof info?.runner === "string" && info.runner.startsWith("workbook-runner/")) {
        return { available: true, info };
      }
      return { available: false };
    } catch {
      return { available: false };
    }
  }

  semantics(): WriteSemantics {
    return {
      canTrueAppend: false,         // runner rewrites whole file (it's atomic)
      rewriteCostPerCommit: "full",
      fingerprintAfterClose: "deterministic",
      tier: "T1",
      status: this.status,
    };
  }

  async prepare(): Promise<void> {
    const r = await LocalhostRunnerTransport.detect(this.origin);
    if (!r.available) {
      throw new Error("workbook runner not reachable on this origin");
    }
    this.info = r.info ?? null;
    this.setStatus("saved-in-file");
  }

  async commitPatch(req: CommitRequest): Promise<CommitResult> {
    try {
      const res = await fetch(`${this.origin}/save`, {
        method: "PUT",
        body: req.newImage.html,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": String(req.newImage.byteLength),
        },
      });
      if (!res.ok) {
        this.setStatus("read-only");
        return { kind: "error", message: `runner save returned ${res.status} ${res.statusText}` };
      }
      this.setStatus("saved-in-file");
      return { kind: "ok", durableAt: Date.now() };
    } catch (e) {
      // Network failure → runner died. Drop status so the UI surfaces
      // it; the runtime can fall back or alert the user.
      this.setStatus("read-only");
      return { kind: "error", message: (e as Error).message };
    }
  }

  /** Ask the runner to exit. Useful on tab close so the binary doesn't
   *  hang around with an open port indefinitely. */
  async shutdownRunner(): Promise<void> {
    try {
      await fetch(`${this.origin}/_runner/shutdown`, { method: "POST" });
    } catch { /* runner already gone */ }
  }

  onStatusChange(fn: (s: WriteSemantics["status"]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async dispose(): Promise<void> {
    // Don't auto-shutdown — let the runner's idle timer handle it
    // unless explicitly asked.
  }

  private setStatus(s: WriteSemantics["status"]): void {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.listeners) {
      try { fn(s); } catch (e) { console.warn("substrate T1 listener:", e); }
    }
  }
}
