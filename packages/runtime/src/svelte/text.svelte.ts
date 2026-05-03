/**
 * Persisted Svelte 5 text primitive — the durable counterpart to
 * `let body = $state("")` for long-form strings that benefit from
 * per-character CRDT merge semantics.
 *
 *   const composition = text("composition", "<html>...");
 *
 *   composition.value;             // reactive read (string)
 *   composition.value = "<html>";  // diff-shrunk write — non-overlapping
 *                                  // edits in concurrent tabs merge
 *
 * Use this over `state<string>(...)` when:
 *   - the string is long enough that whole-string LWW would be wasteful
 *   - concurrent writers might edit different regions and you want them
 *     to merge instead of clobber
 *
 * For short tokens (titles, IDs, single-line config), `state` is simpler.
 */

import { createText, type WbText, type WbTextOptions } from "../storage/text";

export interface TextOptions {
  doc?: string;
  /** Materialized iff the Y.Text is empty after hydration. */
  initial?: string;
}

export class WbTextState {
  #raw = $state.raw<string>("");
  #wb: WbText;

  constructor(id: string, opts: TextOptions = {}) {
    const wbOpts: WbTextOptions = {};
    if (opts.doc !== undefined) wbOpts.doc = opts.doc;
    if (opts.initial !== undefined) wbOpts.initial = opts.initial;
    this.#wb = createText(id, wbOpts);
    this.#raw = this.#wb.value;
    this.#wb.subscribe((next) => {
      this.#raw = next;
    });
  }

  get value(): string {
    return this.#raw;
  }

  set value(next: string) {
    this.#wb.set(next);
  }

  ready(): Promise<void> {
    return this.#wb.ready();
  }
}

export function text(id: string, initial?: string): WbTextState {
  return new WbTextState(id, initial !== undefined ? { initial } : {});
}
