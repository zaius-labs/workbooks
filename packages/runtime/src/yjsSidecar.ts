/**
 * Yjs CRDT sidecar — symmetric counterpart to loroSidecar.ts for
 * `<wb-doc format="yjs">` blocks.
 *
 * Yjs is loaded via `globalThis.__wb_yjs` (the host's app entry sets
 * `globalThis.__wb_yjs = await import("yjs")` BEFORE the runtime
 * mounts). Same lookup convention as `__wb_loro`. We deliberately
 * don't import `yjs` directly — keeping the runtime engine-agnostic
 * means workbooks that don't use yjs never pull it in.
 *
 * The dispatcher returns a `LoroDocHandle`-shaped object (toJSON,
 * exportSnapshot, mutate, inner) so registerDoc / getDocHandle on
 * the runtime client treat yjs and loro docs uniformly. The storage
 * SDK in `./storage/` calls `handle.inner()` to get the raw `Y.Doc`.
 */

import type { LoroDocHandle, DocOp } from "./loroSidecar";

/** Minimal Y.Doc surface we touch. The host app passes the real
 *  yjs module via `globalThis.__wb_yjs`; we never construct anything
 *  ourselves except via that module's exports. */
interface YDoc {
  toJSON(): unknown;
  transact<T>(fn: () => T): T;
  getText(name: string): YText;
  getArray(name: string): YArray;
  getMap(name: string): YMap;
}
interface YText {
  insert(index: number, text: string): void;
  delete(index: number, length: number): void;
  toString(): string;
  observe(cb: (ev: unknown) => void): void;
  observeDeep?(cb: (evs: unknown[]) => void): void;
}
interface YArray {
  push(items: unknown[]): void;
  insert(index: number, items: unknown[]): void;
  delete(index: number, length: number): void;
  get(index: number): unknown;
  toArray(): unknown[];
  readonly length: number;
  observe(cb: (ev: unknown) => void): void;
}
interface YMap {
  set(key: string, value: unknown): void;
  delete(key: string): void;
  get(key: string): unknown;
  has(key: string): boolean;
  observe(cb: (ev: unknown) => void): void;
}

interface YjsModule {
  Doc: new () => YDoc;
  applyUpdateV2(doc: YDoc, update: Uint8Array, origin?: unknown): void;
  applyUpdate(doc: YDoc, update: Uint8Array, origin?: unknown): void;
  encodeStateAsUpdateV2(doc: YDoc): Uint8Array;
  encodeStateAsUpdate(doc: YDoc): Uint8Array;
}

let yjsPromise: Promise<YjsModule> | null = null;

async function loadYjs(): Promise<YjsModule> {
  if (!yjsPromise) {
    yjsPromise = (async () => {
      // globalThis.__wb_yjs — host-provided. The user's app does
      // `import * as Y from "yjs"; globalThis.__wb_yjs = Y` in its
      // entry, BEFORE @work.books/runtime evaluates.
      //
      // Why no dynamic-import fallback (cf. loroSidecar): yjs isn't
      // a vendor/workbooks dep, so Rollup can't statically resolve
      // `await import("yjs")` from this module — it errors at build
      // time even with `/* @vite-ignore */`. We rely entirely on the
      // host registering the module on globalThis.
      type GlobalYjsHost = { __wb_yjs?: YjsModule };
      const g = (typeof globalThis !== "undefined"
        ? (globalThis as typeof globalThis & GlobalYjsHost)
        : null);
      if (g && g.__wb_yjs) return g.__wb_yjs;

      throw new Error(
        "wb-doc format=\"yjs\" requires yjs. In a single-file workbook, " +
        "import yjs in your main.js and expose it as " +
        "`globalThis.__wb_yjs = await import('yjs')` BEFORE " +
        "calling mountHtmlWorkbook.",
      );
    })();
  }
  return yjsPromise;
}

export interface YjsDispatcher {
  load(opts: {
    id: string;
    bytes: Uint8Array;
    force?: boolean;
  }): Promise<LoroDocHandle>;
  get(id: string): LoroDocHandle | undefined;
  dispose(): void;
}

export function createYjsDispatcher(): YjsDispatcher {
  const handles = new Map<string, LoroDocHandle>();

  function wrapHandle(doc: YDoc, Y: YjsModule): LoroDocHandle {
    return {
      toJSON: () => doc.toJSON(),
      exportSnapshot: () => Y.encodeStateAsUpdateV2(doc),
      mutate(_ops: DocOp[]) {
        // The structured DocOp API is Loro-shaped (LoroPath / map_set
        // / list_push / text_insert at typed paths). It doesn't map
        // 1:1 onto Yjs without a parallel walker. The wb.* storage
        // SDK doesn't use this — it goes straight to handle.inner()
        // and uses Yjs APIs. If a future workbook needs structured
        // mutation against yjs docs, port walkPath/applyOp from
        // loroSidecar.ts onto Y.Map/Y.Array/Y.Text.
        throw new Error(
          "yjs handle.mutate(ops) not implemented — use handle.inner() " +
          "with the Yjs API directly, or call docMutate against a loro doc.",
        );
      },
      // Cast through unknown — LoroDocHandle.inner declares LoroDoc,
      // but at runtime the storage SDK duck-types this as "the raw
      // Y.Doc". Yjs and Loro share no inheritance; the wider runtime
      // contract is "inner() returns the engine's native doc type".
      inner: () => doc as unknown as ReturnType<LoroDocHandle["inner"]>,
    };
  }

  return {
    async load({ id, bytes, force }) {
      const existing = handles.get(id);
      if (existing && !force) return existing;
      const Y = await loadYjs();
      const doc = new Y.Doc();
      // Empty bytes = fresh doc. Yjs's applyUpdate{,V2} handles
      // zero-length updates as no-ops, but we skip the call to
      // mirror loroSidecar's behavior + dodge any binding quirks.
      if (bytes && bytes.length > 0) {
        // V2 is the canonical encoding for new snapshots; fall back
        // to V1 if the bytes look like a v1 update (legacy snapshots
        // exported via encodeStateAsUpdate). Yjs's V2 decoder rejects
        // V1 input cleanly, so the catch is the right place to retry.
        try {
          Y.applyUpdateV2(doc, bytes);
        } catch {
          Y.applyUpdate(doc, bytes);
        }
      }
      const handle = wrapHandle(doc, Y);
      handles.set(id, handle);
      return handle;
    },
    get(id) {
      return handles.get(id);
    },
    dispose() {
      handles.clear();
    },
  };
}
