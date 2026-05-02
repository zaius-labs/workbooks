/**
 * Page-side defense-in-depth for secret values that briefly transit
 * through browser memory.
 *
 * In the workbooks model, the daemon is the source of truth for
 * secret VALUES — the page only ever holds capability handles
 * (secret ids). But there's a narrow window where the page does
 * hold the value: when the user pastes a key into the Integrations
 * modal, between input → POST /secret/set → server ack. During
 * that window the value sits in component state and could leak via:
 *
 *   1. console.log of a debug helper — direct logging
 *   2. an uncaught Error whose message includes the value
 *   3. a plugin that intercepts the modal's $state
 *   4. a runaway fetch to a third-party origin with the value in
 *      the URL or a header
 *
 * Mitigations (varlock-inspired but adapted for our model):
 *   - registerSecretValue / unregisterSecretValue track strings
 *     known to be secrets. wb.secret.set hooks both around the
 *     daemon round-trip.
 *   - patchConsole rewraps console.{log,info,warn,error,debug,
 *     trace,dir} to run every argument (string OR object) through
 *     a maximal-munch regex of registered values; matches become
 *     "[REDACTED]".
 *   - patchFetch wraps the global fetch and refuses cross-origin
 *     requests whose URL or headers contain a registered value.
 *     Same-origin (the daemon's own /wb/<token>/* surface) passes
 *     unchanged. Body inspection is intentionally NOT done — many
 *     body shapes (FormData, ReadableStream, Blob) can't be cheaply
 *     read without consuming them; CSP's connect-src 'self' covers
 *     the body case at the browser layer.
 *
 * `installLeakDefenses()` is idempotent. Call once at app start
 * (post-bootstrap, before any user code runs).
 */

const REGISTERED = new Set<string>();
let _installed = false;

/** Track a string as a secret. Maintains a set; the regex is
 *  rebuilt lazily on each scrub. Strings shorter than 8 chars are
 *  ignored — too short to identify reliably and high false-match
 *  rate. */
export function registerSecretValue(value: string): void {
  if (typeof value !== "string") return;
  if (value.length < 8) return;
  REGISTERED.add(value);
}

/** Stop tracking a string. Call after the value has been delivered
 *  to the daemon and the local copy is no longer needed. */
export function unregisterSecretValue(value: string): void {
  REGISTERED.delete(value);
}

/** Build a fresh maximal-munch regex from the current registry.
 *  Sorting longest-first prevents a short prefix from shadowing a
 *  longer match (varlock's pattern). Re-built on every scrub —
 *  cheap for the typical 1-3 active secrets case, not worth caching. */
function buildScrubRegex(): RegExp | null {
  if (REGISTERED.size === 0) return null;
  const sorted = [...REGISTERED].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join("|"), "g");
}

const REDACTED = "[wb-redacted]";

/** Scrub a string. Returns the original ref if no match. */
function scrubString(s: string): string {
  const re = buildScrubRegex();
  if (!re) return s;
  return s.replace(re, REDACTED);
}

/** Scrub a console arg. Strings are direct; objects round-trip
 *  through JSON to scrub nested string values. Anything that
 *  doesn't JSON-encode (functions, symbols, circular refs) passes
 *  through unchanged — the registered-value match was the trigger,
 *  not the type, and we'd rather log the original than crash. */
function scrubArg(a: unknown): unknown {
  if (typeof a === "string") return scrubString(a);
  if (typeof a === "object" && a !== null) {
    try {
      const json = JSON.stringify(a);
      const scrubbed = scrubString(json);
      if (scrubbed !== json) return JSON.parse(scrubbed);
    } catch {
      // Non-serializable; fall through.
    }
  }
  return a;
}

/** Patch console methods. Saves originals so unhooking is possible
 *  in tests; we don't expose an unhook API today since unhooking
 *  the leak defense in production would be a vulnerability. */
const ORIGINAL_CONSOLE: Partial<Record<string, (...args: unknown[]) => void>> = {};

function patchConsole(): void {
  if (typeof console === "undefined") return;
  for (const method of ["log", "info", "warn", "error", "debug", "trace", "dir"] as const) {
    const orig = console[method] as ((...args: unknown[]) => void) | undefined;
    if (typeof orig !== "function") continue;
    ORIGINAL_CONSOLE[method] = orig.bind(console);
    (console as Record<string, unknown>)[method] = (...args: unknown[]) => {
      ORIGINAL_CONSOLE[method]!(...args.map(scrubArg));
    };
  }
}

/** Patch global error handlers. window.onerror's message arg can
 *  carry the value when an exception's `message` includes it. */
function patchErrorHandlers(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (ev) => {
    if (typeof ev.message === "string") {
      const scrubbed = scrubString(ev.message);
      if (scrubbed !== ev.message) {
        // Best-effort: re-throw replaced message to console with the
        // scrub applied. Can't mutate the ErrorEvent itself in most
        // browsers; the listener is informational.
        ORIGINAL_CONSOLE.error?.(`[wb] scrubbed error: ${scrubbed}`);
        ev.preventDefault();
      }
    }
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const reason = ev.reason;
    if (typeof reason === "string") {
      const scrubbed = scrubString(reason);
      if (scrubbed !== reason) {
        ORIGINAL_CONSOLE.error?.(`[wb] scrubbed rejection: ${scrubbed}`);
        ev.preventDefault();
      }
    } else if (reason instanceof Error && typeof reason.message === "string") {
      const scrubbed = scrubString(reason.message);
      if (scrubbed !== reason.message) {
        reason.message = scrubbed;
      }
    }
  });
}

/** Patch global fetch to refuse cross-origin requests whose URL or
 *  named headers contain a registered secret value. The check is
 *  best-effort — body bytes aren't scanned to avoid consuming
 *  ReadableStreams. CSP `connect-src 'self'` covers the body case
 *  at the browser layer; this JS-level check is for clearer error
 *  messages and resilience if CSP is somehow weakened. */
function patchFetch(allowedOrigin: string): void {
  if (typeof globalThis.fetch !== "function") return;
  const orig = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr =
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
    let parsed: URL | null = null;
    try {
      parsed = new URL(urlStr, allowedOrigin);
    } catch {
      // Malformed URL — pass through to fetch's own error path.
    }
    if (parsed && parsed.origin !== allowedOrigin) {
      // Cross-origin. Scan URL + headers for registered secrets;
      // refuse on any hit.
      if (urlContainsSecret(urlStr)) {
        throw new Error(
          `workbooks: blocked cross-origin fetch to ${parsed.origin} ` +
          `because the URL contains a registered secret value. ` +
          `Use wb.fetch / wb-fetch to route through the daemon's secrets-aware proxy.`,
        );
      }
      const hdrs = headerEntries(init?.headers);
      for (const [_, v] of hdrs) {
        if (typeof v === "string" && stringContainsSecret(v)) {
          throw new Error(
            `workbooks: blocked cross-origin fetch to ${parsed.origin} ` +
            `because a request header contains a registered secret value. ` +
            `Use wb.fetch / wb-fetch.`,
          );
        }
      }
    }
    return orig(input, init);
  }) as typeof fetch;
}

function urlContainsSecret(url: string): boolean {
  return stringContainsSecret(url);
}

function stringContainsSecret(s: string): boolean {
  const re = buildScrubRegex();
  return !!re && re.test(s);
}

function headerEntries(h: HeadersInit | undefined): Array<[string, string]> {
  if (!h) return [];
  if (h instanceof Headers) {
    const out: Array<[string, string]> = [];
    h.forEach((v, k) => out.push([k, v]));
    return out;
  }
  if (Array.isArray(h)) return h.map(([k, v]) => [k, String(v)]);
  return Object.entries(h).map(([k, v]) => [k, String(v)]);
}

/** Install console + error + fetch defenses. Idempotent. */
export function installLeakDefenses(opts?: { allowedOrigin?: string }): void {
  if (_installed) return;
  _installed = true;
  patchConsole();
  patchErrorHandlers();
  const allowedOrigin =
    opts?.allowedOrigin ??
    (typeof location !== "undefined" ? location.origin : "");
  if (allowedOrigin) patchFetch(allowedOrigin);
}

/** Test hook — reset registry. Production code never calls this. */
export function __resetForTests(): void {
  REGISTERED.clear();
  _installed = false;
}
