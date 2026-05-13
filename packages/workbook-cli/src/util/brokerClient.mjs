// Shared broker client used by every subcommand that talks to
// auth.workbooks.sh — `publish`, `env`, `group`, `mcp serve`.
//
// Auth model:
//   - Prefer a `wbat_*` API token in env var WORKBOOKS_API_TOKEN (used
//     by Claude Code, CI, MCP server).
//   - Otherwise fall through to a cached browser OAuth bearer in
//     ~/.config/workbooks/auth.json (loopback-OAuth flow).
//
// Output discipline: throw Errors carrying the response body in
// .message so the dispatcher prints something useful.

import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { renderAuthCallbackPage } from "./authCallbackPage.mjs";

export const DEFAULT_BROKER =
  process.env.WORKBOOKS_BROKER ?? "https://auth.workbooks.sh";

const AUTH_PATH = path.join(os.homedir(), ".config", "workbooks", "auth.json");

export async function ensureBearer({ broker = DEFAULT_BROKER, force = false } = {}) {
  // API tokens skip the cache entirely — they don't expire, and the
  // user wants them honored even when a browser bearer is cached.
  const token = process.env.WORKBOOKS_API_TOKEN;
  if (token) return token;

  if (!force) {
    const cached = await readBearer();
    if (cached && cached.expires_at > Date.now() + 60_000) {
      return cached.bearer;
    }
  }
  const fresh = await loopbackAuth(broker);
  await writeBearer(fresh);
  return fresh.bearer;
}

async function readBearer() {
  try {
    const raw = await fs.readFile(AUTH_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.bearer === "string" && typeof parsed.expires_at === "number") {
      return parsed;
    }
  } catch {
    /* missing / malformed — caller will re-auth */
  }
  return null;
}

async function writeBearer(payload) {
  await fs.mkdir(path.dirname(AUTH_PATH), { recursive: true });
  await fs.writeFile(AUTH_PATH, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
}

// ─────────────────────────────────────────────────────────────────
// HTTP helpers — all return parsed JSON, throw on non-2xx.
// ─────────────────────────────────────────────────────────────────

async function request({ method, url, bearer, body }) {
  const headers = { authorization: `Bearer ${bearer}` };
  let payload;
  if (body !== undefined && body !== null) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const r = await fetch(url, { method, headers, body: payload });
  const text = await r.text();
  if (!r.ok) {
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.error ?? text;
    } catch {
      /* leave as raw text */
    }
    throw new Error(`${method} ${url} → ${r.status}: ${detail.slice(0, 500)}`);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function apiGet(pathname, { bearer, broker = DEFAULT_BROKER } = {}) {
  return request({ method: "GET", url: `${broker}${pathname}`, bearer });
}
export function apiPost(pathname, body, { bearer, broker = DEFAULT_BROKER } = {}) {
  return request({ method: "POST", url: `${broker}${pathname}`, bearer, body });
}
export function apiPatch(pathname, body, { bearer, broker = DEFAULT_BROKER } = {}) {
  return request({ method: "PATCH", url: `${broker}${pathname}`, bearer, body });
}
export function apiPut(pathname, body, { bearer, broker = DEFAULT_BROKER } = {}) {
  return request({ method: "PUT", url: `${broker}${pathname}`, bearer, body });
}
export function apiDelete(pathname, { bearer, broker = DEFAULT_BROKER } = {}) {
  return request({ method: "DELETE", url: `${broker}${pathname}`, bearer });
}

export async function putBytes(pathname, body, { bearer, broker = DEFAULT_BROKER, contentType = "text/html" } = {}) {
  const r = await fetch(`${broker}${pathname}`, {
    method: "PUT",
    headers: {
      "content-type": contentType,
      authorization: `Bearer ${bearer}`,
    },
    body,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`PUT ${pathname} → ${r.status}: ${text.slice(0, 500)}`);
  }
}

// ─────────────────────────────────────────────────────────────────
// Loopback OAuth — only used when no API token + no fresh cache.
// ─────────────────────────────────────────────────────────────────

async function loopbackAuth(broker) {
  const { server, port, codePromise } = await startLoopbackListener();
  const startUrl = `${broker}/v1/auth/start?return_to=${encodeURIComponent(`http://127.0.0.1:${port}/cb`)}`;

  process.stdout.write(`Opening browser to sign in...\n  ${startUrl}\n`);
  openInBrowser(startUrl);

  let code;
  try {
    code = await codePromise;
  } finally {
    server.close();
  }

  const exchanged = await request({
    method: "POST",
    url: `${broker}/v1/auth/exchange`,
    bearer: "",
    body: { broker_code: code },
  });
  if (!exchanged.bearer || !exchanged.expires_at) {
    throw new Error(`broker exchange failed (${JSON.stringify(exchanged)})`);
  }
  return {
    bearer: exchanged.bearer,
    expires_at: exchanged.expires_at * 1000,
    sub: exchanged.sub,
    email: exchanged.email,
  };
}

function startLoopbackListener() {
  return new Promise((resolve, reject) => {
    let resolveCode;
    let rejectCode;
    const codePromise = new Promise((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const deadline = setTimeout(
      () => rejectCode(new Error("auth timed out after 5m")),
      5 * 60_000,
    );

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1`);
      if (url.pathname !== "/cb") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("broker_code");
      const err = url.searchParams.get("error");
      if (err) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(
          renderAuthCallbackPage({
            status: "error",
            title: "Sign-in failed",
            message: "Workbooks could not complete CLI authentication.",
            detail: err,
          }),
        );
        clearTimeout(deadline);
        rejectCode(new Error(`broker error: ${err}`));
        return;
      }
      if (!code) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(
          renderAuthCallbackPage({
            status: "error",
            title: "Sign-in incomplete",
            message: "This callback did not include a sign-in code.",
            detail: "Return to your terminal and run the command again.",
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
        renderAuthCallbackPage({
          status: "success",
          title: "You're signed in",
          message: "The Workbooks CLI is authenticated.",
          detail: "You can close this tab and return to your terminal.",
        }),
      );
      clearTimeout(deadline);
      resolveCode(code);
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, codePromise });
    });
  });
}

function openInBrowser(url) {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" :
    platform === "win32"  ? "cmd"  :
    "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* headless / no browser */
  }
}
