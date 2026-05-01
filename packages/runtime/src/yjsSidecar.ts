/**
 * Yjs CRDT sidecar — wraps `yjs` (pure JS, no WASM) for `<wb-doc>`
 * blocks declared with `format="yjs"`.
 *
 * Why Yjs:
 *   - tiny (~50 KB minified) vs the previous Loro WASM (~3 MB),
 *   - first-class y-indexeddb provider (no hand-rolled IDB layer),
 *   - mature broadcast/websocket/webrtc providers if/when sync lands.
 *
 * Update format: bytes coming in are produced by `Y.encodeStateAsUpdate(doc)`;
 * applied via `Y.applyUpdate(doc, bytes)`. Empty bytes = a fresh Y.Doc.
 *
 * NOTE on naming: the public types (`LoroDocHandle`, `LoroPath`,
 * `LoroPathStep`, `LoroDispatcher`, `DocOp`, `topLevel`) keep the
 * `Loro*` prefix as legacy nomenclature from before the Phase-2 swap.
 * Renaming touches every consumer in the runtime + SDK, so we hold
 * the names stable until a wider sweep makes sense.
 */

import * as Y from "yjs";

// ---------------------------------------------------------------------------
// Backend-agnostic doc op + handle types. Used by the resolver, the wasm
// bridge, the SDK, and any host integration that talks docMutate. Lives
// here (next to the only living implementation) since the Loro backend
// was dropped in Phase 2 of core-0or.
// ---------------------------------------------------------------------------

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
 * top-level container's kind + name. `steps` descend through nested
 * containers; an empty / omitted `steps` means the root is itself
 * the target.
 */
export interface LoroPath {
  root: { kind: "map" | "list" | "text"; name: string };
  steps?: LoroPathStep[];
}

/**
 * Structured op patch for container mutations. Cells + agent tools
 * emit these via the host's docMutate API; the active backend (Yjs)
 * walks the path, applies the op on the target container, and
 * commits a single op-log entry per call.
 *
 * Each op's kind asserts the FINAL container's type — `map_set`
 * requires the path to resolve to a Map, `list_push` to a List,
 * etc. Mismatch surfaces as a runtime error.
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

/**
 * Backend-agnostic CRDT doc handle. The Yjs sidecar wraps a Y.Doc
 * with this shape; `inner()` returns the backend's native doc
 * instance (Y.Doc today).
 */
export interface LoroDocHandle {
  /** Current state as a plain JS value (for cell consumption). */
  toJSON(): unknown;
  /** Export current state as backend-specific update bytes for save. */
  exportSnapshot(): Uint8Array;
  /**
   * Apply one or more structured ops as a single op-log entry.
   * Returns the new snapshot bytes after commit so the host can
   * re-encode and persist.
   */
  mutate(ops: DocOp[]): Uint8Array;
  /** Internal handle — exposed for advanced host integrations. */
  inner(): unknown;
}

/**
 * Generic dispatcher contract — the Yjs sidecar implements this. Kept
 * as a named interface so the resolver's options remain extensible if
 * a future backend ships behind a feature flag.
 */
export interface LoroDispatcher {
  load(opts: { id: string; bytes: Uint8Array; force?: boolean }): Promise<LoroDocHandle>;
  get(id: string): LoroDocHandle | undefined;
  dispose(): void;
}

export type YjsDispatcher = LoroDispatcher;

function walkPath(doc: Y.Doc, path: LoroPath): unknown {
  let cur: unknown;
  if (path.root.kind === "map") cur = doc.getMap(path.root.name);
  else if (path.root.kind === "list") cur = doc.getArray(path.root.name);
  else cur = doc.getText(path.root.name);

  const steps = path.steps ?? [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.kind === "map") {
      const m = cur as Y.Map<unknown>;
      cur = m.get(step.key);
    } else {
      const l = cur as Y.Array<unknown>;
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

function applyOp(doc: Y.Doc, op: DocOp): void {
  doc.transact(() => {
    const target = walkPath(doc, op.target);
    switch (op.kind) {
      case "map_set":
        (target as Y.Map<unknown>).set(op.key, op.value);
        return;
      case "map_delete":
        (target as Y.Map<unknown>).delete(op.key);
        return;
      case "list_push":
        (target as Y.Array<unknown>).push([op.value]);
        return;
      case "list_insert":
        (target as Y.Array<unknown>).insert(op.index, [op.value]);
        return;
      case "list_delete":
        (target as Y.Array<unknown>).delete(op.index, op.count);
        return;
      case "text_insert":
        (target as Y.Text).insert(op.index, op.text);
        return;
      case "text_delete":
        (target as Y.Text).delete(op.index, op.count);
        return;
    }
  });
}

function wrapHandle(doc: Y.Doc): LoroDocHandle & { doc: Y.Doc } {
  return {
    toJSON: () => doc.toJSON(),
    exportSnapshot: () => Y.encodeStateAsUpdate(doc),
    mutate(ops) {
      for (const op of ops) applyOp(doc, op);
      return Y.encodeStateAsUpdate(doc);
    },
    inner: () => doc as unknown as never,
    // Surface the Y.Doc directly so the SDK bootstrap can pick it up
    // without going through the legacy `inner()` LoroDoc cast.
    doc,
  };
}

export function createYjsDispatcher(): YjsDispatcher {
  const handles = new Map<string, LoroDocHandle & { doc: Y.Doc }>();

  return {
    async load({ id, bytes, force }) {
      const existing = handles.get(id);
      if (existing && !force) return existing;
      const doc = new Y.Doc();
      if (bytes && bytes.length > 0) {
        Y.applyUpdate(doc, bytes);
      }
      const handle = wrapHandle(doc);
      handles.set(id, handle);
      return handle;
    },
    get(id) {
      return handles.get(id);
    },
    dispose() {
      for (const h of handles.values()) {
        try { h.doc.destroy(); } catch { /* ignore */ }
      }
      handles.clear();
    },
  };
}
