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
  get(key: string): unknown;
}
interface LoroList {
  push(value: unknown): void;
  insert(index: number, value: unknown): void;
  delete(index: number, count: number): void;
  get(index: number): unknown;
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
 * One step in a path through nested containers. Each step navigates
 * Map.get(key) or List.get(index); the value at each step must be
 * another container (Map / List / Text) for the walk to continue.
 */
export type LoroPathStep =
  | { kind: "map"; key: string }
  | { kind: "list"; index: number };

/**
 * Path from doc root to a target container. `root` declares the
 * top-level container's kind + name (Loro's API requires this
 * up-front via getMap / getList / getText). `steps` descend through
 * nested containers; an empty / omitted `steps` means the root is
 * itself the target.
 *
 * Examples:
 *   { root: { kind: "map", name: "agentState" } }
 *     → top-level Map "agentState"
 *
 *   { root: { kind: "map", name: "agentState" },
 *     steps: [{ kind: "map", key: "users" }, { kind: "list", index: 3 }] }
 *     → agentState.users[3]
 */
export interface LoroPath {
  root: { kind: "map" | "list" | "text"; name: string };
  steps?: LoroPathStep[];
}

/**
 * Structured op patch for container mutations. Cells + agent tools
 * emit these via the host's docMutate API; the sidecar walks the
 * path, applies the op on the target container, and commits a
 * single op-log entry per call.
 *
 * Each op's kind asserts the FINAL container's type — `map_set`
 * requires the path to resolve to a Map, `list_push` to a List,
 * etc. Mismatch surfaces as a runtime error from Loro.
 */
export type DocOp =
  | { kind: "map_set"; target: LoroPath; key: string; value: unknown }
  | { kind: "map_delete"; target: LoroPath; key: string }
  | { kind: "list_push"; target: LoroPath; value: unknown }
  | { kind: "list_insert"; target: LoroPath; index: number; value: unknown }
  | { kind: "list_delete"; target: LoroPath; index: number; count: number }
  | { kind: "text_insert"; target: LoroPath; index: number; text: string }
  | { kind: "text_delete"; target: LoroPath; index: number; count: number };

/**
 * Convenience constructor for the common case: a top-level container
 * with no nested descent. `topLevel("map", "agentState")` is shorthand
 * for `{ root: { kind: "map", name: "agentState" } }`.
 */
export function topLevel(
  kind: "map" | "list" | "text",
  name: string,
): LoroPath {
  return { root: { kind, name } };
}

let loroPromise: Promise<LoroModule> | null = null;

async function loadLoro(): Promise<LoroModule> {
  if (!loroPromise) {
    loroPromise = (async () => {
      // Two-step lookup:
      //
      //   1. window.__wb_loro — host-provided. The user's app does
      //      `import * as loro from "loro-crdt"; window.__wb_loro = loro`
      //      in its entry. Vite bundles loro into the user's main.js,
      //      and we read it back on the global. Required when the
      //      runtime bundle is loaded as a Blob URL (which can't
      //      resolve bare-specifier imports).
      //
      //   2. dynamic import — fallback for hosts that load the runtime
      //      through their own module graph (e.g. tests, dev-server
      //      with Vite serving). Vite resolves "loro-crdt" via the
      //      host's node_modules.
      //
      // Workbooks that ship a wb-doc element MUST take path 1 — the
      // single-file inlined runtime can't reach into the user's
      // bundle without the global.
      type GlobalLoroHost = { __wb_loro?: LoroModule };
      const w = (typeof window !== "undefined"
        ? (window as Window & GlobalLoroHost)
        : null);
      if (w && w.__wb_loro) return w.__wb_loro;

      try {
        const mod = (await import(/* @vite-ignore */ "loro-crdt")) as unknown as LoroModule;
        return mod;
      } catch {
        throw new Error(
          "wb-doc cells require loro-crdt. In a single-file workbook, " +
          "import it in your main.js and expose it as " +
          "`window.__wb_loro = await import('loro-crdt')` before " +
          "calling mountHtmlWorkbook.",
        );
      }
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

  /** Walk a LoroPath from doc root to the target container. Each step
   *  must yield a container — a primitive value mid-path errors. */
  function walkPath(doc: LoroDoc, path: LoroPath): unknown {
    let cur: unknown;
    if (path.root.kind === "map") cur = doc.getMap(path.root.name);
    else if (path.root.kind === "list") cur = doc.getList(path.root.name);
    else cur = doc.getText(path.root.name);

    const steps = path.steps ?? [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      // Loro returns container handles for nested containers; primitives
      // come back as plain JS values. Either is an `unknown` from our
      // perspective; we duck-type by calling .get next iteration.
      if (step.kind === "map") {
        const m = cur as LoroMap;
        if (typeof m.get !== "function") {
          throw new Error(
            `docMutate: path step ${i} expected Map, got non-Map value`,
          );
        }
        cur = m.get(step.key);
      } else {
        const l = cur as LoroList;
        if (typeof l.get !== "function") {
          throw new Error(
            `docMutate: path step ${i} expected List, got non-List value`,
          );
        }
        cur = l.get(step.index);
      }
      if (cur === null || typeof cur !== "object") {
        throw new Error(
          `docMutate: path step ${i} yielded a primitive — can't descend further`,
        );
      }
    }
    return cur;
  }

  function applyOp(doc: LoroDoc, op: DocOp): void {
    const target = walkPath(doc, op.target);
    switch (op.kind) {
      case "map_set":
        (target as LoroMap).set(op.key, op.value);
        return;
      case "map_delete":
        (target as LoroMap).delete(op.key);
        return;
      case "list_push":
        (target as LoroList).push(op.value);
        return;
      case "list_insert":
        (target as LoroList).insert(op.index, op.value);
        return;
      case "list_delete":
        (target as LoroList).delete(op.index, op.count);
        return;
      case "text_insert":
        (target as LoroText).insert(op.index, op.text);
        return;
      case "text_delete":
        (target as LoroText).delete(op.index, op.count);
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
      // Empty bytes = fresh doc (kind: "empty" in the parser). Skip
      // the import call — Loro rejects zero-length input.
      if (bytes && bytes.length > 0) {
        doc.import(bytes);
      }
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
