# Multi-party security model — Workbooks Studio C1

Addendum to `SECURITY_MODEL.md`, which covers the single-user, single-machine
threat model. This document extends the model to a multi-party setting where
an encrypted workbook is shared between mutually-untrusting recipients,
identity is verified by a broker, and decryption keys are released only on
verified IdP claims.

Implementation tracker: `bd show core-1fi.1` (Workbooks Studio C1).

## Roles

- **Author** — creates the workbook, defines the policy, encrypts and
  registers it with the broker. Holds no special crypto material after
  registration; can re-key by re-encrypting and re-registering.
- **Recipient** — receives the encrypted artifact, authenticates via SSO
  or magic-link, and runs `workbooksd` locally to open it.
- **Broker** — Signal-operated managed service that holds wrapped DEKs,
  verifies IdP claims, releases keys per policy, and writes the audit log.
  Run by us; we want strong "cannot comply" properties so it isn't a
  subpoena honeypot.
- **IdP** — the recipient's own identity provider (Okta, Azure AD, Google,
  SAML, OIDC) federated via WorkOS. Outside the trust boundary.

## Trust boundary

```
┌──────────┐      ┌──────────┐      ┌──────────┐      ┌────────────┐
│  Author  │─────▶│  Broker  │◀────▶│   IdP    │      │ Recipient  │
│ (CLI)    │ reg  │ (CF Wkr) │ OIDC │ (WorkOS) │      │ (workbooksd│
└──────────┘      └────┬─────┘      └──────────┘      │  + browser)│
                       │                              └─────┬──────┘
                       │   key + lease (over TLS)           │
                       └────────────────────────────────────▶
                       
                       artifact distributed out-of-band (email, link, USB)
```

Trust assumptions, ordered from "most trusted" to "least":
1. **The recipient's own machine and OS keychain.** Same baseline as the
   single-user model in `SECURITY_MODEL.md`.
2. **The recipient's IdP.** If the IdP is compromised, the attacker can
   impersonate any user the IdP authenticates. We accept this — it's the
   customer's IdP, and protecting it is their responsibility.
3. **The TLS fabric and webpki-roots.** Standard.
4. **The broker** — *partial* trust. The broker holds wrapped DEKs and
   evaluates policy. We design so a malicious broker can deny service and
   read metadata, but cannot read workbook content (see "What the broker
   cannot do" below).
5. **WorkOS** — *partial* trust. We rely on WorkOS to faithfully execute
   OIDC flows and surface IdP claims. If WorkOS is compromised, the
   attacker can mint identities; mitigation is to verify the OIDC token
   signature chain at the broker (defense in depth).

The author is *not* in the trust boundary for the recipient — recipients
trust the broker and their own IdP, not the author. This is the property
that makes "send a file to a counterparty" actually work.

## Threat model (extension of SECURITY_MODEL.md)

| Threat | Mitigation | Layer |
|---|---|---|
| Attacker steals the encrypted .workbook.html in transit | Content is AES-256-GCM encrypted; envelope reveals only workbook id + broker URL + view metadata. | format |
| Attacker who is not in the IdP allowlist authenticates and requests the key | Broker evaluates policy against verified OIDC claims; returns 403 + audits the denial. | broker |
| Compromised broker tries to read workbook content | Broker holds wrapped DEKs only; the wrapping key (KEK) lives in a separate KMS the broker cannot exfiltrate keys from, only call. The KMS unwrap call is logged. A rogue broker operator can request an unwrap, but every unwrap is auditable. *Phase 2 (P2 of C1): require recipient public key in the lease request so the broker can't unwrap without the recipient's involvement.* | broker / KMS |
| Subpoena targets the broker | Broker holds: workbook ids, policy, identity-of-accessor, timestamps. Broker does NOT hold: cleartext content, IdP credentials, view payloads. We can produce metadata; we structurally cannot produce content. | broker |
| Subpoena targets the artifact distribution channel (email, R2) | The bytes are ciphertext. Without a valid lease, they decrypt to nothing. R2 storage of artifacts is opt-in (C3) and can be self-hosted. | format |
| Stolen lease replayed by a different recipient | Lease is bound to a recipient session token (HKDF-derived from the OIDC sub claim + a broker-side nonce). Daemon checks the session binding before using the lease. | broker / daemon |
| Recipient extracts the cleartext after decryption | Out of scope — once decrypted, the recipient sees what they saw. This is fundamental to any DRM-like system. We rely on policy to limit what each identity decrypts (C2 view partitioning) and on the audit log for after-the-fact accountability. | n/a |
| IdP group changes (revocation) — old recipient still has cached lease | Lease TTL bounds the window. Default 1h; configurable per workbook. Daemon refreshes leases proactively at 80% of TTL; refresh fails after revocation. Offline grace window also bounded (default 24h). | broker / daemon |
| Author tries to encrypt a workbook to identities they shouldn't be authorized to grant access to | Out of scope. The author owns the workbook; defining who can read it is their right. Admin policy at the customer org can restrict (C5 admin console). | n/a |
| Recipient daemon is malicious / has been replaced by an attacker tool | Recipient owns their own machine; we cannot defend against this. The trust model is "the recipient is who they say they are, and their machine runs what they think it runs." | n/a |
| Broker key-release endpoint abused as an oracle to enumerate workbook ids | Workbook ids are 128-bit random UUIDs. Endpoint requires authenticated session; unauthenticated requests get a uniform 401. | broker |
| Broker outage prevents all opens | Daemon-side lease cache (C1.9) provides offline grace. Brokers are deployed multi-region. *Long-term: support self-hosted brokers (C5 decision) so customers aren't dependent on us.* | broker / daemon |
| MITM between daemon and broker | TLS via webpki-roots. Broker is reachable via a stable signal.ml subdomain with HSTS. *Long-term: ship the broker's public key with the daemon for cert pinning.* | daemon |
| Side-channel: timing oracle on policy evaluation reveals identity membership | Broker enforces constant-time policy evaluation paths. Cache miss vs hit on identity → group lookups normalized via a constant-time wrapper. | broker |

## What the broker cannot do (load-bearing)

These are the structural properties that make "trust the broker partially"
acceptable. Each is enforced by mechanism, not policy.

1. **Cannot read workbook cleartext.** The broker holds wrapped DEKs. The
   KEK lives in a separate KMS. To read any content, the broker would have
   to (a) fetch the artifact from wherever it's distributed and (b) call
   the KMS to unwrap. Step (a) is impossible without compromising the
   distribution channel; step (b) is logged in the KMS audit trail.
2. **Cannot mint identities.** The OIDC chain is verified end-to-end —
   broker validates the signature against the IdP's published JWKS via
   WorkOS. WorkOS itself only proxies, it does not impersonate.
3. **Cannot extend leases unilaterally.** Leases are signed with a key the
   broker holds, but the daemon validates the signature, the binding to
   the recipient's session, and the TTL. A broker that lies about TTL
   gives a recipient longer access than they should have, but does not
   give a recipient access they didn't already have.
4. **Cannot retroactively grant access.** Audit log entries are signed at
   write time and chained (each entry includes the hash of the previous).
   Inserting a fake "alice opened it" entry retroactively is detectable
   by re-checking the chain.

## What the broker can do (and we accept)

- **Deny service.** A broker outage prevents new opens. Mitigated by lease
  caching, multi-region deploy, and the long-term self-host option.
- **Read metadata.** Workbook ids, policy structure, who-accessed-when,
  view ids accessed. This is the audit log; it's intrinsic to the value
  prop. Customers who can't accept the broker seeing this metadata need
  the self-host build (C5 decision).
- **Refuse to log.** A malicious operator can suppress audit entries.
  Detection: recipients store their own copy of every lease they receive;
  periodic reconciliation against the broker's log surfaces gaps.

## Cryptographic primitives

- **Symmetric encryption:** AES-256-GCM with 96-bit IV (random per view).
- **Per-view DEK:** 256-bit, generated client-side by the author's CLI.
- **Wrapping:** DEK is wrapped with the broker's KEK (held in KMS).
  Wrapping algorithm: AES-256-GCM with associated data = workbook_id ||
  view_id || policy_hash. Binding to policy_hash means a wrapped key is
  cryptographically tied to the policy at registration time — re-registering
  with a different policy generates a fresh wrap.
- **Key derivation for session-binding:** HKDF-SHA256 over (lease_secret,
  oidc_sub, broker_nonce). The daemon derives the session-bound lease key
  to verify the lease is being used by the same recipient who authed.
- **Lease signing:** Ed25519. Broker holds the signing key; recipients
  verify against a published broker public key.
- **Audit log chaining:** SHA-256 hash of the previous entry is included
  in each new entry; the head hash is published to recipients on lease
  issuance for spot-checking.

## What's NOT in C1 (intentional gaps)

- **Per-view encryption** (C2) — C1 supports a single view per workbook.
  The format reserves space for multi-view headers but only one view is
  populated.
- **Recipient public-key binding** (P2 of C1, ideally before GA) — today
  the broker can unilaterally request KMS unwrap. P2 makes this a 2-of-2
  by requiring the recipient's ephemeral public key in the unwrap path.
- **TEE-backed broker** — would close the "rogue broker operator" gap
  fully. Long-term, post-C4 if design partners demand it.
- **Self-hosted broker** — C5 decision, not in C1.
- **Threshold-cryptographic key release** — splits the KEK across
  multiple parties so no single broker compromise leaks keys. Compelling
  but premature; revisit after C4.

## Audit and accountability

The broker writes an append-only signed log. Every key-release attempt
(success or denial) produces one entry:

```json
{
  "seq": 4471,
  "workbook_id": "01J...",
  "view_id": "default",
  "identity": {"sub": "okta|...", "email_domain": "example.com"},
  "action": "lease-issued",
  "timestamp": "2026-05-02T14:32:01Z",
  "ip": "203.0.113.42",
  "lease_id": "01J...",
  "prev_hash": "sha256:...",
  "self_hash": "sha256:...",
  "broker_sig": "ed25519:..."
}
```

Authors can fetch the log for workbooks they own. The chain property
means tampering is detectable. Recipients can independently verify their
own access entries against the broker's signed view of the chain head.

## Decisions still to make (lock down before C1 GA)

- **KMS choice.** AWS KMS (boring, ubiquitous, has a usable Workers SDK
  via fetch) vs Cloudflare KV-with-secret-binding (simpler but weaker
  separation). Recommendation: AWS KMS for the production broker, so the
  KEK lives in a different security domain than the broker's compute.
- **Default lease TTL.** Proposed: 1h with 24h offline grace. Tunable per
  workbook. Tighter for sensitive workbooks; looser for read-mostly.
- **Magic-link domain pinning.** Strict by default — magic-link recipients
  must match a policy-declared email-domain glob. Authors who want truly
  open distribution must explicitly opt in (`allow: authenticated:any`).
- **OIDC token re-validation cadence.** Validate on every key-release
  request? Cache validation for some window? Recommendation: validate
  every request — costs an extra JWKS fetch per key issuance, worth the
  simplicity. JWKS itself is cached locally with short TTL.

## Open security questions (track separately)

- How do we handle a recipient who legitimately needs offline access for
  weeks (auditor on-site at a SCIF, etc.)? Today: tunable lease TTL up to
  some max. Better answer probably involves a different policy primitive.
- How do we prove to a customer's CISO that the broker really cannot read
  their data, beyond pointing at this doc? Likely: third-party audit + a
  reproducible build of the broker.
- What's the disaster recovery story if our KMS is compromised? Re-keying
  all wrapped DEKs requires re-encrypting all artifacts. Customer-visible
  event. Need a runbook before GA.
