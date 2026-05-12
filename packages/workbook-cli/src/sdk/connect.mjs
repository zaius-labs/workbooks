/**
 * workbook:connect — workbook-side SDK for the broker env-var proxy.
 *
 * Workbooks running on workbooks.sh call `wbFetch(url, { env, ... })`.
 * The SDK posts to `/v1/workbooks/<id>/proxy` on the broker; the
 * broker validates membership, splices the named env var's value
 * into the outbound request, calls the upstream service, and pipes
 * the response back. Plaintext never reaches workbook code.
 *
 * Usage:
 *
 *   import { fetch as wbFetch } from "workbook:connect";
 *
 *   const r = await wbFetch("https://api.openai.com/v1/chat/completions", {
 *     method: "POST",
 *     env: "OPENAI_KEY",
 *     body: JSON.stringify({ model: "gpt-4o-mini", messages: [...] }),
 *     headers: { "content-type": "application/json" },
 *   });
 *   const data = await r.json();
 *
 * The env name must match a `connect: { OPENAI_KEY: { ... } }` entry
 * in workbook.config.mjs AND a group env var the publishing group
 * has registered with matching domains. Otherwise the broker
 * returns 400/404 with a structured error the caller can inspect.
 *
 * Modes:
 *   - Hosted (workbooks.sh): calls go through the broker proxy.
 *   - file:// or external embed: throws WorkbookConnectUnavailable.
 *     The recipient sees the chrome widget's "Open on workbooks.sh"
 *     prompt; workbook code should defer expensive UI until the
 *     fetch succeeds.
 */

// The broker exposes a stable host pair across environments — prod
// and any staging worker run alongside. Detected at runtime by
// inspecting the document's location. Falls back to auth.workbooks.sh
// for any unknown context (e.g. a workbook embedded in run.workbooks.sh
// where the broker host is still the same).
function detectBrokerOrigin() {
  if (typeof location === "undefined") return "https://auth.workbooks.sh";
  // Workbooks.sh proxies /w/* + /_app/* to the viewer; broker is
  // separate at auth.workbooks.sh. Hardcoded — there's only one.
  return "https://auth.workbooks.sh";
}

/** Resolve the workbook id this artifact is being viewed as.
 *
 *  The viewer renders the workbook inside an iframe with srcdoc,
 *  so the workbook's `location` is about:srcdoc and there's no URL
 *  to parse. The viewer page sets `iframe.name = "<workbook-id>"`
 *  BEFORE setting srcdoc; browsers preserve the iframe's name
 *  attribute into the iframe's `window.name` even across the null-
 *  origin srcdoc boundary. SDK reads that. Synchronous, no
 *  postMessage handshake. */
function detectWorkbookId() {
  if (typeof window === "undefined") return null;
  // window.name is conventionally used by extensions for various
  // things, so be defensive: only accept values that look like our
  // base64url ids (8-64 chars of the safe alphabet).
  const candidate = window.name;
  if (typeof candidate !== "string") return null;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(candidate)) return null;
  return candidate;
}

export class WorkbookConnectUnavailable extends Error {
  constructor(reason) {
    super(`workbook:connect unavailable — ${reason}`);
    this.name = "WorkbookConnectUnavailable";
    this.reason = reason;
  }
}

export class WorkbookConnectError extends Error {
  constructor(status, body) {
    super(`workbook:connect proxy error ${status}: ${body?.error ?? "unknown"}`);
    this.name = "WorkbookConnectError";
    this.status = status;
    this.body = body;
  }
}

/** Fetch via the broker env-var proxy. Returns a normal `Response`. */
export async function fetch(url, init = {}) {
  if (typeof url !== "string") {
    throw new TypeError("workbook:connect fetch(url, init) — url must be a string");
  }
  const env = init.env;
  if (typeof env !== "string" || env.length === 0) {
    throw new TypeError(
      "workbook:connect fetch(...) — init.env (env var name) is required",
    );
  }
  const workbookId = detectWorkbookId();
  if (!workbookId) {
    throw new WorkbookConnectUnavailable(
      "no workbook id in scope; this build runs outside workbooks.sh",
    );
  }
  const brokerOrigin = detectBrokerOrigin();
  const proxyUrl = `${brokerOrigin}/v1/workbooks/${encodeURIComponent(
    workbookId,
  )}/proxy`;

  // Serialize the body — broker accepts string bodies only (JSON
  // wrapping below). Users pass JSON-stringified content directly,
  // matching native fetch semantics.
  let bodyStr = null;
  if (init.body !== undefined && init.body !== null) {
    if (typeof init.body === "string") {
      bodyStr = init.body;
    } else {
      throw new TypeError(
        "workbook:connect — body must be a pre-stringified string (e.g. JSON.stringify(...))",
      );
    }
  }

  const proxyResp = await globalThis.fetch(proxyUrl, {
    method: "POST",
    credentials: "include", // include the broker session cookie
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url,
      env,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: bodyStr,
    }),
  });

  // Surface our own 4xx/5xx with structured info; pass upstream
  // responses straight through (the workbook code likely wants to
  // inspect them itself).
  if (proxyResp.status >= 400) {
    let parsed = null;
    try { parsed = await proxyResp.clone().json(); } catch { /* ignore */ }
    // 4xx from the broker (vs from upstream) is signaled by our
    // structured error shape. Distinguish so callers can react.
    if (parsed && typeof parsed.error === "string") {
      throw new WorkbookConnectError(proxyResp.status, parsed);
    }
  }
  return proxyResp;
}

/** Convenience: list the env names this workbook declares (read
 *  from the workbook-spec manifest baked at build time). */
export function declaredEnvs() {
  if (typeof document === "undefined") return [];
  const el = document.getElementById("workbook-spec");
  if (!el) return [];
  try {
    const spec = JSON.parse(el.textContent ?? "{}");
    const connect = spec?.manifest?.connect ?? {};
    return Object.keys(connect);
  } catch {
    return [];
  }
}
