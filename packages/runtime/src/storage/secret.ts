/**
 * `wb.secret` — workbook-scoped secrets stored in the OS keychain
 * via workbooksd. Browser code never holds the value; it holds a
 * handle (the secret id) and asks the daemon to splice the value
 * into outbound HTTPS requests at use time.
 *
 *   await wb.secret.set("FAL_API_KEY", "fal_…");
 *   const ids = await wb.secret.list();   // → ["FAL_API_KEY"]
 *   await wb.secret.delete("FAL_API_KEY");
 *
 *   // Make an authenticated call without ever decrypting the key
 *   // in browser memory:
 *   const resp = await wb.fetch({
 *     url: "https://queue.fal.run/fal-ai/...",
 *     method: "POST",
 *     headers: { "Content-Type": "application/json" },
 *     body: JSON.stringify({ prompt: "..." }),
 *     auth: {
 *       headerName: "Authorization",
 *       secretId: "FAL_API_KEY",
 *       format: "Key {value}",
 *     },
 *   });
 *   // resp.status, resp.headers, resp.body (string or base64).
 *
 * Why not localStorage:
 *   - localStorage is per-origin, and every workbook served by the
 *     daemon shares origin http://127.0.0.1:47119. Workbook B can
 *     `localStorage.getItem("…FAL_API_KEY")` and steal A's key.
 *   - The daemon stores keys in the OS keychain, namespaced by a
 *     hash of the canonical workbook path. The token-→-path lookup
 *     gates every read; token A can never resolve secrets stored
 *     under path(B). Closes the cross-workbook theft hole.
 *
 * Failure modes:
 *   - The page wasn't loaded under /wb/<token>/ (e.g. file://): all
 *     methods throw `WbSecretError("not bound to a daemon session")`.
 *     Pair with the install-toast self-redirect bootstrap so this
 *     happens transparently.
 *   - The daemon isn't running: methods throw `WbSecretError("daemon
 *     unreachable")`. Also covered by the toast.
 */

export interface WbSecretApi {
  /** Persist a secret value into the keychain under `id`. Returns once
   *  the daemon has acknowledged. Replaces any prior value at that id.
   *  The value is registered with the page-side leak defense for the
   *  duration of the call so any console.log / cross-origin fetch
   *  that accidentally captures it gets scrubbed / refused. */
  set(id: string, value: string): Promise<void>;
  /** Remove a secret from the keychain. Idempotent — deleting a
   *  non-existent secret is a no-op. */
  delete(id: string): Promise<void>;
  /** List the secret ids configured for THIS workbook. Returns ids
   *  only — values stay in the keychain. */
  list(): Promise<string[]>;
  /** Convenience helper — true if `list()` includes `id`. */
  has(id: string): Promise<boolean>;
  /** Get a redacted preview ("••••xyz4") for UI display. Daemon
   *  computes the masked form server-side; the page never sees the
   *  full value. Returns null when the secret isn't set. */
  preview(id: string): Promise<string | null>;
}

export interface WbFetchAuth {
  /** Header to inject, e.g. "Authorization", "xi-api-key". */
  headerName: string;
  /** Which secret id to splice. Must already be set via wb.secret.set. */
  secretId: string;
  /** Template — `{value}` is replaced. Default: just the raw value. */
  format?: string;
}

export interface WbFetchRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD";
  headers?: Record<string, string>;
  /** Request body. utf8 string by default; pass binary as base64
   *  with `bodyB64: true`. */
  body?: string;
  bodyB64?: boolean;
  auth?: WbFetchAuth;
}

export interface WbFetchResponse {
  status: number;
  headers: Record<string, string>;
  /** utf8 string when the upstream content-type indicates text/json,
   *  otherwise base64 (binary). Check `bodyB64` to know which. */
  body: string;
  bodyB64: boolean;
}

export interface WbFetchApi {
  /** Make an authenticated HTTPS call via the daemon's proxy. The
   *  secret named in `auth.secretId` is resolved daemon-side and the
   *  formatted header is injected before the call goes out. The page
   *  never sees the secret value. */
  (req: WbFetchRequest): Promise<WbFetchResponse>;
}

export class WbSecretError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "WbSecretError";
  }
}

// Daemon binding helpers come from install-prompt — single source
// of truth shared with permissions.ts, agent-acp, and the substrate
// transports. `requireBinding(feature)` does the resolve-or-throw
// dance AND auto-mounts the install toast on failure, so authors who
// haven't explicitly gated still get a soft landing instead of a
// raw exception in the console.
import { requireBinding, DaemonRequiredError } from "../install-prompt";

async function postJson(url: string, body: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new WbSecretError("daemon unreachable", e);
  }
  return res;
}

async function expectOk(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  let body = "";
  try { body = await res.text(); } catch { /* ignore */ }
  throw new WbSecretError(`${what}: ${res.status} ${res.statusText} ${body}`.trim());
}

import { registerSecretValue, unregisterSecretValue } from "./leak-defense";

export const secret: WbSecretApi = {
  async set(id, value) {
    const b = requireBinding("secrets");
    // Track the value with the page-side leak defense for the
    // duration of the round-trip. Any console.log / cross-origin
    // fetch that accidentally captures it during this window gets
    // scrubbed or refused. Unregister in finally — even on failure
    // the caller's local copy will be GC'd shortly.
    registerSecretValue(value);
    try {
      const res = await postJson(`${b.origin}/wb/${b.token}/secret/set`, { id, value });
      await expectOk(res, "secret/set");
    } finally {
      unregisterSecretValue(value);
    }
  },

  async delete(id) {
    const b = requireBinding("secrets");
    const res = await postJson(`${b.origin}/wb/${b.token}/secret/delete`, { id });
    await expectOk(res, "secret/delete");
  },

  async list() {
    const b = requireBinding("secrets");
    let res: Response;
    try {
      res = await fetch(`${b.origin}/wb/${b.token}/secret/list`);
    } catch (e) {
      throw new WbSecretError("daemon unreachable", e);
    }
    await expectOk(res, "secret/list");
    const json = (await res.json()) as { ids?: string[] };
    return Array.isArray(json.ids) ? json.ids : [];
  },

  async has(id) {
    const ids = await this.list();
    return ids.includes(id);
  },

  async preview(id) {
    const b = requireBinding("secrets");
    let res: Response;
    try {
      res = await fetch(
        `${b.origin}/wb/${b.token}/secret/preview/${encodeURIComponent(id)}`,
      );
    } catch (e) {
      throw new WbSecretError("daemon unreachable", e);
    }
    if (res.status === 404) return null;
    await expectOk(res, "secret/preview");
    const json = (await res.json()) as { masked?: string };
    return typeof json.masked === "string" ? json.masked : null;
  },
};

export const wbFetch: WbFetchApi = async (req) => {
  const b = requireBinding("network");
  const res = await postJson(`${b.origin}/wb/${b.token}/proxy`, {
    url: req.url,
    method: req.method ?? "GET",
    headers: req.headers ?? {},
    body: req.body,
    body_b64: !!req.bodyB64,
    auth: req.auth
      ? {
          headerName: req.auth.headerName,
          secretId: req.auth.secretId,
          format: req.auth.format,
        }
      : undefined,
  });
  await expectOk(res, "proxy");
  const j = (await res.json()) as {
    status: number;
    headers: Record<string, string>;
    body: string;
    body_b64: boolean;
  };
  return {
    status: j.status,
    headers: j.headers ?? {},
    body: j.body ?? "",
    bodyB64: !!j.body_b64,
  };
};
