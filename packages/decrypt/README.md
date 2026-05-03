# @work.books/decrypt

Pure-browser decrypt primitives for sealed Workbooks envelopes. Single source of truth shared by the hosted viewer at `workbooks.sh/w/<id>`, the daemon, and the in-file pre-auth shell.

## Two envelope formats

| Format | Auth | Internet | Use case |
|---|---|---|---|
| `studio-v1` | broker-released DEK, identity-gated (WorkOS or magic-link) | required | Multi-party data clean rooms with policy-gated views |
| `age-v1` | passphrase | **none** | Personal sharing, archival, airgap-after-download |

## Usage

```js
import { parseEnvelope, decryptStudioV1, decryptAgeV1 } from "@work.books/decrypt";

const html = await fetch("/w/abc123").then(r => r.text());
const env = parseEnvelope(html);

if (env.kind === "studio-v1") {
  // Recipient signs in via @work.books/auth-ui → broker /sign-in,
  // gets a bearer, calls broker /v1/workbooks/:id/key with their
  // transport pubkey, broker returns HPKE-sealed DEK, recipient
  // unwraps locally → call decryptStudioV1.
  const cleartext = await decryptStudioV1({ envelope: env, viewId: "default", dek });
} else if (env.kind === "age-v1") {
  // Passphrase prompt; no broker round-trip.
  const cleartext = await decryptAgeV1({ envelope: env, passphrase });
}
```

## Status

v0.1.0 — parser + both decrypt paths shipped. 15 unit assertions exercise round-trips against `wrapStudio` output (studio-v1) and synthetic age-v1 envelopes.

Consumers (current + planned):
- `apps/workbooks-viewer` (C3.2) — hosted viewer at `workbooks.sh/w/<id>`
- `apps/workbooks-daemon` (workbooksd) — eventually replaces `envelope.rs` decrypt logic with a wasm-bridged version of this module
- `vendor/workbooks/packages/workbook-cli/src/encrypt/wrapStudio.mjs` — pre-auth shell SHELL constant; eventually imports parseEnvelope + decryptStudioV1 instead of carrying its own copy
