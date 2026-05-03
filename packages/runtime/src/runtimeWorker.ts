/**
 * Worker-isolated runtime client (closes core-0id.6).
 *
 * The in-page wasm runtime executes Rhai scripts, Polars SQL, and ML
 * inference on the same thread that paints the UI. Rhai's per-engine
 * operations cap (`RHAI_MAX_OPERATIONS`, P0.5) catches script-level
 * runaways, but Polars / Linfa / Candle bypass that cap entirely — a
 * malicious or buggy cell can still freeze the tab indefinitely.
 *
 * `createWorkerRuntimeClient` runs cells inside a Worker and applies a
 * wall-clock budget the host can configure. Overruns terminate the
 * Worker, respawn a fresh one, and reject the in-flight call with a
 * clear error. Other pending calls on the same worker reject too,
 * since terminating drops their state.
 *
 * Chat cells stream tokens from an `LlmClient` that lives on the main
 * thread (fetch + Convex bindings). They aren't transferable to a
 * worker, so chat dispatch stays on the main thread — same wall-clock
 * budget enforcement is the host's responsibility (LLM streams already
 * have their own request timeouts).
 *
 * Wiring:
 *   // host code (main thread)
 *   import { createWorkerRuntimeClient } from "@work.books/runtime";
 *   const client = createWorkerRuntimeClient({
 *     workerFactory: () => new Worker(new URL("./my-worker.ts", import.meta.url), { type: "module" }),
 *     wallClockMs: 30_000,
 *     llmClient,
 *   });
 *
 *   // my-worker.ts (consumer-owned)
 *   import { installRuntimeWorkerHandler } from "@work.books/runtime/runtimeWorkerEntry";
 *   installRuntimeWorkerHandler({ loadWasm: () => import("workbook-runtime") });
 */

import type {
  BuildInfo,
  CellOutput,
  InitRuntimeRequest,
  InitRuntimeResponse,
  RunCellRequest,
  RunCellResponse,
  RuntimeClient,
} from "./wasmBridge";
import type { ChatMessage, LlmClient } from "./llmClient";

const DEFAULT_WALL_CLOCK_MS = 30_000;

// Message protocol — keep deliberately narrow so the consumer-facing
// worker entry can validate without pulling in additional deps.
export type WorkerReq =
  | { type: "init"; id: string; req: InitRuntimeRequest }
  | { type: "runCell"; id: string; req: RunCellRequest }
  | { type: "buildInfo"; id: string }
  | { type: "destroy"; id: string; runtimeId: string };

export type WorkerRes =
  | { type: "ok"; id: string; result: unknown }
  | { type: "err"; id: string; message: string };

export interface WorkerRuntimeClientOptions {
  /**
   * Construct a fresh Worker. Called once on creation and again after
   * any wall-clock-triggered termination. Must point at a worker entry
   * that calls `installRuntimeWorkerHandler`.
   */
  workerFactory: () => Worker;
  /**
   * Per-cell wall-clock budget. Defaults to 30 s. Hosts that schedule
   * long-running training loops should opt-in higher; interactive cells
   * benefit from a much tighter cap (5–10 s).
   */
  wallClockMs?: number;
  /**
   * Optional LLM client for `chat` cells. Stays on the main thread
   * (see file header). When unset, chat cells throw.
   */
  llmClient?: LlmClient;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createWorkerRuntimeClient(
  opts: WorkerRuntimeClientOptions,
): RuntimeClient {
  const wallClockMs = opts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  let worker = opts.workerFactory();
  const pending = new Map<string, Pending>();
  let nextId = 0;
  const newId = () => `r${++nextId}`;

  function rejectAll(reason: Error): void {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    pending.clear();
  }

  function attach(w: Worker): void {
    w.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as WorkerRes;
      if (!msg || typeof msg !== "object" || !("id" in msg)) return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.type === "ok") p.resolve(msg.result);
      else p.reject(new Error(msg.message));
    };
    w.onerror = (ev: ErrorEvent) => {
      // Worker-level error (uncaught throw inside the worker). Reject
      // every in-flight call — there's no telling which one tripped it.
      rejectAll(new Error(`runtime worker error: ${ev.message ?? "unknown"}`));
    };
  }
  attach(worker);

  function respawn(): void {
    try { worker.terminate(); } catch { /* ignore */ }
    worker = opts.workerFactory();
    attach(worker);
  }

  function rpc<T>(req: WorkerReq): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Wall-clock overrun. Terminate the worker (the only way to
        // stop synchronous wasm code from another thread), respawn,
        // reject the offending call, and reject every sibling — their
        // state is gone with the worker.
        pending.delete(req.id);
        respawn();
        const overrun = new Error(
          `cell exceeded wall-clock budget of ${wallClockMs}ms; ` +
            `worker terminated`,
        );
        const sibling = new Error(
          "runtime worker terminated mid-flight (sibling cell exceeded " +
            "wall-clock budget)",
        );
        for (const [id, p] of pending) {
          clearTimeout(p.timer);
          p.reject(sibling);
          pending.delete(id);
        }
        reject(overrun);
      }, wallClockMs);
      pending.set(req.id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      try {
        worker.postMessage(req);
      } catch (err) {
        clearTimeout(timer);
        pending.delete(req.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async function runChatOnMain(req: RunCellRequest): Promise<RunCellResponse> {
    if (!opts.llmClient) {
      throw new Error("chat cells require an llmClient — pass one to createWorkerRuntimeClient");
    }
    const params = (req.params ?? {}) as Record<string, unknown>;
    const userMessage = String(params.message ?? params.user ?? "");
    const history = Array.isArray(params.history) ? (params.history as unknown[]) : [];
    const messages: ChatMessage[] = [];
    if (req.cell.source) {
      messages.push({ role: "system", content: req.cell.source });
    }
    for (const m of history) {
      if (m && typeof m === "object") messages.push(m as ChatMessage);
    }
    if (userMessage) messages.push({ role: "user", content: userMessage });

    const model =
      (params.model as string | undefined) ??
      (req.cell.spec as { model?: string } | undefined)?.model ??
      "openai/gpt-4o-mini";

    const stream = opts.llmClient.generateChat({
      model,
      messages,
      temperature: typeof params.temperature === "number" ? params.temperature : undefined,
      maxOutputTokens:
        typeof params.maxOutputTokens === "number" ? params.maxOutputTokens : undefined,
    });

    const outputs: CellOutput[] = [];
    for await (const ev of stream) {
      if (ev.kind === "delta") {
        outputs.push({ kind: "stream", content: ev.text });
      } else if (ev.kind === "done") {
        if (ev.stopReason === "error") {
          outputs.push({ kind: "error", message: ev.errorMessage ?? "llm error" });
        } else {
          outputs.push({ kind: "text", content: ev.finalText, mime_type: "text/plain" });
        }
      }
    }
    return { outputs };
  }

  return {
    async initRuntime(req) {
      return rpc<InitRuntimeResponse>({ type: "init", id: newId(), req });
    },
    async runCell(req) {
      if (req.cell.language === "chat") {
        return runChatOnMain(req);
      }
      return rpc<RunCellResponse>({ type: "runCell", id: newId(), req });
    },
    async pauseRuntime(_runtimeId) {
      // No-op in the worker client — pause has no defined semantics
      // for the in-page WASM today. Kept for interface parity.
    },
    async destroyRuntime(runtimeId) {
      await rpc<unknown>({ type: "destroy", id: newId(), runtimeId });
    },
    async buildInfo() {
      return rpc<BuildInfo>({ type: "buildInfo", id: newId() });
    },
  };
}
