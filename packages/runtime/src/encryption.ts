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
    addRecipient(s: string | object): void;
    encrypt(data: Uint8Array): Promise<Uint8Array>;
  };
  Decrypter: new () => {
    addPassphrase(p: string): void;
    addIdentity(s: string | object | CryptoKey): void;
    decrypt(data: Uint8Array): Promise<Uint8Array>;
  };
  generateIdentity: () => Promise<string>;
  identityToRecipient: (identity: string | CryptoKey) => Promise<string>;
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

/** Lazy-load the webauthn submodule from age-encryption (Phase B).
 *  Browser-only: WebAuthn isn't available in Node. */
async function loadAgeWebAuthn(): Promise<{
  createCredential: (opts: {
    keyName: string;
    type?: "passkey" | "security-key";
    rpId?: string;
  }) => Promise<string>;
  WebAuthnRecipient: new (opts?: { identity?: string; rpId?: string }) => object;
  WebAuthnIdentity: new (opts?: { identity?: string; rpId?: string }) => object;
}> {
  const specifier = "age-encryption/webauthn";
  try {
    return (await import(/* @vite-ignore */ specifier)) as never;
  } catch {
    // Subpath export may not be configured in older typage; fall back to
    // the umbrella module's `webauthn` namespace.
    const mod = (await loadAge()) as unknown as { webauthn?: never };
    if (mod && (mod as { webauthn?: object }).webauthn) {
      return (mod as { webauthn: never }).webauthn as never;
    }
    throw new Error(
      "age-encryption/webauthn is unavailable. Phase B (WebAuthn PRF) " +
        "requires age-encryption ^0.2 in a browser context.",
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

/**
 * Generate a fresh X25519 keypair as age-format strings (Phase D).
 *
 *   identity   — `AGE-SECRET-KEY-1...`  (KEEP THIS PRIVATE — it decrypts)
 *   recipient  — `age1...`              (publish; encrypt-to-this gives the
 *                                        holder of the matching identity
 *                                        the ability to decrypt)
 *
 * Use this at build time (CLI keygen --type x25519) or at runtime to mint
 * an ephemeral keypair for sharing. age's X25519 mode is non-interactive:
 * no key exchange round-trip is needed at encrypt-time.
 */
export async function generateX25519Identity(): Promise<{
  identity: string;
  recipient: string;
}> {
  const { generateIdentity, identityToRecipient } = await loadAge();
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  return { identity, recipient };
}

/**
 * Encrypt to one or more recipients (Phase D — multi-recipient).
 *
 * Recipients can be:
 *   - X25519 strings (`age1...`)
 *   - WebAuthn-PRF recipient objects (Phase B — pass an instance of the
 *     WebAuthn recipient class via `objectRecipients`)
 *
 * Optionally combine with a passphrase: any single recipient OR the
 * passphrase will unlock the file. (age stores one stanza per recipient
 * type in the header; the body is encrypted once with a random file key
 * that each recipient stanza wraps independently.)
 *
 * Use cases:
 *   - Share a CSV with three teammates → pass three `age1...` strings.
 *   - Share with a teammate AND the build pipeline → pass their pubkey
 *     + a passphrase that lives in CI's secret store.
 *   - Per-author signing key + per-user WebAuthn unlock (Phase B + D
 *     combined).
 *
 * Throws if neither recipients nor passphrase is provided.
 */
export interface EncryptOptions {
  /** X25519 recipient strings (`age1...`). Empty array allowed if a
   *  passphrase or objectRecipient is supplied. */
  recipients?: string[];
  /** Recipient objects for non-string recipient types (WebAuthn PRF,
   *  custom plugins). Created via webauthn.WebAuthnRecipient or other
   *  Recipient implementations. */
  objectRecipients?: object[];
  /** Optional symmetric passphrase. If provided alongside recipients,
   *  any of them can unlock the file. */
  passphrase?: string;
}

export async function encryptToRecipients(
  plaintext: Uint8Array,
  opts: EncryptOptions,
): Promise<Uint8Array> {
  const recips = opts.recipients ?? [];
  const objectRecips = opts.objectRecipients ?? [];
  const hasRecip = recips.length > 0 || objectRecips.length > 0;
  if (!hasRecip && !opts.passphrase) {
    throw new Error(
      "encryptToRecipients: at least one recipient or a passphrase is required",
    );
  }
  if (opts.passphrase && hasRecip) {
    // typage 0.2 forbids mixing setPassphrase with addRecipient and
    // doesn't expose ScryptRecipient publicly (its package.json only
    // exports `./dist/index.js`), so we can't synthesize the
    // combined-mode envelope cleanly. Surface the limitation rather
    // than silently dropping one of the unlock paths. age itself
    // supports the combination — bumping age-encryption past 0.2 (or
    // patching it to re-export ScryptRecipient) lifts this.
    throw new Error(
      "encryptToRecipients: combining passphrase + recipients is not " +
        "supported with age-encryption 0.2. Pick one or upgrade typage.",
    );
  }
  const { Encrypter } = await loadAge();
  const e = new Encrypter();
  if (opts.passphrase) e.setPassphrase(opts.passphrase);
  for (const r of recips) e.addRecipient(r);
  for (const r of objectRecips) e.addRecipient(r);
  return e.encrypt(plaintext);
}

/**
 * Decrypt with an X25519 identity (Phase D).
 *
 * Counterpart to `encryptToRecipients`. The identity string is the
 * `AGE-SECRET-KEY-1...` form returned by `generateX25519Identity`.
 *
 * Throws if the file isn't decryptable by this identity (i.e. the
 * identity wasn't a recipient, OR the file is corrupt). The error
 * message is generic on purpose — leaking "this identity matched but
 * decrypt failed" vs. "this identity didn't match" creates an oracle.
 */
export async function decryptWithIdentity(
  ciphertext: Uint8Array,
  identity: string,
): Promise<Uint8Array> {
  if (!identity) {
    throw new Error("decryptWithIdentity: identity is required");
  }
  const { Decrypter } = await loadAge();
  const d = new Decrypter();
  d.addIdentity(identity);
  return d.decrypt(ciphertext);
}

/**
 * Decrypt with a structured Identity object (Phase B — WebAuthn PRF).
 *
 * For browser-side WebAuthn unlock, instantiate
 * `webauthn.WebAuthnIdentity({ identity })` (the AGE-PLUGIN-FIDO2PRF-1
 * string from createCredential) and pass it here. The browser will
 * surface its passkey UI; on user confirmation, age's PRF stanza is
 * unwrapped via the credential's PRF output.
 */
export async function decryptWithObjectIdentity(
  ciphertext: Uint8Array,
  identity: object,
): Promise<Uint8Array> {
  const { Decrypter } = await loadAge();
  const d = new Decrypter();
  d.addIdentity(identity);
  return d.decrypt(ciphertext);
}

/**
 * Phase B helper — register a new WebAuthn credential with PRF.
 * Returns the AGE-PLUGIN-FIDO2PRF-1 identity string. Persist it next
 * to the encrypted block (or in localStorage); pass it back via
 * `WebAuthnIdentity({ identity })` to unlock.
 *
 * Browser-only. Throws if WebAuthn isn't available or the PRF
 * extension is unsupported by the authenticator.
 */
export async function createWebAuthnCredential(opts: {
  keyName: string;
  type?: "passkey" | "security-key";
  rpId?: string;
}): Promise<string> {
  const { createCredential } = await loadAgeWebAuthn();
  return createCredential(opts);
}

/**
 * Phase B helper — construct a WebAuthn-PRF Recipient. Pass to
 * `encryptToRecipients` via `objectRecipients`. Browser-only.
 */
export async function buildWebAuthnRecipient(opts?: {
  identity?: string;
  rpId?: string;
}): Promise<object> {
  const { WebAuthnRecipient } = await loadAgeWebAuthn();
  return new WebAuthnRecipient(opts);
}

/**
 * Phase B helper — construct a WebAuthn-PRF Identity. Pass to
 * `decryptWithObjectIdentity` (or `Decrypter.addIdentity` directly).
 * Browser-only; the unwrap path triggers the WebAuthn assertion UI.
 */
export async function buildWebAuthnIdentity(opts?: {
  identity?: string;
  rpId?: string;
}): Promise<object> {
  const { WebAuthnIdentity } = await loadAgeWebAuthn();
  return new WebAuthnIdentity(opts);
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
