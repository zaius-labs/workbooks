// Take a fully-built workbook HTML, encrypt it, and wrap in a lock
// screen that decrypts back to the original on correct unlock.
//
// `--encrypt-scope=full` (the only scope shipped in v1) means: the
// runtime, the user code, the spec, the data — everything in the
// HTML body — gets sealed. Only the lock screen + the inlined
// decryptor JS are plaintext on disk.

import { getDecryptorBundle } from "./buildDecryptor.mjs";

/** Lock-screen template. Placeholders are replaced by `wrapEncrypted`.
 *  Keep this lean — a CSP `default-src 'self'` doesn't allow
 *  external resources, and we want this to load instantly. */
const SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%%TITLE%%</title>
<style>
:root{--fg:#0f1115;--fg-soft:#4b5160;--fg-mute:#8a909c;--bg:#fbfbf9;--rule:#e7e6e2;--bad:#ef4444;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--serif:"Iowan Old Style","Charter","Source Serif Pro",Georgia,serif;--sans:-apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font-family:var(--sans);-webkit-font-smoothing:antialiased}
main{max-width:380px;width:100%;padding:32px}
.kicker{font-family:var(--mono);font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--fg-mute);margin:0 0 12px}
h1{font-family:var(--serif);font-size:28px;font-weight:600;letter-spacing:-.02em;margin:0 0 8px;line-height:1.15}
.lede{color:var(--fg-soft);font-size:13px;line-height:1.55;margin:0 0 24px}
form{display:flex;flex-direction:column;gap:8px}
input{padding:10px 12px;border:1px solid var(--rule);border-radius:6px;background:#fff;font-family:var(--mono);font-size:13px;outline:none;color:var(--fg)}
input:focus{border-color:var(--fg)}
button{padding:10px 16px;background:var(--fg);color:#fff;border:0;border-radius:6px;font-size:13px;font-weight:500;letter-spacing:.02em;cursor:pointer}
button:hover{background:#1a1d24}
button:disabled{opacity:.5;cursor:wait}
.error{color:var(--bad);font-size:12px;margin:6px 0 0}
.foot{margin-top:24px;font-size:11px;color:var(--fg-mute);font-family:var(--mono);letter-spacing:.02em}
.foot a{color:inherit}
</style>
</head>
<body>
<main>
<p class="kicker">encrypted workbook</p>
<h1>%%TITLE%%</h1>
<p class="lede">This workbook is sealed. Enter the passphrase to unlock — decryption happens entirely in your browser; nothing leaves the page.</p>
<form id="wb-unlock-form">
<input type="password" id="wb-passphrase" placeholder="passphrase" required autocomplete="current-password" autofocus>
<button type="submit">unlock</button>
<p id="wb-error" class="error" hidden></p>
</form>
<p class="foot">age-v1 · scrypt + chacha20-poly1305</p>
</main>
<script id="wb-cipher" type="application/octet-stream">%%CIPHER_B64%%</script>
<script>%%DECRYPTOR_JS%%</script>
</body>
</html>
`;

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString("base64");
}

/**
 * Wrap a fully-built HTML string in the encryption shell.
 *
 * @param {Object} args
 * @param {string} args.html        the plaintext .html bytes
 * @param {string} args.passphrase  unlock passphrase
 * @param {string} args.title       displayed on the lock screen
 * @returns {Promise<string>}       the wrapped HTML, ready to write
 */
export async function wrapEncrypted({ html, passphrase, title }) {
  if (!passphrase) throw new Error("wrapEncrypted: passphrase required");

  // Lazy-import age so workbook-cli still loads when encryption isn't used.
  const { Encrypter } = await import("age-encryption");
  const enc = new Encrypter();
  enc.setPassphrase(passphrase);
  const plaintext = new TextEncoder().encode(html);
  const cipher = await enc.encrypt(plaintext);

  const decryptorJs = await getDecryptorBundle();

  // Two-step replacement so user-supplied title can't smuggle markup
  // and the decryptor JS / cipher (which may contain $ etc.) doesn't
  // interact with the regex replacer.
  let out = SHELL.replace(/%%TITLE%%/g, htmlEscape(title));
  out = out.replace("%%CIPHER_B64%%", bytesToBase64(cipher));
  out = out.replace("%%DECRYPTOR_JS%%", decryptorJs);
  return out;
}
