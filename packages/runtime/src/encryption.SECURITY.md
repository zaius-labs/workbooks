# Security model — `<wb-data encryption="age-v1">`

What's protected, what's not, and what hardens later phases close.

## What Phase A protects

The `age-v1` encryption tag uses [age](https://github.com/FiloSottile/age)'s
passphrase-recipient mode (`scrypt` for KDF + `ChaCha20-Poly1305` AEAD
in 64 KB chunks). Properties verified by the `security-test.mjs`
adversarial harness in this workspace:

- **Wrong passphrase rejected** — age's HMAC over the header fails;
  the chunk keys derived from `scrypt(wrong)` don't authenticate.
- **Tampered ciphertext rejected** — flipping ANY byte in the body
  fails ChaCha20-Poly1305's authentication tag on the affected chunk.
- **Truncation rejected** — chunks are framed; a missing tail fails
  the final-chunk marker check.
- **Header substitution rejected** — the per-chunk symmetric key
  derives from HKDF-Extract over the header HMAC. Substitute the
  header from another encryption (even with the same passphrase)
  and chunk decryption fails.
- **Trailing-byte injection rejected** — age stops at the EOF
  marker; trailing garbage after a valid stream is ignored, and
  decryption produces the original plaintext exactly.
- **Nonce uniqueness** — every encryption draws a fresh scrypt salt
  + nonce from CSPRNG. Identical plaintexts produce different
  ciphertexts; brute-forcing one ciphertext doesn't help with
  another.
- **Empty / zero-length payloads handled correctly** — sentinels
  in the framing.

The `sha256` attribute on the parent `<wb-data>` attests to the
**plaintext** (post-decrypt, pre-decompress). The resolver verifies
it after decryption — so a well-formed-but-wrong-content ciphertext
(e.g. an attacker substitutes their own age-encrypted payload that
happens to decrypt with the user's passphrase if they know it) is
still caught by sha256 mismatch.

## What Phase A does NOT protect

These are real attack surfaces that future phases close. List them
out so consumers can make informed decisions today.

### Plaintext in JS heap — **closed by Phase E (with caveat)**

In the Phase A code path, `decryptWithPassphrase` returns a
`Uint8Array` of plaintext bytes that lives in the JS engine's heap
until garbage collection. That exposes it to:

- A malicious cell that gets JS-execution privilege via XSS in the
  surrounding page
- Browser extensions with content-script access
- Crash dumps / memory snapshots
- DevTools "memory inspector"

**Phase E** (`#46`) adds a Rust-side decrypt path using the `age`
crate compiled to WASM. When the resolver is constructed with
`wasmIsolation: { wasm }`, encrypted blocks decrypt entirely inside
linear memory and the resolver hands back a `WasmPlaintextHandle`
(`{ kind: "wasm-handle", id, bytes, export(), dispose() }`) instead
of a `Uint8Array`. JS only sees the opaque numeric id; the bytes
are stored in a slab-allocated registry inside the WASM module.

Bindings exposed (all backed by Rust in `crypto.rs`):

| Binding | Purpose |
|---|---|
| `ageDecryptToHandle(ciphertext, passphrase)` | Decrypt and store; returns numeric handle id |
| `handleSize(id)` | Length of plaintext (no byte export) |
| `handleSha256(id)` | sha256 of plaintext, computed in Rust, returns hex string |
| `handleExport(id)` | **Escape hatch** — copies plaintext to JS Uint8Array |
| `handleDispose(id)` | Zeroizes bytes and frees the slot (idempotent) |
| `runPolarsSqlIpcHandles(sql, handleMap)` | Runs Polars-SQL where input tables are resolved from handles internally — plaintext never crosses the boundary |

Verified by `security-test.mjs`:

- Decrypt round-trip via handle (size + sha256 match plaintext)
- sha256 verification works without exporting plaintext
- Wrong passphrase rejected from Rust
- Tampered ciphertext rejected from Rust
- `dispose` is idempotent and zeroizes; subsequent ops see size 0
- Disposed slot is reused (slab semantics — bounded memory growth)

**Caveat — escape hatch defeats the property.** `handleExport()`
exists so cells that don't yet support handle inputs (e.g. arbitrary
JS in a `<wb-cell language="js">`) can still consume decrypted bytes.
A cell that calls `handleExport` puts the plaintext back into JS
heap. The architectural property holds for the *analytical query
path* (Polars-SQL → handle in, results out) but not for cells that
opt into the escape hatch. Use `handleExport` sparingly; prefer
the handle-aware path where available.

In Phase A mode (no `wasmIsolation`), behavior is unchanged: the
JS-heap exposure documented above still applies.

### Tamper-detection on `<wb-data>` attributes — **closed by Phase C**

age's auth tag protects ciphertext integrity but does NOT cover the
wrapping `<wb-data>` element's attributes. Phase C adds an Ed25519
signature over the canonical byte sequence:

```
wbdata-sig-v1
id=<id>
mime=<mime>
encryption=<encryption-tag>
sha256=<plaintext sha256>
<ciphertext bytes>
```

Tamper with any attribute (id, mime, encryption tag, sha256) OR
any ciphertext byte → signature fails on verify, decrypt is never
attempted. Surfaced via `pubkey="..."` and `sig="..."` attributes
on `<wb-data>`.

CLI: `workbook encrypt --sign-key-file authorpriv.key`. Generate
keypairs with `workbook keygen --out keys/myauthor`.

### Author-identity verification — **closed by Phase C** (with pinning)

Without pinning: signature proves "this block hasn't been tampered
after authoring" but NOT "the author is who you expect" — an
attacker can substitute their own (pubkey, sig) pair for a
different ciphertext.

With pinning: pass `expectedAuthorPubkey` to
`createWorkbookDataResolver`. The resolver checks the file's pubkey
against the pinned one BEFORE verifying the signature. Mismatch =
"this came from a different signer than expected" — even a valid
signature is rejected.

Phase C also adds `signaturePolicy: "require"` — block any
unsigned `<wb-data encryption=...>` from resolving. Useful in
production where every author is expected to sign.

### Passphrase strength is the user's problem

age's `scrypt` parameters are `N=2^18` work factor — moderate
GPU-resistant cost. A 6-character lowercase passphrase is brute-
forceable (~10⁹ attempts) by a well-resourced adversary in days.

The CLI (`workbook encrypt`) does not enforce passphrase complexity
today. Implementations should warn or require:

- **Min 14 chars** (or use a diceware-style passphrase generator
  like the example in age's docs: 6+ words, ~77 bits entropy)
- Reject obvious dictionary words

### Cached passphrase lives in resolver-instance scope

`createWorkbookDataResolver` caches the passphrase across blocks
in a closure variable. Implications:

- The cache survives until the resolver is GC'd — typically the
  lifetime of the page
- Calling `resolver.clear()` does NOT clear it (only clears the
  result cache). **TODO: add `forgetPassphrase()` API**.
- Any JS code with a reference to the resolver could in principle
  read the closure variable — JS doesn't enforce closure privacy
  cryptographically. (`getPassword` is a function expression but
  the `cachedPassword` variable lives in its enclosing scope.)
- A tab eviction / freeze / restore could re-prompt unexpectedly
  but not leak.

Mitigation in this phase: keep the cache only as long as needed.
**Phase E** moves the cache to WASM-side too.

### `requestPassword` race on concurrent block resolution

If two `<wb-data encryption="age-v1">` blocks resolve in parallel
and the cache is empty, both call `getPassword()` simultaneously.
Without dedup, both would invoke the host's `requestPassword`
callback — surfacing two prompts to the user.

**TODO: dedup `getPassword` via a single in-flight promise.**
Cheap fix; addressed in the next commit.

### Browser-platform residual risks

Out of our control but worth knowing:

- A malicious browser extension can read JS heap (Phase E mitigates
  by keeping plaintext in WASM)
- A keylogger captures the passphrase as the user types it
- A compromised browser process is game-over regardless
- File-system-level attackers (Spotlight, backup software, etc.)
  see the encrypted ciphertext but not the plaintext

### CLI-level residual risks

- `--password <s>` shows in `ps`. Use `--password-stdin` or
  `--password-file <path>` instead. CLI documents this.
- `--password-file` should be 600-permission'd — the CLI does NOT
  check today. **TODO: warn on world-readable.**
- Build pipelines that put the password in environment variables
  may leak it via process inspectors
- Source maps and build logs do not contain the password (the
  encrypted body lands in the output file, the password never
  touches the build pipeline beyond the CLI invocation)

## Future phases that close gaps

| Gap | Phase | Bead | Status |
|---|---|---|---|
| Plaintext in JS heap | E | `#46` | **closed (Phase E shipped, with `handleExport` caveat)** |
| Attribute tamper detection | C | `#44` | **closed (Phase C shipped)** |
| Author identity verification | C | `#44` | **closed via expectedAuthorPubkey pinning** |
| WebAuthn / passkey unlock (replaces passphrase typing) | B | `#43` | open |
| Multi-recipient sharing (encrypt to colleague's pubkey) | D | `#45` | open |
| File-permission check on `--password-file` | A+ | — | open |
| Idle-timeout auto-forget passphrase | A+ | — | open |

## Verifying the property claims

```sh
# From the workbook root:
node --experimental-strip-types security-test.mjs
# Expected: 41 pass / 0 fail
# (29 Phase A+C + 12 Phase E; the Phase E section is auto-skipped if
# packages/runtime-wasm/pkg is not built — run wasm-pack first to exercise it.)
```

The harness exercises every adversarial property documented above.
Run it after any change to `encryption.ts`.
