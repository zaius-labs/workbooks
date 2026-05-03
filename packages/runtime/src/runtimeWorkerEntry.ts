/**
 * Worker-side handler for the runtime worker (closes core-0id.6).
 *
 * Pair file to `runtimeWorker.ts`. The consumer's worker entry calls
 * `installRuntimeWorkerHandler({ loadWasm })` once at module top
 * level; from then on the worker dispatches main-thread RPC calls
 * onto a per-worker `createRuntimeClient` instance.
 *
 * Chat cells are routed back to the main thread by `runtimeWorker.ts`
 * before they reach this handler — this entry never holds an
 * LlmClient and never handles `language: "chat"`.
 *
 * Example consumer worker entry:
 *
 *   // my-worker.ts
 *   import { installRuntimeWorkerHandler } from "@work.books/runtime/runtimeWorkerEntry";
 *   installRuntimeWorkerHandler({
 *     loadWasm: () => import("workbook-runtime"),
 *   });
 */

import { createRuntimeClient, type WasmLoader } from "./wasmBridge";
import type { WorkerReq, WorkerRes } from "./runtimeWorker";

export interface RuntimeWorkerHandlerOptions {
  loadWasm: WasmLoader;
}

/** Minimal worker-scope shape — avoids needing the WebWorker lib in
 *  tsconfig (which conflicts with DOM). */
interface WorkerScope {
  onmessage: ((ev: MessageEvent) => unknown) | null;
  postMessage: (data: unknown) => void;
}

export function installRuntimeWorkerHandler(
  opts: RuntimeWorkerHandlerOptions,
): void {
  const client = createRuntimeClient({ loadWasm: opts.loadWasm });
  const scope = self as unknown as WorkerScope;

  scope.onmessage = async (ev: MessageEvent) => {
    const msg = ev.data as WorkerReq;
    if (!msg || typeof msg !== "object" || !("type" in msg) || !("id" in msg)) {
      return;
    }
    const id = msg.id;
    try {
      let result: unknown;
      if (msg.type === "init") {
        result = await client.initRuntime(msg.req);
      } else if (msg.type === "runCell") {
        // Defense in depth: chat should never reach the worker (the
        // main-thread client routes it directly), but if it does we
        // surface a clear error rather than throwing inside the WASM
        // dispatch where the message is less helpful.
        if (msg.req.cell.language === "chat") {
          throw new Error(
            "chat cells must be dispatched on the main thread, not the worker",
          );
        }
        result = await client.runCell(msg.req);
      } else if (msg.type === "buildInfo") {
        result = await client.buildInfo();
      } else if (msg.type === "destroy") {
        await client.destroyRuntime(msg.runtimeId);
        result = null;
      } else {
        throw new Error(`unknown worker request type`);
      }
      const res: WorkerRes = { type: "ok", id, result };
      scope.postMessage(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const res: WorkerRes = { type: "err", id, message };
      scope.postMessage(res);
    }
  };
}
