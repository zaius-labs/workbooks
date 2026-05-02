# Studio-encrypted workbook format

Specification for `studio-v1` — the envelope format used by Workbooks
Studio for broker-released decryption keys. Companion to (not replacement
for) the existing `age-v1` passphrase format used by `workbook build
--encrypt`.

Spec status: C1 (single view per workbook). Multi-view extensions land
in C2 — see "Forward compatibility" below.

Tracker: `bd show core-1fi.1.3`. Threat model: `SECURITY_MODEL_MULTIPARTY.md`.

## Why a different format from `age-v1`

`age-v1` (the existing passphrase mode) is for the case where the author
shares a secret out-of-band and recipients enter it into a lock screen.
That model breaks down for:

- Sharing across organizations where there's no trusted side-channel
- Per-recipient access policy (passphrases are all-or-nothing)
- Revocation (you can't un-tell someone a passphrase)
- Audit (the file doesn't know who opened it)

`studio-v1` solves these by keeping the wrapping key at a Signal-operated
broker that releases it only to recipients who satisfy a per-workbook
identity policy. The artifact itself is the same shape — an HTML
lock-screen wrapper around an encrypted payload — but the unlock path
goes through the broker instead of through user input.

## Envelope structure

A `studio-v1` workbook is a self-contained HTML file:

```
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="wb-encryption" content="studio-v1">
  <meta name="wb-workbook-id" content="<uuid>">
  <meta name="wb-broker-url" content="https://broker.signal.ml">
  <meta name="wb-policy-hash" content="sha256:<hex>">
  <meta name="wb-cipher" content="aes-256-gcm">
  <meta name="wb-views" content='<json-array>'>
  <title>...</title>
  <style>...lock screen styles...</style>
</head>
<body>
  <main class="locked">...lock screen UI...</main>
  <script type="application/octet-stream" id="wb-payload">
    <base64-encoded ciphertext blocks>
  </script>
  <script type="module" id="wb-decryptor">
    ...decryptor JS — fetches lease from broker, decrypts, swaps body...
  </script>
</body>
</html>
```

## Required meta tags

| Tag | Value | Notes |
|---|---|---|
| `wb-encryption` | `studio-v1` | Format identifier. Daemons / runtimes dispatch on this. |
| `wb-workbook-id` | UUIDv7 | 128-bit random id, base32-encoded. Globally unique. |
| `wb-broker-url` | absolute https URL | Where to fetch leases. Must be `https://`. |
| `wb-policy-hash` | `sha256:<hex>` | Hash of the canonical-JSON policy at registration time. The broker rejects key requests if its current policy hash for this workbook doesn't match — prevents downgrade attacks where an attacker swaps in an older permissive policy. |
| `wb-cipher` | `aes-256-gcm` | AEAD suite. Only AES-256-GCM in v1. |
| `wb-views` | JSON array (see below) | View descriptors. v1 always has exactly one entry; v2 (C2) extends to N. |

## View descriptors

`wb-views` is a JSON-encoded array of view descriptors. In C1 it always
contains exactly one entry. C2 extends the format to N entries with
per-view encryption.

```json
[
  {
    "id": "default",
    "iv": "base64url(12 bytes)",
    "offset": 0,
    "len": 12345,
    "mac": "base64url(16 bytes)"
  }
]
```

| Field | Meaning |
|---|---|
| `id` | View id, scoped to the workbook. `"default"` in C1. |
| `iv` | 96-bit GCM IV, freshly random per view per encryption. |
| `offset` | Byte offset of this view's ciphertext inside the `<script id="wb-payload">` (after base64 decode). |
| `len` | Byte length of this view's ciphertext (excluding the trailing GCM tag). |
| `mac` | The GCM authentication tag, separated for clarity. |

The `<wb-payload>` script content, base64-decoded, is the concatenation
of all view ciphertexts in the order they appear in `wb-views`. C1's
single-view shape always has `offset=0`.

## Cryptographic specification

**Per-view DEK.** 256-bit, generated client-side at encrypt time using
`crypto.getRandomValues`. Never stored at the broker in plaintext.

**Encryption.** AES-256-GCM with 96-bit IV. Associated data (AD) is the
ASCII bytes of the canonical descriptor:

```
studio-v1|<workbook_id>|<view_id>|<policy_hash>
```

Binding to `policy_hash` in the AD means a ciphertext encrypted under
one policy cannot be silently re-claimed under a different policy.

**Wrapping.** Each DEK is wrapped at the broker with the broker's
KEK (held in a separate KMS — see `SECURITY_MODEL_MULTIPARTY.md`).
The CLI calls:

```
POST {broker_url}/v1/workbooks/{id}/views/{view_id}/key
  Authorization: Bearer <author session>
  Content-Type: application/json
  { "dek": "base64(32 bytes)", "policy_hash": "sha256:..." }
```

The broker returns the wrapped DEK ciphertext to be stored alongside
the workbook record (broker-side, not in the file).

**Lease release.** At open time, the recipient's daemon (or browser
fallback) calls:

```
POST {broker_url}/v1/workbooks/{id}/key
  Authorization: Bearer <recipient session>
  Content-Type: application/json
  { "transport_pubkey": "base64(32 bytes, X25519)" }
```

The broker:
1. Validates the session against the WorkOS / magic-link auth
2. Loads policy, evaluates against identity claims
3. Calls KMS to unwrap the DEK(s) for allowed views
4. Re-wraps each DEK under the recipient's transport pubkey (X25519
   sealed box) so the broker's response can't be replayed by an
   eavesdropper or the broker itself can't read the plaintext DEK after
   delivery
5. Issues a signed lease (Ed25519) covering the released keys
6. Writes the audit entry (hash-chained, signed)

## Lock screen behavior

The lock screen shown to users without a daemon is intentionally
minimal — a single "sign in" button that opens the broker auth URL in
a new tab. Once the broker session is established, the page polls a
local return endpoint and triggers the decryption path.

Daemons do not render the lock screen — they parse the meta tags
directly, run the broker auth flow themselves, and serve the decrypted
content over localhost. The lock screen exists for the
no-daemon-installed fallback path (and is wired up in C3, not C1).

## Forward compatibility

The format is designed to admit C2's multi-view extension without a
version bump:

- `wb-views` is already an array — C2 just populates more entries
- Per-view IV, offset, len, mac fields are already present
- The decryptor (C1: defaults to first view; C2: chooses based on the
  views the lease unlocks) reads the same envelope shape

A future `studio-v2` is reserved for changes that *do* break the
envelope layout — e.g., switching to a streaming/chunked payload, or
adding TEE attestation requirements.

## What the format deliberately doesn't do

- **No per-recipient pre-encryption.** All recipients with policy access
  to a view get the same ciphertext. Per-recipient personalization
  happens at lease time (broker re-wraps under the recipient's transport
  key) but the on-disk bytes are uniform. This keeps the artifact
  shareable as a single file.
- **No embedded credentials.** The file never contains DEKs, broker
  API tokens, or recipient identities. Anyone who finds a copy gets
  ciphertext + the broker URL. Without a valid session at the broker
  and a satisfying identity claim, that's useless.
- **No content addressing of the encrypted body.** The `wb-policy-hash`
  binds the encryption to the policy; we deliberately do NOT also bind
  to a hash of the ciphertext, because content-addressing would prevent
  the author from re-encrypting the same content under the same policy
  with fresh IVs (e.g., for paranoid rotation). The MAC + AD provide
  integrity per-view.

## Reference implementation

CLI:
- `workbook seal <input.html> --broker <url> [--out <output>]` — produces
  a `studio-v1` envelope. Prints the workbook id + DEK to stdout (the
  caller is responsible for registering with the broker). C1.3.
- `workbook unseal <input.html> --dek <base64>` — testing-only decrypt.
  Bypasses the broker entirely. C1.3.
- `workbook inspect <input.html>` — read-only metadata view of the
  envelope. C1.3.

Library: `vendor/workbooks/packages/workbook-cli/src/encrypt/wrapStudio.mjs`.

Daemon: `packages/workbooksd` envelope detection lands in C1.8.
