/**
 * Yjs host shim — single source of Y.* for the runtime bundle.
 *
 * The host app (e.g. color.wave's main.js) imports `yjs` once and
 * assigns it to `globalThis.__wb_yjs` before any consumer of these
 * exports actually USES one. The runtime imports Yjs through this
 * file instead of from "yjs" directly, so both sides share ONE
 * module instance.
 *
 * Why: when esbuild bundles `yjs` into the runtime AND Vite bundles
 * `yjs` into the host app, you get two copies. `instanceof Y.Doc`
 * fails across the boundary, and Yjs itself prints
 * "Yjs was already imported. This breaks constructor checks…"
 * (see https://github.com/yjs/yjs/issues/438).
 *
 * The lookup is **lazy** — resolved on first use, not at module
 * init. This is load-bearing: when Vite/Rollup concatenates
 * @work.books/runtime alongside the host app's yjs-host.js into a
 * single bundle, the bundler is free to reorder module-init code,
 * and an eager `if (!globalThis.__wb_yjs) throw` at the top of this
 * file will sometimes fire before the host's assignment runs. By
 * deferring resolution to actual use (every `new Y.Doc()`,
 * `Y.encodeStateAsUpdate(...)` call), we side-step the bundling
 * order question entirely. The host's `import "./yjs-host.js"`
 * still has to run before the runtime *uses* yjs, but the runtime
 * MODULE itself can be evaluated whenever — it just stamps lazy
 * thunks at init time and lets them resolve later.
 *
 * Each export is paired with a type alias of the same name so that
 * `import * as Y from "./yjsHost"` produces a namespace usable in
 * both value and type positions (`new Y.Doc()` and `d: Y.Doc`).
 */

import type * as YjsTypes from "yjs";

/**
 * Resolve `globalThis.__wb_yjs`, throwing only if a real consumer
 * is trying to use Y at the moment of the call. The error message
 * is identical to the legacy eager-check shape so the exact string
 * remains greppable across the codebase.
 */
function resolveY(): typeof YjsTypes {
  const v = (globalThis as unknown as { __wb_yjs?: typeof YjsTypes })
    .__wb_yjs;
  if (!v) {
    throw new Error(
      "workbook runtime: globalThis.__wb_yjs is not set. The host app must " +
        "assign `globalThis.__wb_yjs = await import('yjs')` BEFORE the " +
        "runtime calls into Y. See yjsHost.ts for context.",
    );
  }
  return v;
}

/**
 * Wrap a Yjs class as a Proxy so:
 *   - `new Wrapped(...)` constructs through the resolved Y.<name>
 *   - `Wrapped.staticThing` reads through to the resolved class
 * Lets us export e.g. `Doc` synchronously without touching
 * `globalThis.__wb_yjs` until someone actually uses it.
 */
function lazyClass<K extends keyof typeof YjsTypes>(
  name: K,
): (typeof YjsTypes)[K] {
  return new Proxy(function placeholder() {} as unknown as object, {
    construct(_t, args, newTarget) {
      const Cls = resolveY()[name] as unknown as new (
        ...a: unknown[]
      ) => unknown;
      // Reflect.construct preserves prototype chain when called with
      // `new SubClass(...)` — relevant for Yjs's CustomDoc subclassing.
      return Reflect.construct(Cls, args, newTarget);
    },
    get(_t, prop, receiver) {
      const Cls = resolveY()[name] as unknown as object;
      return Reflect.get(Cls, prop, receiver);
    },
    has(_t, prop) {
      return Reflect.has(resolveY()[name] as unknown as object, prop);
    },
    apply(_t, thisArg, args) {
      const Cls = resolveY()[name] as unknown as (...a: unknown[]) => unknown;
      return Reflect.apply(Cls, thisArg, args);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(resolveY()[name] as unknown as object);
    },
  }) as unknown as (typeof YjsTypes)[K];
}

/**
 * Wrap a Yjs free function (encodeStateAsUpdate, transact, …) as a
 * call-through. Lazy lookup; identity preserved across calls so
 * consumers can `if (fn === otherFn)` if they need to.
 */
function lazyFn<K extends keyof typeof YjsTypes>(
  name: K,
): (typeof YjsTypes)[K] {
  const fn = (...args: unknown[]) => {
    const target = resolveY()[name] as unknown as (
      ...a: unknown[]
    ) => unknown;
    return target(...args);
  };
  return fn as unknown as (typeof YjsTypes)[K];
}

export const Doc = lazyClass("Doc");
export type Doc = YjsTypes.Doc;

export const Map = lazyClass("Map");
export type Map<T> = YjsTypes.Map<T>;

export const Array = lazyClass("Array");
export type Array<T> = YjsTypes.Array<T>;

export const Text = lazyClass("Text");
export type Text = YjsTypes.Text;

export const XmlElement = lazyClass("XmlElement");
export type XmlElement = YjsTypes.XmlElement;

export const XmlFragment = lazyClass("XmlFragment");
export type XmlFragment = YjsTypes.XmlFragment;

export const XmlText = lazyClass("XmlText");
export type XmlText = YjsTypes.XmlText;

export const encodeStateAsUpdate = lazyFn("encodeStateAsUpdate");
export const applyUpdate = lazyFn("applyUpdate");
export const encodeStateVector = lazyFn("encodeStateVector");
export const mergeUpdates = lazyFn("mergeUpdates");
export const diffUpdate = lazyFn("diffUpdate");
export const transact = lazyFn("transact");
