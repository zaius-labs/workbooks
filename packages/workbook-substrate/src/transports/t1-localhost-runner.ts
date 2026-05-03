// T1 — Localhost runner transport (workbooksd).
//
// When the workbook is being served by the workbooksd daemon, the page
// is loaded under http://127.0.0.1:47119/wb/<token>/, and the daemon
// exposes:
//
//   GET  /health             "ok"                      (presence probe)
//   PUT  /wb/<token>/save    body = full HTML bytes    (atomic rewrite)
//
// This transport detects T1 mode by:
//   (a) probing /health on the current origin → "ok"
//   (b) confirming location.pathname starts with /wb/ (we're inside a
//       bound session)
//
// If both are true, every commitPatch routes through the bound
// /wb/<token>/save URL. The daemon writes via tmp + rename, so saves
// are atomic from the file system's perspective. T1 is the silent path;
// the user never sees a save dialog or a permission prompt.
//
// Pre-workbooksd this transport spoke to the C polyglot APE binary at
// /_runner/info + /save. That runner has been deprecated (see
// packages/workbooksd for the replacement). The transport contract is
// the same — only the endpoint shape changed.
import type {
  SubstrateTransport,
  CommitRequest,
  CommitResult,
  WriteSemantics,
} from "../transport";

interface DaemonInfo {
  /** The token the daemon bound to this session. Derived from the URL
   *  path under /wb/ — never trusted from a server response. */
  token: string;
  /** Origin we're talking to (always 127.0.0.1:47119 in practice). */
  origin: string;
}

export class LocalhostRunnerTransport implements SubstrateTransport {
  private listeners = new Set<(s: WriteSemantics["status"]) => void>();
  private status: WriteSemantics["status"] = "saved-in-file";
  private origin: string;
  private info: DaemonInfo | null = null;

  constructor(origin: string = (typeof location !== "undefined" ? location.origin : "")) {
    this.origin = origin;
  }

  /** Probe the current origin for the workbooksd daemon and confirm
   *  this page is loaded under a bound session URL (/wb/<token>/).
   *  Returns availability + the bound token if so. The negotiator uses
   *  this as the T1 availability signal. */
  static async detect(origin?: string): Promise<{ available: boolean; info?: DaemonInfo; reason?: string }> {
    const o = origin ?? (typeof location !== "undefined" ? location.origin : "");
    if (!o) {
      console.log("[substrate T1] detect: no origin");
      return { available: false, reason: "no origin" };
    }

    const path = typeof location !== "undefined" ? location.pathname : "";
    const m = path.match(/^\/wb\/([0-9a-f]{32})\/?/);
    if (!m) {
      console.log("[substrate T1] detect: not on /wb/<token>/ — pathname is", path);
      return { available: false, reason: "not bound to a daemon session" };
    }
    const token = m[1];

    try {
      const res = await fetch(`${o}/health`, { method: "GET", cache: "no-store" });
      if (!res.ok) {
        console.log("[substrate T1] detect: /health returned", res.status);
        return { available: false, reason: `health ${res.status}` };
      }
      const body = (await res.text()).trim();
      if (body !== "ok") {
        console.log("[substrate T1] detect: /health body unexpected:", body.slice(0, 40));
        return { available: false, reason: "unexpected health body" };
      }
      console.log("[substrate T1] detect: workbooksd reachable, token=", token.slice(0, 8) + "…");
      return { available: true, info: { token, origin: o } };
    } catch (e) {
      console.log("[substrate T1] detect: fetch failed:", (e as Error).message);
      return { available: false, reason: (e as Error).message };
    }
  }

  semantics(): WriteSemantics {
    return {
      canTrueAppend: false,         // daemon rewrites whole file (atomic)
      rewriteCostPerCommit: "full",
      fingerprintAfterClose: "deterministic",
      tier: "T1",
      status: this.status,
    };
  }

  async prepare(): Promise<void> {
    const r = await LocalhostRunnerTransport.detect(this.origin);
    if (!r.available || !r.info) {
      throw new Error("workbooksd not reachable on this origin or page not bound to a session");
    }
    this.info = r.info;
    this.setStatus("saved-in-file");
  }

  async commitPatch(req: CommitRequest): Promise<CommitResult> {
    if (!this.info) {
      console.log("[substrate T1] commitPatch: transport not prepared");
      this.setStatus("read-only");
      return { kind: "error", message: "transport not prepared" };
    }
    const url = `${this.info.origin}/wb/${this.info.token}/save`;
    console.log("[substrate T1] commitPatch: PUT", url, `(${req.newImage.byteLength} bytes)`);
    try {
      const res = await fetch(url, {
        method: "PUT",
        body: req.newImage.html,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": String(req.newImage.byteLength),
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.log("[substrate T1] commitPatch: daemon returned", res.status, text.slice(0, 200));
        this.setStatus("read-only");
        return { kind: "error", message: `daemon save returned ${res.status} ${res.statusText}` };
      }
      console.log("[substrate T1] commitPatch: saved");
      this.setStatus("saved-in-file");
      return { kind: "ok", durableAt: Date.now() };
    } catch (e) {
      console.log("[substrate T1] commitPatch: fetch failed:", (e as Error).message);
      this.setStatus("read-only");
      return { kind: "error", message: (e as Error).message };
    }
  }

  /** workbooksd has no shutdown endpoint — launchd manages the daemon
   *  lifecycle (idle-timeout-on-the-daemon-side or KeepAlive=true means
   *  we don't try to ask it to exit). Kept as a no-op so callers that
   *  conditionally invoke shutdown don't need a guard. */
  async shutdownRunner(): Promise<void> {
    /* no-op for workbooksd */
  }

  onStatusChange(fn: (s: WriteSemantics["status"]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async dispose(): Promise<void> {
    /* nothing to release; daemon owns its own lifecycle */
  }

  private setStatus(s: WriteSemantics["status"]): void {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.listeners) {
      try { fn(s); } catch (e) { console.warn("substrate T1 listener:", e); }
    }
  }
}
