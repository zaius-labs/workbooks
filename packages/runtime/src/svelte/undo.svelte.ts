/**
 * `wb.undo` — Y.UndoManager exposed as a Svelte-reactive primitive.
 *
 * Y.Doc tracks every mutation as a CRDT op. Y.UndoManager wraps that
 * stream with a typical undo/redo stack: mutations between
 * `stopCapturing` boundaries are grouped into one entry, `.undo()`
 * rolls them back, `.redo()` re-applies, the stack supports both
 * directions.
 *
 * Because Y.UndoManager operates on the same Y.Doc that backs every
 * `wb.app` / `wb.state` / `wb.list` / `wb.text` value, undo works
 * automatically across ALL persistent state in the workbook with no
 * additional plumbing — the durable state graph is the undo history.
 *
 *   import { undo } from "@work.books/runtime/svelte";
 *
 *   <script>
 *     // Inside <WorkbookReady>, so the manager binds synchronously.
 *     const u = undo();
 *     // Optionally bind global keyboard:
 *     u.bindKeyboard();
 *   </script>
 *
 *   <button onclick={() => u.undo()} disabled={!u.canUndo}>Undo</button>
 *   <button onclick={() => u.redo()} disabled={!u.canRedo}>Redo</button>
 *
 * # Tracked scope
 *
 * By default, the manager observes the whole Y.Doc (every Y.Map,
 * Y.Array, Y.Text on it). To narrow:
 *
 *   const u = undo({ scope: ["plugins", "settings"] });
 *
 * `scope` names top-level Y types whose changes contribute to undo.
 * Useful when one part of the doc is "live data" you DON'T want
 * users to undo (e.g., a recording feed) while UI / settings should
 * be undoable.
 */

import { resolveDocSync } from "../storage/bootstrap";
import { Y } from "@syncedstore/core";

export interface UndoOptions {
  /** Doc id (defaults to the first registered). */
  doc?: string;
  /** Top-level Y type names to track. Defaults to "all top-level types". */
  scope?: string[];
  /** Mutations within this many ms group into one undo entry.
   *  Default 500 ms — matches Y.UndoManager's own default. */
  captureTimeout?: number;
}

/**
 * Reactive undo handle. `.canUndo` / `.canRedo` track the stack state
 * and re-run any reading effect / template binding when they change.
 */
export class WbUndo {
  #canUndo = $state.raw(false);
  #canRedo = $state.raw(false);
  #manager: Y.UndoManager;
  #keyboardBound = false;

  constructor(opts: UndoOptions = {}) {
    const doc = resolveDocSync(opts.doc ?? null);
    if (!doc) {
      throw new Error(
        "wb.undo() called outside <WorkbookReady>. Wrap the component " +
        "tree in <WorkbookReady> so the Y.Doc binds first.",
      );
    }

    // Build the tracked-types set. If no scope is specified, we'd
    // ideally wrap everything; UndoManager requires explicit types
    // so we enumerate the doc's top-level shared types.
    const tracked = opts.scope
      ? opts.scope.map((name) => doc.get(name) as Y.AbstractType<unknown>)
      : enumerateTopLevelTypes(doc);

    this.#manager = new Y.UndoManager(tracked as any, {
      captureTimeout: opts.captureTimeout ?? 500,
    });

    // Refresh the reactive flags whenever the stack changes.
    const refresh = () => {
      this.#canUndo = this.#manager.undoStack.length > 0;
      this.#canRedo = this.#manager.redoStack.length > 0;
    };
    this.#manager.on("stack-item-added", refresh);
    this.#manager.on("stack-item-popped", refresh);
    this.#manager.on("stack-cleared", refresh);
    refresh();
  }

  get canUndo(): boolean { return this.#canUndo; }
  get canRedo(): boolean { return this.#canRedo; }

  undo(): void { this.#manager.undo(); }
  redo(): void { this.#manager.redo(); }

  /** Force-end the current capture window so the next mutation starts
   *  a new undo entry. Useful for "commit point" UX where a long
   *  pause in user input should NOT collapse the next edit into the
   *  prior group. */
  stopCapturing(): void { this.#manager.stopCapturing(); }

  /** Wire ⌘Z / ⌘⇧Z (Mac) and Ctrl+Z / Ctrl+Y (others) to undo/redo
   *  on the document. Skips inputs / textareas / contenteditable so
   *  text-field undo still works. Returns the unbinding function. */
  bindKeyboard(): () => void {
    if (this.#keyboardBound) return () => {};
    this.#keyboardBound = true;
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const key = e.key.toLowerCase();
      const isUndo = key === "z" && !e.shiftKey;
      const isRedo = (key === "z" && e.shiftKey) || key === "y";
      if (isUndo) { e.preventDefault(); this.undo(); }
      else if (isRedo) { e.preventDefault(); this.redo(); }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => {
      window.removeEventListener("keydown", handler, { capture: true });
      this.#keyboardBound = false;
    };
  }

  dispose(): void {
    this.#manager.destroy();
  }
}

/** Enumerate every top-level shared type registered on the Y.Doc.
 *  Y.Doc exposes `share` (a Map<string, AbstractType>) but it isn't
 *  in the public types — fall back to introspection. */
function enumerateTopLevelTypes(doc: Y.Doc): Y.AbstractType<unknown>[] {
  const out: Y.AbstractType<unknown>[] = [];
  const share = (doc as unknown as { share?: Map<string, Y.AbstractType<unknown>> }).share;
  if (share) {
    for (const t of share.values()) out.push(t);
  }
  return out;
}

export function undo(opts: UndoOptions = {}): WbUndo {
  return new WbUndo(opts);
}
