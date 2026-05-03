// Decryptor source for `--encrypt-scope=full` mode. Bundled (with
// age-encryption inlined) by buildDecryptor.mjs and inlined into the
// shell template at build time.
//
// At runtime this script reads the base64-encoded ciphertext from
// <script id="wb-cipher">, prompts the user for unlock material,
// decrypts via age, and document.write()s the plaintext HTML —
// which then bootstraps the workbook normally.
//
// One unlock path for v1 (passphrase). Multi-unlock (recipient,
// passkey) lands in Step 2.

import { Decrypter } from "age-encryption";

const cipherEl = document.getElementById("wb-cipher");
const formEl = document.getElementById("wb-unlock-form");
const inputEl = document.getElementById("wb-passphrase");
const errEl = document.getElementById("wb-error");
const buttonEl = formEl.querySelector("button");

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  errEl.hidden = true;
  buttonEl.disabled = true;
  inputEl.disabled = true;
  buttonEl.textContent = "unlocking…";

  const passphrase = inputEl.value;
  const cipherB64 = cipherEl.textContent.trim();
  const cipher = Uint8Array.from(atob(cipherB64), (c) => c.charCodeAt(0));

  try {
    const dec = new Decrypter();
    dec.addPassphrase(passphrase);
    const plaintext = await dec.decrypt(cipher);
    const html = new TextDecoder().decode(plaintext);

    // Replace the lock screen with the decrypted workbook. document.write
    // re-parses the HTML stream so inline <script> tags execute, which
    // is exactly what we want — the runtime bootstraps as if the file
    // had been served plaintext.
    document.open();
    document.write(html);
    document.close();
  } catch (_err) {
    errEl.hidden = false;
    errEl.textContent = "incorrect passphrase";
    buttonEl.disabled = false;
    inputEl.disabled = false;
    buttonEl.textContent = "unlock";
    inputEl.select();
  }
});

inputEl.focus();
