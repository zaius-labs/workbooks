/**
 * age-format encryption helpers for `<wb-data encryption="age-v1">`
 * blocks. (Closes part of #39 Phase A.)
 *
 * We adopt the [age encryption format](https://github.com/FiloSottile/age)
 * as the canonical envelope rather than rolling our own:
 *
 *   - small explicit keys, no config options
 *   - multi-recipient as a first-class primitive (passphrase + X25519
 *     pubkeys; same envelope unlocks via any recipient)
 *   - chunked streaming encryption (handles large files without
 *     loading everything in memory)
 *   - third-party-audited, formal spec, multiple interop'ing
 *     implementations across languages
 *
 * Phase A (this module) supports passphrase recipients only via the
 * `age-encryption` JS package (TypeScript port maintained by age's
 * author, ~50 KB, uses WebCrypto + noble crypto). Phase B adds
 * WebAuthn PRF as a second unlock path (see #43); Phase C adds
 * Ed25519 signing (#44); Phase D adds X25519 multi-recipient
 * sharing (#45); Phase E swaps to wage (Rust→WASM age) so plaintext
 * stays in WASM linear memory (#46).
 *
 * The functions here are usable both at runtime (resolver decrypts
 * a block on mount) and at build time (CLI encrypts a CSV before
 * inlining into a `<wb-data>` body).
 */

/** Tag value the `<wb-data encryption=...>` attribute should carry
 *  for blocks produced + consumed by these helpers. Bumping the
 *  version is how we'd add a new envelope shape later without
 *  breaking existing files. */
export const AGE_ENCRYPTION_TAG = "age-v1";

/** Lazy-load age-encryption. The package is an optional peer dep —
 *  workbooks that never use encryption shouldn't pay its cost.
 *  Throws a clear error if the package isn't installed. */
async function loadAge(): Promise<{
  Encrypter: new () => {
    setPassphrase(p: string): void;
    encrypt(data: Uint8Array): Promise<Uint8Array>;
  };
  Decrypter: new () => {
    addPassphrase(p: string): void;
    decrypt(data: Uint8Array): Promise<Uint8Array>;
  };
}> {
  // Variable specifier so TS doesn't try to resolve the optional
  // peer at compile time.
  const specifier = "age-encryption";
  try {
    return (await import(/* @vite-ignore */ specifier)) as never;
  } catch {
    throw new Error(
      "age-encryption peer dep is missing. Install it with " +
        "`npm install age-encryption` (or pre-bundle in your workbook host).",
    );
  }
}

/**
 * Encrypt `plaintext` with a passphrase, producing age-format
 * ciphertext bytes. Use this at build time when authoring an
 * encrypted `<wb-data>` block:
 *
 *   const cipher = await encryptWithPassphrase(csvBytes, "hunter2");
 *   const body = btoa(String.fromCharCode(...cipher));
 *   // <wb-data id="orders" mime="text/csv" encryption="age-v1"
 *   //          encoding="base64" sha256="...">{body}</wb-data>
 *
 * The `sha256` attribute on the block should attest to the PLAINTEXT,
 * not the ciphertext — that gives the resolver a way to verify the
 * decrypted payload matches what the author intended even if the
 * ciphertext was tampered. (age also has its own auth tags but the
 * sha256 is end-to-end across decompression too.)
 */
export async function encryptWithPassphrase(
  plaintext: Uint8Array,
  passphrase: string,
): Promise<Uint8Array> {
  if (!passphrase) {
    throw new Error("encryptWithPassphrase: passphrase is required");
  }
  const { Encrypter } = await loadAge();
  const e = new Encrypter();
  e.setPassphrase(passphrase);
  return e.encrypt(plaintext);
}

/**
 * Decrypt age-format ciphertext with a passphrase. Symmetric counterpart
 * to encryptWithPassphrase. Used by the runtime resolver when an
 * encrypted block is encountered.
 *
 * Throws on wrong passphrase, malformed envelope, or auth-tag failure
 * (age uses ChaCha20-Poly1305 internally; tag mismatch = tamper).
 */
export async function decryptWithPassphrase(
  ciphertext: Uint8Array,
  passphrase: string,
): Promise<Uint8Array> {
  if (!passphrase) {
    throw new Error("decryptWithPassphrase: passphrase is required");
  }
  const { Decrypter } = await loadAge();
  const d = new Decrypter();
  d.addPassphrase(passphrase);
  return d.decrypt(ciphertext);
}

/** True if the bytes start with the age v1 magic header. Cheap
 *  pre-check before invoking the decrypter — lets us surface a
 *  clearer "not an age envelope" error than the parser's own. */
export function looksLikeAgeEnvelope(bytes: Uint8Array): boolean {
  // age v1 files start with "age-encryption.org/v1\n"
  const MAGIC = "age-encryption.org/v1";
  if (bytes.byteLength < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) return false;
  }
  return true;
}
