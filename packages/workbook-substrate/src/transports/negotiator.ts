// Substrate transport negotiator.
//
// Picks the strongest available transport on runtime startup. The
// runtime calls negotiate() once, then uses the returned transport for
// every commitPatch.
//
// Priority: T2 > T3 > T4 > T5.
// A transport may "graduate" mid-session (e.g. user installs PWA, on
// next reopen T2 supersedes T3) — that's a reload, not a swap.
// Within a session, the chosen transport is fixed.

import type { SubstrateTransport } from "../transport";
import { PwaFsaTransport } from "./t2-pwa-fsa";
import { FsaSessionTransport } from "./t3-fsa-session";
import { OpfsDownloadTransport } from "./t4-opfs-download";
import { ReadOnlyTransport } from "./t5-readonly";

export interface NegotiateOptions {
  workbookId: string;
  /** If false, never attempt T2 even when in PWA context. Useful for
   *  tests or for runtimes that explicitly want session-only saves. */
  allowPwa?: boolean;
  /** Filename for download fallback. */
  downloadFilename?: string;
  /** "Save to file" picker hint for T3. */
  pickerSuggestedName?: string;
}

export interface NegotiateResult {
  transport: SubstrateTransport;
  /** What we picked + why. Useful for telemetry. */
  reasoning: string;
}

/** Pick a transport. Async because T2 prepares against launchQueue. */
export async function negotiate(opts: NegotiateOptions): Promise<NegotiateResult> {
  const allowPwa = opts.allowPwa !== false;

  // T2: PWA-installed FSA via launchQueue
  if (allowPwa && PwaFsaTransport.isInPwaContext() && typeof (globalThis as any).launchQueue !== "undefined") {
    const t2 = new PwaFsaTransport();
    try {
      await t2.prepare();
      if (t2.hasHandle()) {
        return {
          transport: t2,
          reasoning: "T2: running in PWA standalone with file handle from launchQueue",
        };
      }
    } catch (e) {
      // fall through
    }
  }

  // T3: per-session FSA — available if showSaveFilePicker exists.
  if (typeof (globalThis as any).showSaveFilePicker === "function") {
    return {
      transport: new FsaSessionTransport({ suggestedName: opts.pickerSuggestedName }),
      reasoning: "T3: FSA showSaveFilePicker available; user click required to acquire handle",
    };
  }

  // T4: OPFS shadow + download fallback
  if (typeof (globalThis as any).navigator?.storage?.getDirectory === "function") {
    const t4 = new OpfsDownloadTransport({
      workbookId: opts.workbookId,
      downloadFilename: opts.downloadFilename,
    });
    try {
      await t4.prepare();
      return {
        transport: t4,
        reasoning: "T4: OPFS available, download fallback for user commits",
      };
    } catch (e) {
      // fall through
    }
  }

  // T5: read-only
  return {
    transport: new ReadOnlyTransport(),
    reasoning: "T5: no transport available (no FSA, no OPFS) — read-only mode",
  };
}
