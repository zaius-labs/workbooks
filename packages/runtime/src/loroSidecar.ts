/**
 * Loro CRDT sidecar — lazy-loaded around `loro-crdt` (Rust+WASM).
 *
 * `<wb-doc format="loro">` blocks resolve through this dispatcher:
 * decoded base64 bytes → `LoroDoc.import()` → JSON projection
 * available to cells via `reads=`. First ship is read-only;
 * mutation API (mirror of appendMemory's host-driven shape) lands
 * in a follow-up.
 *
 * Why lazy-load: Loro's WASM binary is ~3 MB, 6× the SQLite baseline.
 * Workbooks that don't use <wb-doc> never pay the cost. Same pattern
 * as @sqlite.org/sqlite-wasm — declared as an optional peer dep, the
 * dispatcher surfaces a clear error if the package is missing.
 */

/** Subset of the loro-crdt JS API we depend on. Each container type
 *  has its own signatures — Map keys by string, List/Text by index. */
interface LoroMap {
  set(key: string, value: unknown): void;
  delete(key: string): void;
}
interface LoroList {
  push(value: unknown): void;
  insert(index: number, value: unknown): void;
  delete(index: number, count: number): void;
}
interface LoroText {
  insert(index: number, text: string): void;
  delete(index: number, count: number): void;
}
interface LoroDoc {
  import(bytes: Uint8Array): void;
  toJSON(): unknown;
  getMap(name: string): LoroMap;
  getList(name: string): LoroList;
  getText(name: string): LoroText;
  /** Commit accumulated changes as a single op-log entry. */
  commit(): void;
  /** Export the current state as bytes for re-saving. */
  export(mode: { mode: "snapshot" } | { mode: "shallow-snapshot"; frontiers: unknown } | { mode: "updates"; from: unknown }): Uint8Array;
}
interface LoroModule {
  LoroDoc: new () => LoroDoc;
}

/**
 * Structured op patch for top-level container mutations. Cells +
 * agent tools emit these via the host's docMutate API; the sidecar
 * applies them and commits a single op-log entry per call.
 *
 * Scoped to top-level containers in this ship — nested-path
 * mutations (e.g. `getMap("a").get("b").set(...)`) require a path
 * walker that lands later. Most agent-scratchpad use cases fit:
 * a top-level Map for keyed state, a top-level List for an event
 * trail, a top-level Text for a streamed transcript.
 */
export type DocOp =
  | { kind: "map_set"; container: string; key: string; value: unknown }
  | { kind: "map_delete"; container: string; key: string }
  | { kind: "list_push"; container: string; value: unknown }
  | { kind: "list_insert"; container: string; index: number; value: unknown }
  | { kind: "list_delete"; container: string; index: number; count: number }
  | { kind: "text_insert"; container: string; index: number; text: string }
  | { kind: "text_delete"; container: string; index: number; count: number };

let loroPromise: Promise<LoroModule> | null = null;

async function loadLoro(): Promise<LoroModule> {
  if (!loroPromise) {
    loroPromise = (async () => {
      // Dynamic import via variable specifier so TS doesn't try to
      // resolve the optional peer dep at compile time.
      const specifier = "loro-crdt";
      let mod: LoroModule;
      try {
        mod = (await import(/* @vite-ignore */ specifier)) as unknown as LoroModule;
      } catch {
        throw new Error(
          "wb-doc cells require loro-crdt — install it as a peer dep " +
            "or pre-bundle it with your workbook host",
        );
      }
      return mod;
    })();
  }
  return loroPromise;
}

export interface LoroDocHandle {
  /** Current state as a plain JS value (for cell consumption). */
  toJSON(): unknown;
  /** Export current state as Loro snapshot bytes for re-saving. */
  exportSnapshot(): Uint8Array;
  /**
   * Apply one or more structured ops as a single op-log entry.
   * Returns the new snapshot bytes after commit so the host can
   * re-encode and persist.
   */
  mutate(ops: DocOp[]): Uint8Array;
  /** Internal handle — exposed for advanced host integrations. */
  inner(): LoroDoc;
}

export interface LoroDispatcher {
  /**
   * Load a doc from snapshot bytes. Same id loaded twice (e.g. across
   * remounts) returns the cached handle unless `force` is set.
   */
  load(opts: {
    id: string;
    bytes: Uint8Array;
    force?: boolean;
  }): Promise<LoroDocHandle>;
  /** Get an already-loaded handle by id. */
  get(id: string): LoroDocHandle | undefined;
  /** Drop every cached handle. Call on unmount. */
  dispose(): void;
}

export function createLoroDispatcher(): LoroDispatcher {
  const handles = new Map<string, LoroDocHandle>();

  function applyOp(doc: LoroDoc, op: DocOp): void {
    switch (op.kind) {
      case "map_set":
        doc.getMap(op.container).set(op.key, op.value);
        return;
      case "map_delete":
        doc.getMap(op.container).delete(op.key);
        return;
      case "list_push":
        doc.getList(op.container).push(op.value);
        return;
      case "list_insert":
        doc.getList(op.container).insert(op.index, op.value);
        return;
      case "list_delete":
        doc.getList(op.container).delete(op.index, op.count);
        return;
      case "text_insert":
        doc.getText(op.container).insert(op.index, op.text);
        return;
      case "text_delete":
        doc.getText(op.container).delete(op.index, op.count);
        return;
    }
  }

  function wrapHandle(doc: LoroDoc): LoroDocHandle {
    return {
      toJSON: () => doc.toJSON(),
      exportSnapshot: () => doc.export({ mode: "snapshot" }),
      mutate(ops) {
        for (const op of ops) applyOp(doc, op);
        doc.commit();
        return doc.export({ mode: "snapshot" });
      },
      inner: () => doc,
    };
  }

  return {
    async load({ id, bytes, force }) {
      const existing = handles.get(id);
      if (existing && !force) return existing;
      const loro = await loadLoro();
      const doc = new loro.LoroDoc();
      doc.import(bytes);
      const handle = wrapHandle(doc);
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
