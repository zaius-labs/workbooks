// Local persistence for the encrypted CSV + the passkey identity that
// unlocks it. Keys are namespaced so two workbooks served from the
// same origin don't clobber each other.
//
// Layout:
//   wb-csv:v1:cipher        base64(age envelope)
//   wb-csv:v1:sha256        plaintext sha256 (verifies decrypt)
//   wb-csv:v1:methods       JSON array of available unlock methods
//                           e.g. ["passphrase", "passkey"]
//   wb-csv:v1:prf-identity  AGE-PLUGIN-FIDO2PRF-1... (passkey id)
//   wb-csv:v1:rp-id         the WebAuthn relying party id
//   wb-csv:v1:filename      original filename (display only)
//   wb-csv:v1:rows          row count (display only — verified on
//                           decrypt)

const NS = "wb-csv:v1:";
const K = {
  cipher: NS + "cipher",
  // When the user picks "passkey + passphrase fallback" we store the
  // SAME plaintext under two envelopes — typage 0.2 doesn't expose
  // ScryptRecipient publicly so we can't merge them into one. The
  // fallback is decrypted via passphrase only.
  cipherFallback: NS + "cipher-fallback",
  sha256: NS + "sha256",
  methods: NS + "methods",
  prfIdentity: NS + "prf-identity",
  rpId: NS + "rp-id",
  filename: NS + "filename",
  rows: NS + "rows",
};

export function vaultExists() {
  return typeof localStorage !== "undefined" && Boolean(localStorage.getItem(K.cipher));
}

export function readVault() {
  if (!vaultExists()) return null;
  return {
    cipher: localStorage.getItem(K.cipher),
    cipherFallback: localStorage.getItem(K.cipherFallback) ?? null,
    sha256: localStorage.getItem(K.sha256),
    methods: JSON.parse(localStorage.getItem(K.methods) ?? "[]"),
    prfIdentity: localStorage.getItem(K.prfIdentity) ?? null,
    rpId: localStorage.getItem(K.rpId) ?? null,
    filename: localStorage.getItem(K.filename) ?? "",
    rows: parseInt(localStorage.getItem(K.rows) ?? "0", 10) || 0,
  };
}

export function writeVault(v) {
  localStorage.setItem(K.cipher, v.cipher);
  if (v.cipherFallback) localStorage.setItem(K.cipherFallback, v.cipherFallback);
  else localStorage.removeItem(K.cipherFallback);
  localStorage.setItem(K.sha256, v.sha256);
  localStorage.setItem(K.methods, JSON.stringify(v.methods));
  if (v.prfIdentity) localStorage.setItem(K.prfIdentity, v.prfIdentity);
  if (v.rpId) localStorage.setItem(K.rpId, v.rpId);
  if (v.filename) localStorage.setItem(K.filename, v.filename);
  if (v.rows != null) localStorage.setItem(K.rows, String(v.rows));
}

export function clearVault() {
  for (const key of Object.values(K)) localStorage.removeItem(key);
}

/** WebAuthn requires a "real" origin. file:// is rejected; localhost
 *  and https: are allowed. Surface this so the setup UI can disable
 *  the passkey option when the user opens the .html from
 *  disk. */
export function passkeyAvailable() {
  if (typeof navigator === "undefined") return false;
  if (!navigator.credentials || !window.PublicKeyCredential) return false;
  // file:// fails before reaching the authenticator.
  if (location.protocol === "file:") return false;
  return true;
}

/** Default RP id derived from the page origin. */
export function defaultRpId() {
  return location.hostname || "localhost";
}
