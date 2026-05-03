/**
 * `wb.app()` — the persistent app-state primitive for Svelte 5 workbooks.
 *
 *   <script>
 *     const app = wb.app({
 *       count:    0,
 *       theme:    "dark",
 *       todos:    [] as Todo[],
 *       layout:   { chatWidth: 500 },
 *     });
 *   </script>
 *
 *   <button onclick={() => app.count++}>{app.count}</button>
 *   <input bind:value={app.theme} />
 *   {#each app.todos as todo}<li>{todo.text}</li>{/each}
 *
 * Backed by a single Y.Map under a stable root key. Each top-level
 * field is JSON-encoded into the map. Mutations propagate to Y.Doc
 * → substrate WAL → `.html` file. Reload restores the same
 * state.
 *
 * # Lazy by default
 *
 * The Proxy returned here defers Y.Doc binding to the first read or
 * write, so it's safe to call wb.app() at module load (e.g. in a
 * singleton like `export const layout = new LayoutStore()`) even when
 * the bundler flattens dynamic imports and the runtime mount hasn't
 * finished. By the time any component renders, the doc is bound.
 *
 * # Tradeoff vs SyncedStore
 *
 * Earlier drafts used SyncedStore for fine-grained nested CRDT (so a
 * concurrent edit to `app.todos[3].text` from two tabs would merge
 * cleanly per-character). SyncedStore disallows primitives at the
 * doc root and disallows seeded values in the root initializer,
 * which makes "just give me persistent app state from a plain object"
 * impossible without significant API contortion.
 *
 * This implementation trades that fine-grained nested merge for an
 * API that just works on plain JS shapes. Each top-level field is
 * JSON-encoded as a single Y.Map value:
 *
 *   - **primitives** (number, string, bool, null) → fully fine; LWW
 *     per field at the root level
 *   - **arrays / objects** → JSON-encoded; whole-value LWW per field
 *
 * For arrays of records that need per-element CRDT merge (e.g.
 * concurrent pushes from peers), pair `wb.app` with `wb.list<T>(id)`
 * for that one collection. For long strings with concurrent edits,
 * pair with `wb.text(id)`. Everything else is happy as a JSON value.
 */

import { resolveDocSync } from "../storage/bootstrap";
import { Y } from "@syncedstore/core";
import { stringify as devalueStringify, parse as devalueParse } from "devalue";
import { encode as toonEncode, decode as toonDecode } from "@toon-format/toon";

export interface AppOptions {
  /** Doc id this app belongs to. Defaults to the first registered doc. */
  doc?: string;
  /** Override the root Y.Map key (default `__wb_app`). Useful if you
   *  want multiple independent wb.app() roots in one workbook. */
  rootKey?: string;
  /** Current schema version your app's wb.app shape is at. Combined
   *  with `migrations`, lets the SDK upgrade legacy state on hydrate.
   *  Defaults to 1; bump every time you make a non-backwards-
   *  compatible change to the shape passed in. */
  schemaVersion?: number;
  /**
   * Migrations registry: `{ [fromVersion]: (map, ctx) => void }`.
   * Each migration receives the live root Y.Map and is expected to
   * mutate it from `fromVersion` to `fromVersion + 1`. The SDK walks
   * the chain from the stored version up to `schemaVersion`,
   * stopping if a step is missing (and warns). Run inside one
   * `doc.transact` so failures roll back atomically.
   *
   * Example:
   *   wb.app({...}, {
   *     schemaVersion: 2,
   *     migrations: {
   *       1: (m) => {
   *         // v1 → v2: rename `chatWidth` → `panelWidth`
   *         if (m.has("chatWidth")) {
   *           m.set("panelWidth", m.get("chatWidth"));
   *           m.delete("chatWidth");
   *         }
   *       },
   *     },
   *   });
   */
  migrations?: Record<number, (map: Y.Map<unknown>, ctx: MigrationContext) => void>;
  /**
   * Per-value codec. Picks how each top-level field is encoded into
   * its Y.Map slot.
   *
   *   - "devalue" (default) — handles Date, Map, Set, RegExp, BigInt,
   *     undefined, NaN/Infinity. Output is a JSON-shaped string. Best
   *     correctness; ~10-20% larger than raw JSON for typical objects.
   *   - "json" — raw JSON.stringify. Smallest output for plain
   *     objects; silently corrupts Date/Map/Set/etc.
   *   - "toon" — Token-Oriented Object Notation. ~30-50% smaller
   *     than JSON for arrays-of-records shapes. JSON-clean types only.
   *
   * The reader path falls through across codecs (configured first,
   * then devalue, then JSON, then raw string), so legacy values keep
   * reading even if the codec option flipped.
   */
  codec?: "devalue" | "json" | "toon";
}

/** Context passed to each migration. Exposed so migrations can read
 *  the doc itself (cross-Y.Map migrations) or the from/to version
 *  pair for logging. */
export interface MigrationContext {
  doc: Y.Doc;
  fromVersion: number;
  toVersion: number;
}

/**
 * Stable wire-format key. Renaming would invalidate every saved
 * workbook's wb.app state. Locked in v0.
 */
const DEFAULT_ROOT_KEY = "__wb_app";

/**
 * Reserved key inside the root Y.Map carrying the schema version.
 * Stored as a Number so legacy maps (no version) read undefined → 0.
 * 0 is the implicit "pre-versioning" baseline; new wb.app() roots
 * land at `schemaVersion` (default 1) on first seed.
 */
const SCHEMA_VERSION_KEY = "__wb_schema_v";

export function app<T extends Record<string, any>>(
  shape: T,
  opts: AppOptions = {},
): T {
  let map: Y.Map<unknown> | null = null;
  let doc: Y.Doc | null = null;
  let reactor: Reactor | null = null;
  const rootKey = opts.rootKey ?? DEFAULT_ROOT_KEY;
  const targetVersion = opts.schemaVersion ?? 1;
  const migrations = opts.migrations ?? {};
  const codec = opts.codec ?? "devalue";

  /** Encode one value to a string for a Y.Map slot. */
  const encodeValue = (value: unknown): string => {
    switch (codec) {
      case "json": return JSON.stringify(value);
      case "toon": return toonEncode(value as never);
      default:     return devalueStringify(value);
    }
  };

  /** Decode a Y.Map string back to a JS value. Tries the configured
   *  codec first, then falls through devalue → JSON → raw, so legacy
   *  values written under a different codec keep reading. */
  const decodeValue = (raw: string): unknown => {
    const tryParse = (fn: (s: string) => unknown): { ok: true; v: unknown } | { ok: false } => {
      try { return { ok: true, v: fn(raw) }; } catch { return { ok: false }; }
    };
    if (codec === "toon") {
      const r = tryParse(toonDecode as (s: string) => unknown);
      if (r.ok) return r.v;
    } else if (codec === "json") {
      const r = tryParse(JSON.parse);
      if (r.ok) return r.v;
    }
    // devalue is the universal fallback because v0 wb.app data was
    // JSON.stringify'd and devalue happily parses raw JSON too.
    const dv = tryParse(devalueParse);
    if (dv.ok) return dv.v;
    const j = tryParse(JSON.parse);
    if (j.ok) return j.v;
    return raw;
  };

  const ensure = () => {
    if (map) return;
    doc = resolveDocSync(opts.doc ?? null);
    if (!doc) {
      throw new Error(
        "wb.app() accessed before the workbook Y.Doc was bound. " +
        "Either wrap your component tree in <WorkbookReady>, or make " +
        "sure mountHtmlWorkbook(...) has run before any read/write.",
      );
    }
    map = doc.getMap(rootKey);

    // 1. Run migrations to bring stored state up to targetVersion.
    //    Walk from `currentVersion` to `targetVersion` one step at a
    //    time. Missing migration steps stop the walk and warn — saved
    //    state stays at the older version (read paths cope, but the
    //    host should add the missing migration). Wrapped in transact
    //    so a partial walk rolls back atomically — substrate gets one
    //    upgrade op, not N intermediates.
    doc.transact(() => {
      const stored = map!.get(SCHEMA_VERSION_KEY);
      let currentVersion = typeof stored === "number" ? stored : 0;
      while (currentVersion < targetVersion) {
        const step = migrations[currentVersion];
        if (!step) {
          if (currentVersion > 0) {
            console.warn(
              `wb.app(${rootKey}): no migration for v${currentVersion} → ` +
              `v${currentVersion + 1}; state stays at v${currentVersion}. ` +
              `Add opts.migrations[${currentVersion}] to upgrade.`,
            );
          }
          break;
        }
        try {
          step(map!, { doc: doc!, fromVersion: currentVersion, toVersion: currentVersion + 1 });
        } catch (e) {
          console.error(
            `wb.app(${rootKey}): migration v${currentVersion} → ` +
            `v${currentVersion + 1} threw; aborting upgrade.`, e,
          );
          break;
        }
        currentVersion += 1;
        map!.set(SCHEMA_VERSION_KEY, currentVersion);
      }
    });

    // 2. Seed defaults — only on keys that don't already exist
    //    (existing user state always wins). Wrapped in transact so
    //    the seed lands as one substrate op rather than N. Also
    //    stamp the schema version on first seed so future reloads
    //    skip the migration walk's "no version" warning.
    doc.transact(() => {
      if (!map!.has(SCHEMA_VERSION_KEY)) {
        map!.set(SCHEMA_VERSION_KEY, targetVersion);
      }
      for (const [key, value] of Object.entries(shape)) {
        if (!map!.has(key) && value !== undefined) {
          map!.set(key, encodeValue(value));
        }
      }
    });

    reactor = new Reactor();
    map.observe(() => reactor!.bump());
  };

  /** Decode a Y.Map value to its JS form via the configured codec
   *  (with cross-codec fallback for legacy values). */
  const read = (key: string): unknown => {
    const raw = map!.get(key);
    if (raw === undefined) return undefined;
    if (typeof raw !== "string") return raw;
    return decodeValue(raw);
  };

  /** Encode + write under one transact so observers fire once per write. */
  const write = (key: string, value: unknown): void => {
    doc!.transact(() => { map!.set(key, encodeValue(value)); });
  };

  /** Filter out the SDK's internal version-stamp key from any
   *  surface that exposes it to the author (get, ownKeys, has,
   *  descriptors). Authors who use rootKey-collision-prone names
   *  starting with `__wb_` are out of luck — that prefix is
   *  reserved by the SDK. */
  const isInternal = (prop: string): boolean => prop === SCHEMA_VERSION_KEY;

  return new Proxy({} as any, {
    get(_target, prop) {
      ensure();
      reactor!.read(); // register Svelte dependency
      if (typeof prop === "symbol") return undefined;
      if (isInternal(prop)) return undefined;
      return read(prop);
    },
    set(_target, prop, value) {
      ensure();
      if (typeof prop === "symbol") return false;
      if (isInternal(prop)) return false; // protect the version stamp
      write(prop, value);
      return true;
    },
    has(_target, prop) {
      ensure();
      if (typeof prop === "symbol") return false;
      if (isInternal(prop)) return false;
      return map!.has(prop);
    },
    deleteProperty(_target, prop) {
      ensure();
      if (typeof prop === "symbol") return false;
      if (isInternal(prop)) return false;
      doc!.transact(() => { map!.delete(prop); });
      return true;
    },
    ownKeys(_target) {
      ensure();
      reactor!.read();
      return [...map!.keys()].filter((k) => !isInternal(k));
    },
    getOwnPropertyDescriptor(_target, prop) {
      ensure();
      if (typeof prop === "symbol" || !map!.has(prop) || isInternal(prop)) return undefined;
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: read(prop),
      };
    },
  }) as T;
}

/**
 * Tiny class wrapping a single $state.raw counter. Class form is
 * required because $state.raw can only appear in class fields,
 * <script> blocks, or .svelte.{js,ts} files (this file qualifies).
 */
class Reactor {
  #version = $state.raw(0);

  read(): void {
    void this.#version;
  }

  bump(): void {
    this.#version++;
  }
}

/** Direct access to the underlying Y.Doc — useful for hooking
 *  Y.UndoManager outside the SDK's `undo()` helper, or for
 *  encoding state for an export. */
export function docOf<T>(_app: T, opts: AppOptions = {}): Y.Doc | null {
  return resolveDocSync(opts.doc ?? null);
}
