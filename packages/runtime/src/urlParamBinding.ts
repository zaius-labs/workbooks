/**
 * URL parameter binding (P3.6).
 *
 * Workbooks expose their inputs as `?name=value` query parameters so a
 * URL captures the workbook's full input state. Sharing a URL = sharing
 * a fully-parameterized snapshot. Loading the page rehydrates inputs
 * from the URL before the executor runs the first pass.
 *
 * Contract:
 *   - Each input block declares a `name`. That name is the URL param key.
 *   - On page load, every input named in the URL gets its initial value
 *     parsed and pushed into the executor.
 *   - When `setInput(name, value)` runs, the URL is replaced (not pushed)
 *     so back/forward history isn't polluted on every keystroke.
 *   - Type coercion: numbers parse via Number(), booleans via "true"/"false",
 *     everything else stays as string. Workbooks needing typed JSON values
 *     should base64-encode them (out of scope for v1).
 *
 * Status: P3.6 baseline. Types covered: string | number | boolean. Object/
 * array values defer to a future "?json=" escape hatch.
 */

import type { ReactiveExecutor } from "./reactiveExecutor";

export type UrlParamValue = string | number | boolean;

export interface UrlParamSpec {
  name: string;
  type: "string" | "number" | "boolean";
  /** Used when the URL doesn't carry the param. */
  default?: UrlParamValue;
}

export interface UrlBinding {
  /** Initial values pulled from the URL (or defaults), keyed by name. */
  initialInputs: Record<string, UrlParamValue>;
  /** Set + persist a value: pushes into the executor + replaceState the URL. */
  setInput: (name: string, value: UrlParamValue) => void;
  /** Tear down the popstate listener. */
  destroy: () => void;
}

/**
 * Bidirectionally bind a `ReactiveExecutor`'s inputs to URL query
 * parameters. Call once at workbook mount; pass the returned
 * `initialInputs` to the executor's `inputs` option, and replace
 * direct `executor.setInput()` calls with `binding.setInput()`.
 */
export function bindExecutorToUrl(
  executor: ReactiveExecutor,
  specs: UrlParamSpec[],
): UrlBinding {
  const initial: Record<string, UrlParamValue> = {};
  const params = readUrlParams();

  for (const spec of specs) {
    const raw = params.get(spec.name);
    if (raw == null) {
      if (spec.default !== undefined) initial[spec.name] = spec.default;
      continue;
    }
    initial[spec.name] = coerce(raw, spec.type);
  }

  const setInput = (name: string, value: UrlParamValue) => {
    writeUrlParam(name, value);
    executor.setInput(name, value);
  };

  // popstate: another browser action (back/forward, bookmarklet, etc.)
  // changed the URL — re-pull values for our specs and propagate.
  const onPopState = () => {
    const next = readUrlParams();
    for (const spec of specs) {
      const raw = next.get(spec.name);
      const value = raw == null
        ? spec.default
        : coerce(raw, spec.type);
      if (value !== undefined) executor.setInput(spec.name, value);
    }
  };
  window.addEventListener("popstate", onPopState);

  return {
    initialInputs: initial,
    setInput,
    destroy: () => window.removeEventListener("popstate", onPopState),
  };
}

// ----------------------------------------------------------------------
// Lower-level helpers (exported for callers that don't use ReactiveExecutor).
// ----------------------------------------------------------------------

export function readUrlParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

export function writeUrlParam(name: string, value: UrlParamValue): void {
  const params = readUrlParams();
  if (value === "" || value == null) {
    params.delete(name);
  } else {
    params.set(name, String(value));
  }
  const search = params.toString();
  const next = window.location.pathname + (search ? "?" + search : "") + window.location.hash;
  window.history.replaceState(window.history.state, "", next);
}

export function coerce(raw: string, type: "string" | "number" | "boolean"): UrlParamValue {
  if (type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  if (type === "boolean") {
    return raw === "true" || raw === "1";
  }
  return raw;
}
