// `workbook seal` — wrap a built workbook in a studio-v1 envelope so
// it can be opened only by recipients who satisfy a broker-checked
// identity policy.
//
// Spec: vendor/workbooks/docs/ENCRYPTED_FORMAT.md
// Tracker: bd show core-1fi.1.3
//
// Usage:
//   workbook seal --in dist/foo.html \
//                 --out dist/foo.sealed.html \
//                 --broker https://broker.signal.ml \
//                 --policy policy.json
//
// On success, prints to stdout:
//   workbook_id=<base64url id>
//   policy_hash=sha256:<hex>
//   view=default dek=<base64url 32-byte DEK>
//
// The DEK MUST be registered with the broker before the sealed file
// is distributed (POST /v1/workbooks/:id/views/default/key). Until C1.7
// lands the broker's wrap endpoint, the operator copies the DEK out
// of seal's stdout and posts it manually with curl. After C1.7 the
// CLI will call the broker directly and never print the DEK.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { wrapStudio } from "../encrypt/wrapStudio.mjs";

function looksLikeStudioEnvelope(html) {
  return /<meta\s+name=["']wb-encryption["']\s+content=["']studio-v1["']/i.test(
    html,
  );
}

export async function runSeal(opts) {
  const inPath = opts.in;
  const outPath = opts.out;
  const broker = opts.broker;
  const policyPath = opts.policy;
  const title = opts.title ?? "Sealed workbook";

  if (!inPath) throw new Error("missing --in <path-to-workbook>.html");
  if (!outPath) throw new Error("missing --out <path>");
  if (!broker) throw new Error("missing --broker <https://broker.url>");
  if (!policyPath) throw new Error("missing --policy <policy.json>");

  const html = await fs.readFile(inPath, "utf8");
  if (looksLikeStudioEnvelope(html)) {
    throw new Error(
      `${inPath} is already a studio-v1 envelope — refusing to double-wrap.`,
    );
  }

  const policyText = await fs.readFile(policyPath, "utf8");
  let policy;
  try {
    policy = JSON.parse(policyText);
  } catch (e) {
    throw new Error(`failed to parse --policy ${policyPath}: ${e.message}`);
  }

  // C8.7-A — author-claim signing (opt-in via --sign).
  // Iteration A asks the caller to provide the identity tuple that
  // the broker has already issued (sub, email, key_id from
  // POST /v1/authors/me/keys). The daemon is the only thing that
  // touches the per-machine ed25519 private key — the CLI shells out
  // over the daemon's localhost HTTP endpoints.
  //
  // Pinning workbookId: the canonical claim bytes the daemon signs
  // include the workbook_id, so we MUST use the same id when
  // wrapStudio emits the envelope. signClaimViaDaemon mints + returns
  // the id; we feed it back into wrapStudio via the workbookId opt.
  let claim, claimSig, workbookId;
  if (opts.sign) {
    const signed = await signClaimViaDaemon({
      authorSub: opts["author-sub"] ?? opts.authorSub,
      authorEmail: opts["author-email"] ?? opts.authorEmail,
      keyId: opts["key-id"] ?? opts.keyId,
      authorName: opts["author-name"] ?? opts.authorName,
      brokerUrl: broker,
    });
    claim = signed.fetchedClaim;
    claimSig = signed.fetchedSig;
    workbookId = signed.workbookId;
  }

  const result = await wrapStudio({
    html,
    brokerUrl: broker,
    policy,
    title,
    workbookId,
    claim,
    claimSig,
  });
  await fs.writeFile(outPath, result.html, "utf8");

  // Stable, parseable output. CI scripts can grep it.
  process.stdout.write(`workbook_id=${result.workbookId}\n`);
  process.stdout.write(`policy_hash=${result.policyHash}\n`);
  for (const v of result.views) {
    process.stdout.write(`view=${v.id} dek=${v.dek}\n`);
  }
  if (claim && claimSig) {
    process.stdout.write(`claim_signed=yes key_id=${claim.key_id}\n`);
  }
  process.stdout.write(`out=${outPath}\n`);
}

/** Talk to the local workbooksd daemon to produce a signed author
 *  claim. The daemon owns the per-machine ed25519 key; we never see it.
 *
 *  As of C8.7-B (2026-05-03) the daemon resolves identity from a
 *  cached registration (~/.../signing/author_identity.json). The CLI
 *  doesn't pass identity flags by default; if no cache exists, the
 *  daemon returns 401 not_registered, the CLI auto-runs
 *  /author/register (which opens a browser for the user to sign in),
 *  then retries.
 *
 *  Manual override flags (--author-sub / --author-email / --key-id)
 *  are still honored if the caller wants to sign as a specific
 *  identity without touching the cache (e.g., tests, CI).
 */
async function signClaimViaDaemon({
  authorSub,
  authorEmail,
  keyId,
  authorName,
  brokerUrl,
}) {
  const port = await readDaemonPort();
  const daemonUrl = `http://127.0.0.1:${port}`;

  // Pin one workbookId across the daemon-side claim signature AND
  // the wrapStudio envelope — they MUST match or the recipient
  // verifier reconstructs the wrong canonical bytes and rejects.
  const workbookId = newWorkbookIdLocal();
  const ts = Math.floor(Date.now() / 1000);

  const body = {
    workbook_id: workbookId,
    ts,
  };
  // Manual overrides — only included if explicitly passed.
  if (authorSub) body.author_sub = authorSub;
  if (authorEmail) body.author_email = authorEmail;
  if (keyId) body.key_id = keyId;

  let sign;
  try {
    sign = await daemonPost(daemonUrl, "/author/sign-claim", body);
  } catch (e) {
    // not_registered → kick off interactive registration, then retry.
    if (String(e.message ?? "").includes('"not_registered"')) {
      if (!brokerUrl) {
        throw new Error(
          "[seal] daemon not registered. Pass --broker so the daemon knows where to authenticate, or pre-register via POST /author/register.",
        );
      }
      process.stderr.write(
        `[seal] daemon not registered with broker. Running one-time registration — your browser will open for sign-in.\n`,
      );
      await daemonPost(daemonUrl, "/author/register", {
        broker_url: brokerUrl,
      });
      // Retry with the same body. The daemon now has a cached
      // identity; even if --author-* weren't passed, the cache fills
      // in.
      sign = await daemonPost(daemonUrl, "/author/sign-claim", body);
    } else {
      throw e;
    }
  }

  // The daemon echoes back the resolved identity (cached or
  // body-overridden) so we can build the claim object the same way
  // wrapStudio expects.
  return {
    fetchedClaim: {
      author_sub: sign.author_sub ?? authorSub,
      author_email: sign.author_email ?? authorEmail,
      author_name: authorName,
      key_id: sign.key_id ?? keyId,
      ts,
    },
    fetchedSig: sign.sig,
    workbookId,
  };
}

/** Mint a UUIDv7-ish id, base64url. Mirrors wrapStudio.newWorkbookId
 *  (private). We re-implement here so the CLI can pin one id across
 *  the claim signature + the wrapStudio call. */
function newWorkbookIdLocal() {
  const ts = Date.now();
  const rand = new Uint8Array(10);
  globalThis.crypto.getRandomValues(rand);
  const bytes = new Uint8Array(16);
  bytes[0] = (ts >>> 40) & 0xff;
  bytes[1] = (ts >>> 32) & 0xff;
  bytes[2] = (ts >>> 24) & 0xff;
  bytes[3] = (ts >>> 16) & 0xff;
  bytes[4] = (ts >>> 8) & 0xff;
  bytes[5] = ts & 0xff;
  for (let i = 0; i < 10; i++) bytes[6 + i] = rand[i];
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return Buffer.from(bin, "binary")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function readDaemonPort() {
  // Mirror packages/workbooksd/src/main.rs::runtime_state_dir() —
  // ~/Library/Application Support/sh.workbooks.workbooksd/runtime.json
  // on macOS, ~/.local/share/workbooksd/runtime.json elsewhere.
  let p;
  if (process.platform === "darwin") {
    p = path.join(
      os.homedir(),
      "Library/Application Support/sh.workbooks.workbooksd/runtime.json",
    );
  } else {
    p = path.join(os.homedir(), ".local/share/workbooksd/runtime.json");
  }
  let raw;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (e) {
    throw new Error(
      `[seal] daemon runtime.json not found at ${p}. Is workbooksd running? (start it via /Applications/Workbooks.app or the workbooksd binary)`,
    );
  }
  const j = JSON.parse(raw);
  if (typeof j.port !== "number") {
    throw new Error(`[seal] runtime.json missing port: ${raw}`);
  }
  return j.port;
}

async function daemonGet(base, p) {
  const r = await fetch(base + p);
  if (!r.ok) {
    throw new Error(`daemon GET ${p} failed: ${r.status} ${await r.text()}`);
  }
  return r.json();
}
async function daemonPost(base, p, body) {
  const r = await fetch(base + p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    throw new Error(`daemon POST ${p} failed: ${r.status} ${await r.text()}`);
  }
  return r.json();
}
