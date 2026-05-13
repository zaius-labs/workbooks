// `workbook publish <file.html> [--revoke <id>]` — upload a compiled
// workbook to workbooks.sh and print a public share URL.
//
// Flow:
//   1. Load cached bearer from ~/.config/workbooks/auth.json. If
//      missing or expired, run loopback OAuth: start a temporary
//      HTTP server on 127.0.0.1:<random>, open the user's browser
//      at auth.workbooks.sh/v1/auth/start?return_to=<our-port>,
//      catch the broker_code on the redirect, exchange it for a
//      bearer at /v1/auth/exchange. Cache the bearer.
//   2. POST /v1/workbooks/public {slug,title} → {id, share_url}.
//   3. PUT  /v1/workbooks/:id/artifact (raw HTML body).
//   4. Print share_url + revoke instructions.

import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { readBundleMeta } from "../bundle/embedSource.mjs";
import { loadConfig } from "../util/config.mjs";

const DEFAULT_BROKER = process.env.WORKBOOKS_BROKER ?? "https://auth.workbooks.sh";
const DEFAULT_VIEWER = process.env.WORKBOOKS_VIEWER ?? "https://workbooks.sh";
const AUTH_PATH = path.join(os.homedir(), ".config", "workbooks", "auth.json");

export async function runPublish(opts = {}) {
  // --revoke <id> short-circuits — no upload, just hits the revoke
  // endpoint on the broker.
  if (opts.revoke) {
    const bearer = await ensureBearer({ broker: DEFAULT_BROKER, force: opts["force-auth"] });
    await revokeWorkbook({ broker: DEFAULT_BROKER, bearer, id: opts.revoke });
    process.stdout.write(`workbook revoked: ${opts.revoke}\n`);
    return;
  }

  const inputPath = opts._?.[0] ?? opts.input;
  if (!inputPath) {
    throw new Error(
      "workbook publish: missing input file.\n" +
        "  workbook publish <file.html>\n" +
        "  workbook publish --revoke <id>",
    );
  }
  const inputAbs = path.resolve(inputPath);
  const html = await fs.readFile(inputAbs, "utf8");
  if (html.length > 25 * 1024 * 1024) {
    throw new Error(
      `workbook publish: file is ${(html.length / 1024 / 1024).toFixed(1)} MB. ` +
        `The hosted viewer caps artifacts at 25 MB. Consider --no-bundle on build.`,
    );
  }

  // Derive a slug from the filename — `dist/my-thing.html` → `my-thing`.
  // If the source bundle exposes a rootName, prefer that.
  const meta = readBundleMeta(html);
  const slugFromBytes =
    meta?.rootName ?? path.basename(inputAbs, path.extname(inputAbs));

  // Try to load workbook.config.mjs so the publish picks up author +
  // description + title. Common layouts:
  //   - user is in project root, file is at dist/foo.html → cwd works
  //   - user passes an absolute path to a built .html elsewhere →
  //     try parent of file's parent (project root next to dist/)
  // If neither has a config, fall back to byte-derived values —
  // publishing a one-off built .html still works, just without identity.
  let cfg = null;
  const cwd = process.cwd();
  cfg = await loadConfig(cwd).catch(() => null);
  if (!cfg) {
    const projectGuess = path.dirname(path.dirname(inputAbs));
    cfg = await loadConfig(projectGuess).catch(() => null);
  }

  const slug = opts.slug ?? cfg?.slug ?? slugFromBytes;
  const title = opts.title ?? cfg?.name ?? slug;
  const author = opts.author ?? cfg?.author ?? null;
  const description = opts.description ?? cfg?.description ?? null;

  const bearer = await ensureBearer({
    broker: DEFAULT_BROKER,
    force: opts["force-auth"],
  });

  // Register the workbook record. The broker mints the id so the
  // CLI doesn't have to coordinate uniqueness.
  // The `connect:` block declares the workbook's routing policy
  // (which env-var name maps to which destination + splice rule).
  // The broker stores this on the workbook record and reads it at
  // proxy time — admin sets values, author sets policy.
  const connect = cfg?.connect && Object.keys(cfg.connect).length > 0 ? cfg.connect : undefined;

  // `--group <id>` publishes the workbook into a group library; only
  // members can view it on the hosted viewer. Without it, the workbook
  // is personal (public to anyone with the link).
  const group_id = opts.group ?? null;

  const created = await postJson(
    `${DEFAULT_BROKER}/v1/workbooks/public`,
    { slug, title, author, description, connect, group_id },
    bearer,
  );
  if (!created.id) {
    throw new Error(`workbook publish: broker returned no id (${JSON.stringify(created)})`);
  }

  // Upload the artifact bytes. The broker stores them in R2 and
  // serves them at workbooks.sh/w/<id> as a plain envelope.
  await putBytes(
    `${DEFAULT_BROKER}/v1/workbooks/${encodeURIComponent(created.id)}/artifact`,
    html,
    bearer,
  );

  const shareUrl = created.share_url ?? `${DEFAULT_VIEWER}/w/${created.id}`;
  process.stdout.write(
    `\n  ${shareUrl}\n\n` +
      `  revoke: workbook publish --revoke ${created.id}\n` +
      `  or visit: https://studio.workbooks.sh/workbooks/${created.id}\n\n`,
  );
}

// ─────────────────────────────────────────────────────────────────
// Bearer cache.
// ─────────────────────────────────────────────────────────────────

async function ensureBearer({ broker, force }) {
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
// Loopback OAuth.
//
// 1. Start an HTTP listener on 127.0.0.1:<auto>.
// 2. Open the broker's /v1/auth/start with return_to pointing at us.
// 3. The broker runs WorkOS OIDC, then redirects to our listener
//    with ?broker_code=<code>.
// 4. We POST /v1/auth/exchange to swap the code for a bearer.
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

  const exchanged = await postJson(`${broker}/v1/auth/exchange`, { broker_code: code });
  if (!exchanged.bearer || !exchanged.expires_at) {
    throw new Error(`workbook publish: broker exchange failed (${JSON.stringify(exchanged)})`);
  }
  return {
    bearer: exchanged.bearer,
    // Broker reports seconds since epoch; we cache in ms for parity with Date.now().
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

    // 5-minute window — if the user wanders off, fail cleanly rather
    // than leaking the port forever.
    const deadline = setTimeout(() => rejectCode(new Error("auth timed out after 5m")), 5 * 60_000);

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1`);
      if (url.pathname !== "/cb") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("broker_code");
      const err = url.searchParams.get("error");
      if (err) {
        res.writeHead(400, { "content-type": "text/html" }).end(
          `<h2>sign-in failed</h2><p>${escapeHtml(err)}</p>`,
        );
        clearTimeout(deadline);
        rejectCode(new Error(`broker error: ${err}`));
        return;
      }
      if (!code) {
        res.writeHead(400, { "content-type": "text/html" }).end(
          `<h2>missing broker_code</h2><p>did you complete sign-in?</p>`,
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(
        `<!doctype html><html><body style="font:14px system-ui;padding:32px"><h2>Signed in.</h2><p>You can close this tab and return to the terminal.</p></body></html>`,
      );
      clearTimeout(deadline);
      resolveCode(code);
    });

    server.on("error", reject);
    // Port 0 = let the OS pick a free port in the ephemeral range.
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
    // Headless / no browser — caller already printed the URL.
  }
}

// ─────────────────────────────────────────────────────────────────
// HTTP helpers.
// ─────────────────────────────────────────────────────────────────

async function postJson(url, body, bearer) {
  const headers = { "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const r = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`POST ${url} → ${r.status}: ${text.slice(0, 500)}`);
  }
  return r.json();
}

async function putBytes(url, body, bearer) {
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      "content-type": "text/html",
      authorization: `Bearer ${bearer}`,
    },
    body,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`PUT ${url} → ${r.status}: ${text.slice(0, 500)}`);
  }
}

async function revokeWorkbook({ broker, bearer, id }) {
  const r = await fetch(`${broker}/v1/workbooks/${encodeURIComponent(id)}/revoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`revoke → ${r.status}: ${text.slice(0, 500)}`);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}
