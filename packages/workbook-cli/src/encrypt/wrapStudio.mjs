// Studio-encrypted workbook wrapper. Sister of wrapHtml.mjs (which does
// passphrase-based age-v1). This produces studio-v1 envelopes whose
// decryption keys are released by the broker, not derived from a
// passphrase.
//
// Spec: vendor/workbooks/docs/ENCRYPTED_FORMAT.md
// Threat model: vendor/workbooks/docs/SECURITY_MODEL_MULTIPARTY.md
// Tracker: bd show core-1fi.1.3

import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return Buffer.from(bin, "binary").toString("base64");
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlToBytes(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Generate a UUIDv7-shaped id, base32-encoded for URL-safe display.
 * Not strictly UUIDv7 (we skip the variant bits) — close enough for
 * our use as a workbook identifier.
 */
function newWorkbookId() {
  const ts = Date.now();
  const rand = new Uint8Array(10);
  webcrypto.getRandomValues(rand);
  const bytes = new Uint8Array(16);
  bytes[0] = (ts >>> 40) & 0xff;
  bytes[1] = (ts >>> 32) & 0xff;
  bytes[2] = (ts >>> 24) & 0xff;
  bytes[3] = (ts >>> 16) & 0xff;
  bytes[4] = (ts >>> 8) & 0xff;
  bytes[5] = ts & 0xff;
  for (let i = 0; i < 10; i++) bytes[6 + i] = rand[i];
  return bytesToBase64Url(bytes);
}

/**
 * Canonical-JSON hash of the policy. Stable across implementations
 * because we sort keys and use compact separators. Used as both the
 * value of wb-policy-hash and the AD-binding for AES-GCM.
 */
async function hashPolicy(policy) {
  const canonical = JSON.stringify(policy, Object.keys(policy).sort());
  const bytes = new TextEncoder().encode(canonical);
  const digest = await subtle.digest("SHA-256", bytes);
  return "sha256:" + Buffer.from(digest).toString("hex");
}

function buildAd({ workbookId, viewId, policyHash }) {
  return new TextEncoder().encode(
    `studio-v1|${workbookId}|${viewId}|${policyHash}`,
  );
}

/**
 * Encrypt one view payload under a freshly-generated DEK.
 *
 * Returns:
 *   { dek: Uint8Array(32), iv: Uint8Array(12), ciphertext: Uint8Array,
 *     mac: Uint8Array(16) }
 *
 * In WebCrypto, GCM returns ciphertext||tag concatenated. We split so
 * the envelope can carry the MAC separately (improves inspectability;
 * decryptor reassembles before calling decrypt).
 */
async function encryptView({ plaintext, workbookId, viewId, policyHash }) {
  const dek = new Uint8Array(32);
  webcrypto.getRandomValues(dek);
  const iv = new Uint8Array(12);
  webcrypto.getRandomValues(iv);

  const key = await subtle.importKey(
    "raw",
    dek,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ad = buildAd({ workbookId, viewId, policyHash });
  const sealed = new Uint8Array(
    await subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: ad, tagLength: 128 },
      key,
      plaintext,
    ),
  );
  // GCM returns ct||tag. Split.
  const ciphertext = sealed.slice(0, sealed.length - 16);
  const mac = sealed.slice(sealed.length - 16);
  return { dek, iv, ciphertext, mac };
}

/**
 * Decrypt one view payload given its DEK and the envelope metadata.
 * Used by `workbook unseal` for testing — bypasses the broker entirely.
 */
export async function decryptView({
  dek,
  iv,
  ciphertext,
  mac,
  workbookId,
  viewId,
  policyHash,
}) {
  const key = await subtle.importKey(
    "raw",
    dek,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const ad = buildAd({ workbookId, viewId, policyHash });
  const sealed = new Uint8Array(ciphertext.length + mac.length);
  sealed.set(ciphertext, 0);
  sealed.set(mac, ciphertext.length);
  const pt = new Uint8Array(
    await subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: ad, tagLength: 128 },
      key,
      sealed,
    ),
  );
  return pt;
}

/** Pre-auth shell template (C8). Renders in the browser-fallback path
 *  (no daemon installed) — the daemon parses meta tags directly and
 *  never reaches this UI.
 *
 *  Goal: a recipient who opens a sealed `.html` in their
 *  browser sees who sealed it, when, and a verifiable trust badge —
 *  BEFORE signing in. The author claim is embedded as `wb-author-*`
 *  meta tags signed with the author's registered ed25519 key (see
 *  bd core-5ah.10 for key-mgmt). The shell script fetches the
 *  author's public keys from the broker (auth-free per C8-A) and
 *  verifies the claim signature in-browser via WebCrypto Ed25519
 *  before flipping the badge to "verified."
 *
 *  Failure modes degrade visibly: missing claim → no badge,
 *  unverified claim → "unverified" warning, mismatched signature →
 *  "tampered" warning. Never silently displays a forged identity.
 *
 *  Kept lean — CSP restricts to self only; no external resources
 *  beyond a single fetch to the registered broker URL. */
const SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="wb-encryption" content="studio-v1">
<meta name="wb-workbook-id" content="%%WORKBOOK_ID%%">
<meta name="wb-broker-url" content="%%BROKER_URL%%">
<meta name="wb-policy-hash" content="%%POLICY_HASH%%">
<meta name="wb-cipher" content="aes-256-gcm">
<meta name="wb-views" content='%%VIEWS_JSON%%'>%%CLAIM_META%%
<title>%%TITLE%%</title>
<meta name="color-scheme" content="light dark">
<style>
/* Lander brand tokens — strict monochrome, hairlines only, no chunky
   borders. Auto dark-mode via prefers-color-scheme. Status colors
   (ok/warn/err) are the ONLY non-monochrome accents and live exclusively
   on the trust badge — every other surface stays grayscale. */
:root{
  --bg:#ffffff;--fg:#0a0a0a;--fg-mute:#555;--line:#ececec;--code-bg:#f5f5f5;
  --ok:#0a7c45;--warn:#a35400;--err:#b3261e;
  --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark){
  :root{--bg:#0a0a0a;--fg:#f5f5f5;--fg-mute:#9a9a9a;--line:#1c1c1c;--code-bg:#141414}
}
*{box-sizing:border-box}
body{
  margin:0;min-height:100vh;
  background:var(--bg);color:var(--fg);
  font-family:var(--sans);font-size:16px;line-height:1.55;
  -webkit-font-smoothing:antialiased;
  /* Graph-paper accent — faint 24px grid behind the focus surface.
     Pure visual signature, not a functional element. */
  background-image:
    linear-gradient(var(--line) 1px, transparent 1px),
    linear-gradient(90deg, var(--line) 1px, transparent 1px);
  background-size:24px 24px;
  background-position:-1px -1px;
  display:grid;place-items:center;
}
main{max-width:520px;width:100%;padding:48px 24px}
.logo{display:block;width:40px;height:40px;margin:0 0 32px}
.logo svg{width:100%;height:100%;display:block;fill:var(--fg)}
.kicker{font-family:var(--mono);font-size:11px;letter-spacing:.04em;text-transform:lowercase;color:var(--fg-mute);margin:0 0 14px}
h1{font-family:var(--sans);font-size:1.9rem;font-weight:600;letter-spacing:-0.02em;line-height:1.15;margin:0 0 .6rem}
.lede{color:var(--fg-mute);font-size:1rem;line-height:1.55;margin:0 0 2rem;max-width:36em}
button{
  font:inherit;font-size:.95rem;font-weight:500;
  padding:.7rem 1.1rem;
  background:var(--fg);color:var(--bg);
  border:0;border-radius:8px;cursor:pointer;
  letter-spacing:.01em;width:100%;
}
button:hover{opacity:.88}
.claim{
  margin:0 0 1.25rem;padding:14px 16px;
  background:var(--code-bg);border-radius:8px;
  font-size:.85rem;line-height:1.5;
}
.claim-row{display:flex;align-items:baseline;gap:10px;margin:0}
.claim-row + .claim-row{margin-top:6px}
.claim-label{
  font-family:var(--mono);font-size:.7rem;letter-spacing:.04em;
  text-transform:lowercase;color:var(--fg-mute);
  min-width:70px;flex-shrink:0;
}
.claim-value{color:var(--fg);overflow-wrap:anywhere}
.badge{
  display:inline-flex;align-items:center;
  padding:2px 8px;border-radius:999px;
  font:inherit;font-family:var(--mono);font-size:.7rem;font-weight:500;
  letter-spacing:.04em;text-transform:lowercase;
  background:transparent;color:var(--fg-mute);
}
.badge[data-state="ok"]{color:var(--ok)}
.badge[data-state="warn"]{color:var(--warn)}
.badge[data-state="err"]{color:var(--err)}
.foot{margin-top:1.5rem;font-size:.75rem;color:var(--fg-mute);font-family:var(--mono);letter-spacing:.02em}
button.secondary{background:var(--code-bg);color:var(--fg);margin-bottom:.6rem}
.app-hint{margin-top:.6rem;font-size:.75rem;color:var(--fg-mute);text-align:center}
.app-hint a{color:var(--fg-mute);text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:3px}
.app-hint a:hover{text-decoration-color:var(--fg-mute)}
.app-hint.show{display:block}
.app-hint.hide{display:none}
/* Trust badge clickability — only when there's a chain to inspect. */
.badge.clickable{cursor:pointer;text-decoration:underline;text-decoration-color:currentColor;text-decoration-style:dotted;text-underline-offset:3px}
/* Provenance modal (C8.8) */
.modal-backdrop{position:fixed;inset:0;background:color-mix(in srgb, var(--fg) 40%, transparent);z-index:9;display:none}
.modal-backdrop.open{display:block}
.modal{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:2rem;max-width:520px;width:90%;z-index:10;display:none;max-height:80vh;overflow:auto}
.modal.open{display:block}
.modal h2{font-size:1.25rem;margin:0 0 1rem}
.modal-close{position:absolute;top:1rem;right:1rem;background:transparent;color:var(--fg-mute);border:0;font-size:1.25rem;cursor:pointer;padding:0;width:auto;line-height:1}
.chain-entry{padding:.85rem 0;border-bottom:1px solid var(--line)}
.chain-entry:last-child{border-bottom:0}
.chain-entry .who{font-size:.95rem;font-weight:500;margin:0}
.chain-entry .when{font-family:var(--mono);font-size:.7rem;color:var(--fg-mute);margin:.15rem 0 .3rem}
.chain-entry .keyfp{font-family:var(--mono);font-size:.7rem;color:var(--fg-mute);margin:0}
.chain-entry .badge{margin-top:.35rem}
</style>
</head>
<body>
<main>
<a class="logo" href="https://workbooks.sh" aria-label="Workbooks"><svg viewBox="0 0 634 632" xmlns="http://www.w3.org/2000/svg"><path d="M517.107 187.121c3.312-.185 8.268.011 11.708.025l18.899-.006c5.975.053 12.157-.374 18.097.049 2.266.162 4.811.531 6.928 1.374 3.545 1.412 7.111 5.477 8.498 8.898.799 1.962.985 4.393 1.112 6.494.554 9.275.154 18.791.157 28.086.007 8.063.486 16.478-.216 24.507-.189 2.18-.592 4.854-1.514 6.845-1.684 3.63-5.189 6.732-8.925 8.033-6.229 2.169-33.731 1.225-42.055 1.209-3.898-.007-8.606-.463-12.25 1.082-4.102 1.742-8.008 5.198-9.624 9.414-1.855 4.83-1.316 10.614-1.313 15.701l.062 28.033c.015 6.295.758 15.131-1.539 20.931-5.597 14.151-20.837 9.282-32.675 10.081-9.138.613-19.654-1.541-28.452 1.755-12.015 4.682-10.959 16.502-10.876 26.83l.072 27.738c0 4.091.204 11.711-.22 15.565-.204 1.949-.709 3.859-1.489 5.657-3.514 7.973-10.538 9.347-18.42 9.298-14.549-.084-29.245.092-43.77-.078-6.634-.077-13.039-5.484-14.813-11.708-1.062-3.736-.715-10.334-.709-14.383l-.012-28.013c.025-5.27.139-10.377-.009-15.701.031-8.802-7.467-16.363-16.234-16.808-9.417-.471-18.834.117-28.275-.202-10.584-.359-22.852-.421-27.975 10.873-1.892 4.172-1.358 12.256-1.344 16.893l.017 27.378c.001 6.261.75 16.71-1.632 22.197-4.048 9.332-13.185 9.759-21.739 9.555-14.084-.338-27.714.359-41.744-.14-6.89-.244-12.302-5.843-14.258-12.107-1.101-3.993-.763-9.827-.762-14.064l.041-24.485c.025-5.926.758-19.291-.879-24.605-4.667-15.15-24.772-11.102-37.157-11.408-11.647-.291-29.066 4.565-34.084-11.374-1.797-5.71-1.061-16.048-1.067-22.136-.027-8.601-.01-17.205.051-25.808.063-9.655 1.263-19.248-9.165-24.403l-.369-.178c-5.697-2.008-10.659-1.421-16.695-1.383l-21.296.038c-9.081.006-17.585 1.431-23.965-6.161-5-5.95-4.043-11.304-4.152-18.542-.085-5.669-.039-11.249-.047-16.863l.013-17.394c.025-6.844-.723-13.073 3.195-19.068 5.171-7.912 13.402-6.857 21.719-6.89l20.827.058c7.153.011 14.83-.321 21.96.169 2.616.313 5.245 1.252 7.38 2.756 8.112 5.718 6.989 16.016 6.936 24.686l-.134 27.752c-.021 5.352-.285 11.796.477 16.997.494 5.157 6.217 11.482 11.6 12.509 9.836 1.651 20.253.675 30.329.858 11.947.218 26.591-2.583 30.621 12.773 1.115 4.247.67 10.385.659 14.906l-.06 27.135c-.009 4.348-.22 12.197.378 16.31.609 4.358 2.939 8.292 6.468 10.922 1.904 1.406 4.344 2.696 6.687 2.99 7.476.938 16.342.483 23.937.542 4.237.034 14.821.21 18.394-.387 6.14-1.08 11.199-5.429 13.193-11.334 1.436-4.33.933-11.3.876-16.063l-.087-27.235c.006-5.421-.181-11.265.521-16.641.885-6.781 7.074-13.157 14.031-13.69 8.019-.615 16.289-.149 24.342-.228 8.958.055 18.193-.388 27.112.415 6.785.794 12.296 5.557 13.766 12.301 1.096 5.026.74 10.851.706 16.012l-.111 26.129c-.034 9.183-1.635 21.259 6.764 27.261 7.241 5.174 19.014 3.169 27.601 3.469 7.064-.331 14.624.588 21.62-.387 16.216-2.256 14.25-18.378 14.207-29.288l-.053-26.435c-.009-7.155-1.046-17.233 3.548-23.127 2.325-2.947 5.566-5.037 9.209-5.94 4.656-1.196 9.269-.388 14.012-.48 10.689-.209 21.818.574 32.433-.278 5.724-.46 11.758-5.155 13.457-10.603 1.43-4.586 1.062-10.521 1.04-15.394l-.027-29.017c-.016-14.087-1.948-28.484 16.531-31.054z"/></svg></a>
<p class="kicker">workbooks · sealed</p>
<h1>%%TITLE%%</h1>
<p class="lede">This workbook is sealed. Sign in to your organization to unlock — decryption happens after identity is verified by the broker.</p>
%%CLAIM_BLOCK%%<button id="wb-open-app" class="secondary">Open in Workbooks app</button>
<button id="wb-signin">Sign in to unlock</button>
<p id="wb-app-hint" class="app-hint hide">Don't have Workbooks installed? <a href="https://workbooks.sh/install" target="_blank" rel="noopener">Get the app</a></p>
<p class="foot">studio-v1 · aes-256-gcm</p>
</main>
<div id="wb-modal-backdrop" class="modal-backdrop" role="presentation"></div>
<div id="wb-modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="wb-modal-title">
  <button id="wb-modal-close" aria-label="Close">×</button>
  <h2 id="wb-modal-title">Provenance chain</h2>
  <p style="font-size:.85rem;color:var(--fg-mute);margin:0 0 1rem">Every author who has sealed or re-sealed this workbook, with in-browser ed25519 signature verification against the broker's registered keys.</p>
  <div id="wb-chain"></div>
</div>
<script type="application/octet-stream" id="wb-payload">%%PAYLOAD_B64%%</script>
<script type="module">
// Browser fallback shell. Daemons parse meta tags directly and never
// hit this code path. Three responsibilities:
//
//   1. Sign-in CTAs (C8.5):
//      - "Open in Workbooks app" tries a custom URL scheme. If the
//        scheme isn't registered (no Workbooks.app installed), fall
//        through to a small "Get the app" hint.
//      - "Sign in to unlock" goes to broker /v1/auth/start.
//   2. Author-claim verification (C8.3): single current-author claim.
//   3. Provenance chain (C8.6+8.8): wb-claim-chain meta carries every
//      prior author's signed claim. Each verifies independently; the
//      modal renders the full walk + per-entry status.

const meta = (n) => {
  const el = document.querySelector('meta[name="' + n + '"]');
  return el ? el.content : null;
};

// ── C8.5 — Daemon-aware sign-in CTAs ────────────────────────────────
//
// "Open in Workbooks app" uses workbooks-open://<workbook-id>. The
// Workbooks.app registers this scheme via its bundle's
// CFBundleURLTypes (mac) / desktop file (linux). If the scheme isn't
// handled, no app launch happens — we surface a "Get the app" hint
// after 1.5s. Heuristic but standard (Slack, Zoom, 1Password use the
// same pattern).
document.getElementById("wb-open-app").addEventListener("click", () => {
  const id = meta("wb-workbook-id") ?? "";
  const broker = meta("wb-broker-url") ?? "";
  const url = "workbooks-open://" + encodeURIComponent(id) +
              "?broker=" + encodeURIComponent(broker) +
              "&from=" + encodeURIComponent(location.href);
  // Detect "scheme not handled" by watching for visibility loss.
  // If the browser handed off to an app, the page goes hidden; if
  // not, we stay visible and surface the install hint.
  let handed = false;
  const onHide = () => { handed = true; };
  document.addEventListener("visibilitychange", onHide, { once: true });
  location.href = url;
  setTimeout(() => {
    document.removeEventListener("visibilitychange", onHide);
    if (!handed) {
      const hint = document.getElementById("wb-app-hint");
      hint.classList.remove("hide");
      hint.classList.add("show");
    }
  }, 1500);
});

document.getElementById("wb-signin").addEventListener("click", () => {
  const broker = meta("wb-broker-url");
  const id = meta("wb-workbook-id");
  const ret = encodeURIComponent(location.href);
  location.href = broker + "/v1/auth/start?workbook_id=" + id + "&return_to=" + ret;
});

// ── C8.3 + C8.6 + C8.8 — Author claim + chain verification ──────────

const claimsToVerify = [];

const currentClaim = readCurrentClaim();
if (currentClaim) claimsToVerify.push({ ...currentClaim, label: "current" });

const chainRaw = meta("wb-claim-chain");
if (chainRaw) {
  try {
    const decoded = atob(chainRaw.replace(/-/g, "+").replace(/_/g, "/"));
    const entries = JSON.parse(decoded);
    if (Array.isArray(entries)) {
      for (const e of entries) {
        if (
          typeof e === "object" && e &&
          typeof e.author_sub === "string" &&
          typeof e.author_email === "string" &&
          typeof e.key_id === "string" &&
          typeof e.workbook_id === "string" &&
          typeof e.ts === "number" &&
          typeof e.sig === "string"
        ) {
          claimsToVerify.push({ ...e, label: "prior" });
        }
      }
    }
  } catch (e) {
    // Malformed chain meta — log to console but render nothing
    // misleading. The current claim still verifies independently.
    console.warn("[wb] wb-claim-chain parse failed", e);
  }
}

(async () => {
  const badge = document.getElementById("wb-claim-badge");
  if (!badge) return;
  if (claimsToVerify.length === 0) {
    setBadge(badge, "warn", "unverified");
    return;
  }

  const broker = meta("wb-broker-url");
  if (!broker) {
    setBadge(badge, "warn", "verify failed");
    return;
  }

  // Verify each entry. We cache pubkey lookups per (sub) so a chain
  // with N saves by the same author hits the broker once.
  const keysCache = new Map();
  const results = [];
  for (const c of claimsToVerify) {
    results.push(await verifyOne(broker, c, keysCache));
  }

  // Top-level badge state: worst result wins. ok everywhere → ok;
  // any err → err; any warn (and no err) → warn.
  let badgeState = "ok";
  for (const r of results) {
    if (r.state === "err") { badgeState = "err"; break; }
    if (r.state === "warn") badgeState = "warn";
  }
  const badgeText = badgeState === "ok"
    ? (results.length === 1 ? "verified" : "chain verified · " + results.length)
    : badgeState === "err" ? "tampered" : "unverified";
  setBadge(badge, badgeState, badgeText);

  // Always make the badge clickable so a curious recipient can see
  // the full chain breakdown — even when there's only one entry.
  badge.classList.add("clickable");
  badge.setAttribute("role", "button");
  badge.setAttribute("tabindex", "0");
  const open = () => openModal(results);
  badge.addEventListener("click", open);
  badge.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
  });
})();

function readCurrentClaim() {
  const sub = meta("wb-author-sub");
  const email = meta("wb-author-email");
  const keyId = meta("wb-author-key-id");
  const ts = meta("wb-claim-ts");
  const sig = meta("wb-author-sig");
  const workbookId = meta("wb-workbook-id");
  const name = meta("wb-author-name");
  if (!sub || !email || !keyId || !ts || !sig || !workbookId) return null;
  return {
    author_sub: sub,
    author_email: email,
    author_name: name ?? null,
    key_id: keyId,
    ts: Number(ts),
    workbook_id: workbookId,
    sig,
  };
}

async function verifyOne(broker, claim, keysCache) {
  try {
    let keys = keysCache.get(claim.author_sub);
    if (!keys) {
      const r = await fetch(broker + "/v1/authors/" + encodeURIComponent(claim.author_sub) + "/keys");
      if (!r.ok) {
        return { ...claim, state: "warn", reason: "verify failed" };
      }
      const j = await r.json();
      keys = j.keys || [];
      keysCache.set(claim.author_sub, keys);
    }
    const key = keys.find((k) => k.id === claim.key_id);
    if (!key) {
      return { ...claim, state: "err", reason: "key not found", keyFingerprint: null };
    }
    const pubkeyBytes = b64uToBytes(key.pubkey);
    const cryptoKey = await crypto.subtle.importKey(
      "raw", pubkeyBytes, { name: "Ed25519" }, false, ["verify"],
    );
    const msg = canonicalClaimBytes({
      author_sub: claim.author_sub,
      author_email: claim.author_email,
      workbook_id: claim.workbook_id,
      key_id: claim.key_id,
      ts: claim.ts,
    });
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" }, cryptoKey, b64uToBytes(claim.sig), msg,
    );
    return {
      ...claim,
      state: ok ? "ok" : "err",
      reason: ok ? "verified" : "tampered",
      keyFingerprint: await sha256Prefix(pubkeyBytes),
    };
  } catch (e) {
    return { ...claim, state: "warn", reason: "verify failed" };
  }
}

async function sha256Prefix(bytes) {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(buf).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex;
}

function openModal(entries) {
  const list = document.getElementById("wb-chain");
  list.innerHTML = "";
  // Render in the order they appear: current first, prior chain in
  // the order the wb-claim-chain meta provided (oldest → newest, or
  // however the re-sealer composed it).
  for (const e of entries) {
    const div = document.createElement("div");
    div.className = "chain-entry";
    const who = document.createElement("p");
    who.className = "who";
    who.textContent = e.author_name
      ? e.author_name + " <" + e.author_email + ">"
      : e.author_email;
    div.appendChild(who);
    const when = document.createElement("p");
    when.className = "when";
    when.textContent = new Date(e.ts * 1000).toISOString().slice(0, 19) + "Z" +
                       (e.label === "prior" ? " · prior author" : "");
    div.appendChild(when);
    if (e.keyFingerprint) {
      const fp = document.createElement("p");
      fp.className = "keyfp";
      fp.textContent = "key " + e.keyFingerprint + "…";
      div.appendChild(fp);
    }
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.dataset.state = e.state;
    badge.textContent = e.reason;
    div.appendChild(badge);
    list.appendChild(div);
  }
  document.getElementById("wb-modal-backdrop").classList.add("open");
  document.getElementById("wb-modal").classList.add("open");
}
function closeModal() {
  document.getElementById("wb-modal-backdrop").classList.remove("open");
  document.getElementById("wb-modal").classList.remove("open");
}
document.getElementById("wb-modal-backdrop").addEventListener("click", closeModal);
document.getElementById("wb-modal-close").addEventListener("click", closeModal);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

function setBadge(el, state, text) {
  el.dataset.state = state;
  el.textContent = text;
}
function b64uToBytes(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function canonicalClaimBytes(claim) {
  // Same canonical-JSON algorithm wrapStudio used at sign time:
  // sorted keys, default separators. Must match the signer exactly.
  const ordered = {};
  for (const k of Object.keys(claim).sort()) ordered[k] = claim[k];
  return new TextEncoder().encode(JSON.stringify(ordered));
}
</script>
</body>
</html>
`;

/**
 * Wrap a workbook HTML body into a studio-v1 envelope.
 *
 * Inputs:
 *   html        — utf-8 string, the cleartext workbook to seal
 *   brokerUrl   — absolute https URL of the broker
 *   policy      — policy object; will be canonicalized + hashed
 *   title       — optional title shown on the lock screen
 *   workbookId  — optional explicit id (default: fresh UUIDv7-shape)
 *
 * Output:
 *   { html, workbookId, policyHash, views: [{id, dek (base64url)}] }
 *
 * The caller is responsible for registering each (workbookId, viewId,
 * dek) tuple with the broker via POST /v1/workbooks/:id/views/:view_id/key
 * before distributing the sealed file. The DEK never persists on disk
 * outside this function's return value — once registered, the caller
 * should drop it.
 */
/**
 * Wrap one or more workbook view payloads into a single studio-v1
 * envelope.
 *
 * Two input shapes accepted (C2 multi-view):
 *
 *   1. Single view (legacy / C1 shape):
 *        wrapStudio({ html: "...", policy, ... })
 *      Wraps a single view with id="default". Equivalent to passing
 *      `{ views: { default: html } }`.
 *
 *   2. Multi-view (C2):
 *        wrapStudio({ views: { full: htmlA, redacted: htmlB }, policy, ... })
 *      Each view is encrypted under its own freshly-generated DEK.
 *      The policy.views object should enumerate the same view ids
 *      (one per content variant the author wants to gate
 *      independently). Recipients unlock only the views their policy
 *      claims permit; the rest stay encrypted in the payload.
 *
 * Per-view ciphertext is concatenated into a single payload blob; the
 * `wb-views` meta tag carries (offset, len) descriptors so the
 * daemon / browser fallback can extract each view's bytes.
 *
 * Author responsibilities: register each (workbookId, viewId, dek)
 * tuple with the broker via POST /v1/workbooks/:id/views/:view_id/key
 * before distributing the sealed file. DEKs never persist outside
 * this function's return value — drop them after registration.
 */
/**
 * Canonical-JSON bytes a signer commits to for an author claim.
 * Exported so the daemon (Rust signer, see core-5ah.10) and any other
 * tool implementing C8 signing produces a byte-exact match.
 *
 * Layout: keys sorted alphabetically, default JSON separators, no
 * whitespace. Must match the in-browser verifier's reconstruction
 * (see `canonicalClaimBytes` inside the SHELL script). If the signer
 * commits to a different byte string, in-browser verification will
 * deterministically reject — visible "tampered" badge over silent pass.
 */
export function canonicalClaimBytes(claim) {
  const ordered = {};
  for (const k of Object.keys(claim).sort()) ordered[k] = claim[k];
  return new TextEncoder().encode(JSON.stringify(ordered));
}

export async function wrapStudio({
  html,
  views,
  brokerUrl,
  policy,
  title = "Sealed workbook",
  workbookId = newWorkbookId(),
  claim,
  claimSig,
  priorChain,
}) {
  if (typeof brokerUrl !== "string" || !brokerUrl.startsWith("https://")) {
    throw new Error("wrapStudio: brokerUrl must be an https:// URL");
  }
  if (!policy || typeof policy !== "object") {
    throw new Error("wrapStudio: policy must be an object");
  }

  // Normalize the two input shapes into a single map of viewId →
  // utf8 bytes. Single-view path stays C1-compatible.
  let viewMap;
  if (views !== undefined) {
    if (typeof views !== "object" || views === null || Array.isArray(views)) {
      throw new Error("wrapStudio: views must be an object map of viewId → html string");
    }
    if (Object.keys(views).length === 0) {
      throw new Error("wrapStudio: views map cannot be empty");
    }
    viewMap = {};
    for (const [id, body] of Object.entries(views)) {
      if (typeof body !== "string" || body.length === 0) {
        throw new Error(`wrapStudio: views.${id} must be a non-empty string`);
      }
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        throw new Error(
          `wrapStudio: view id ${JSON.stringify(id)} must be 1–64 chars [A-Za-z0-9_-]`,
        );
      }
      viewMap[id] = new TextEncoder().encode(body);
    }
  } else {
    if (typeof html !== "string" || html.length === 0) {
      throw new Error("wrapStudio: html must be a non-empty string when views is not provided");
    }
    viewMap = { default: new TextEncoder().encode(html) };
  }

  // Cross-check: when the policy enumerates views, the author MUST
  // provide content for every view listed (or skip the policy.views
  // listing entirely if all views share the same gating). This catches
  // the easy mistake of "I declared a `redacted` view in policy but
  // forgot to provide its content," which would otherwise silently
  // ship a workbook where the redacted view is missing.
  if (policy.views && typeof policy.views === "object") {
    for (const viewId of Object.keys(policy.views)) {
      if (!(viewId in viewMap)) {
        throw new Error(
          `wrapStudio: policy.views.${viewId} declared but no content provided for that view`,
        );
      }
    }
  }

  const policyHash = await hashPolicy(policy);
  const viewIds = Object.keys(viewMap);

  // Encrypt each view under its own DEK. We assemble the payload by
  // concatenating ciphertexts in the order the author passed them;
  // the descriptor records each view's offset+len so the parser can
  // slice cleanly without depending on order.
  const viewsDescriptor = [];
  const dekRecords = [];
  const ciphertextChunks = [];
  let offset = 0;
  for (const viewId of viewIds) {
    const plaintext = viewMap[viewId];
    const { dek, iv, ciphertext, mac } = await encryptView({
      plaintext,
      workbookId,
      viewId,
      policyHash,
    });
    viewsDescriptor.push({
      id: viewId,
      iv: bytesToBase64Url(iv),
      offset,
      len: ciphertext.length,
      mac: bytesToBase64Url(mac),
    });
    dekRecords.push({ id: viewId, dek: bytesToBase64Url(dek) });
    ciphertextChunks.push(ciphertext);
    offset += ciphertext.length;
  }

  // Concatenate.
  const payloadBytes = new Uint8Array(offset);
  let writePos = 0;
  for (const chunk of ciphertextChunks) {
    payloadBytes.set(chunk, writePos);
    writePos += chunk.length;
  }
  const payloadB64 = bytesToBase64(payloadBytes);

  // C8 — author claim. Optional. When `claim` is supplied, embed
  // identity meta tags and the visible "sealed by" block. When
  // `claimSig` is also supplied, embed it as `wb-author-sig` so the
  // shell script can verify against the broker's pubkey list. The
  // signer (workbooksd, see core-5ah.10) is responsible for using
  // canonicalClaimBytes() above to produce the bytes it signed.
  //
  // C8.6 — priorChain carries every author-claim that's been signed
  // before the current one. Each entry is the same shape as the
  // current claim plus its own .sig. The shell verifier walks the
  // chain in order; the modal renders every entry's status.
  // Emitted as base64url-encoded JSON in `wb-claim-chain`.
  let claimMeta = "";
  let claimBlock = "";
  if (claim) {
    const required = ["author_sub", "author_email", "key_id", "ts"];
    for (const k of required) {
      if (claim[k] === undefined || claim[k] === null || claim[k] === "") {
        throw new Error(`wrapStudio: claim.${k} is required when claim is provided`);
      }
    }
    if (typeof claim.ts !== "number" || !Number.isFinite(claim.ts)) {
      throw new Error("wrapStudio: claim.ts must be a finite number (unix seconds)");
    }
    const metaParts = [
      `<meta name="wb-author-sub" content="${htmlEscape(claim.author_sub)}">`,
      `<meta name="wb-author-email" content="${htmlEscape(claim.author_email)}">`,
      `<meta name="wb-author-key-id" content="${htmlEscape(claim.key_id)}">`,
      `<meta name="wb-claim-ts" content="${htmlEscape(String(claim.ts))}">`,
    ];
    if (claim.author_name) {
      metaParts.push(
        `<meta name="wb-author-name" content="${htmlEscape(claim.author_name)}">`,
      );
    }
    if (claimSig) {
      if (typeof claimSig !== "string" || !/^[A-Za-z0-9_-]+$/.test(claimSig)) {
        throw new Error("wrapStudio: claimSig must be a base64url string");
      }
      metaParts.push(
        `<meta name="wb-author-sig" content="${htmlEscape(claimSig)}">`,
      );
    }
    // C8.6 — append the prior provenance chain if present. Each entry
    // is a previously-signed claim (same shape as the current claim).
    // We base64url(JSON) it into a single meta tag rather than a stream
    // of per-entry tags — keeps the meta surface tidy and lets the
    // shell parse with one atob.
    if (priorChain !== undefined) {
      if (!Array.isArray(priorChain)) {
        throw new Error("wrapStudio: priorChain must be an array of signed claims");
      }
      const required = ["author_sub", "author_email", "key_id", "ts", "workbook_id", "sig"];
      for (let i = 0; i < priorChain.length; i++) {
        const e = priorChain[i];
        if (typeof e !== "object" || e === null) {
          throw new Error(`wrapStudio: priorChain[${i}] must be an object`);
        }
        for (const k of required) {
          if (e[k] === undefined || e[k] === null || e[k] === "") {
            throw new Error(`wrapStudio: priorChain[${i}].${k} is required`);
          }
        }
        if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) {
          throw new Error(`wrapStudio: priorChain[${i}].ts must be a finite number`);
        }
      }
      const json = JSON.stringify(priorChain);
      const b64u = Buffer.from(json, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      metaParts.push(
        `<meta name="wb-claim-chain" content="${b64u}">`,
      );
    }
    claimMeta = "\n" + metaParts.join("\n");

    const tsIso = new Date(claim.ts * 1000).toISOString().slice(0, 19) + "Z";
    const senderLine = claim.author_name
      ? `${htmlEscape(claim.author_name)} <span style="color:var(--fg-mute)">&lt;${htmlEscape(claim.author_email)}&gt;</span>`
      : htmlEscape(claim.author_email);
    // Initial badge state: "checking" if a signature was supplied
    // (script will flip to ok/warn/err); "unverified" otherwise.
    const initialState = claimSig ? "warn" : "warn";
    const initialText = claimSig ? "checking" : "unverified";
    claimBlock = `<div class="claim">
<p class="claim-row"><span class="claim-label">Sealed by</span><span class="claim-value">${senderLine}</span></p>
<p class="claim-row"><span class="claim-label">Sealed at</span><span class="claim-value">${htmlEscape(tsIso)}</span></p>
<p class="claim-row"><span class="claim-label">Trust</span><span class="claim-value"><span id="wb-claim-badge" class="badge" data-state="${initialState}">${initialText}</span></span></p>
</div>
`;
  }

  const out = SHELL.replace(/%%TITLE%%/g, htmlEscape(title))
    .replace(/%%WORKBOOK_ID%%/g, htmlEscape(workbookId))
    .replace(/%%BROKER_URL%%/g, htmlEscape(brokerUrl))
    .replace(/%%POLICY_HASH%%/g, htmlEscape(policyHash))
    .replace(/%%VIEWS_JSON%%/g, htmlEscape(JSON.stringify(viewsDescriptor)))
    .replace(/%%CLAIM_META%%/g, claimMeta)
    .replace(/%%CLAIM_BLOCK%%/g, claimBlock)
    .replace(/%%PAYLOAD_B64%%/g, payloadB64);

  return {
    html: out,
    workbookId,
    policyHash,
    views: dekRecords,
  };
}

/**
 * Parse an envelope's meta tags and view descriptors out of an HTML
 * string. Returns null if the file isn't a studio-v1 envelope.
 */
export function parseEnvelope(html) {
  const meta = (name) => {
    const m = new RegExp(
      `<meta\\s+name=["']${name}["']\\s+content=(['"])(.+?)\\1`,
      "i",
    ).exec(html);
    return m ? m[2] : null;
  };
  const encryption = meta("wb-encryption");
  if (encryption !== "studio-v1") return null;
  const workbookId = meta("wb-workbook-id");
  const brokerUrl = meta("wb-broker-url");
  const policyHash = meta("wb-policy-hash");
  const cipher = meta("wb-cipher");
  const viewsRaw = meta("wb-views");
  if (!workbookId || !brokerUrl || !policyHash || !cipher || !viewsRaw) {
    return null;
  }
  let views;
  try {
    views = JSON.parse(viewsRaw.replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
  } catch {
    return null;
  }
  const payloadMatch =
    /<script[^>]*id=["']wb-payload["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  const payloadB64 = payloadMatch ? payloadMatch[1].trim() : null;
  return {
    encryption,
    workbookId,
    brokerUrl,
    policyHash,
    cipher,
    views,
    payloadB64,
  };
}

/** Helper for the inspect / unseal commands — decode the base64 payload
 *  back to bytes. */
export function decodePayload(payloadB64) {
  return new Uint8Array(Buffer.from(payloadB64, "base64"));
}

export { bytesToBase64Url, base64UrlToBytes, hashPolicy };
