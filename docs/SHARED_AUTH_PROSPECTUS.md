# Shared workbooks — auth + sync prospectus

**Status:** thinking-out-loud, not a plan. Written to recover the "why" before
committing to a "how." Companion to `SECURITY_MODEL.md`, which covers the
single-user, single-machine threat model this proposal extends.

## What's being proposed

Two features that are tempting to ship together but are actually separable:

1. **SSO-gated workbook encryption.** A `.workbook.html` is encrypted at rest.
   Opening it forces the recipient through an OAuth/SSO flow against an IdP
   (WorkOS, Clerk, Okta, Google Workspace, the author's own). On successful
   auth, a key broker hands the decryption key back to the recipient's daemon.
   The file is portable; access is policy-bound.

2. **Peer-to-peer collaborative sync.** Once two daemons hold the same key,
   they sync edits to each other directly — no central state server. State is
   a CRDT log so concurrent edits merge deterministically.

Part 1 is "who can open this file." Part 2 is "what happens when two openers
edit at once." You can ship 1 without 2 (most teams won't need realtime
collaboration). You cannot really ship 2 without 1 (you need identity to
authorize peers).

## Why this matters — the use cases you were trying to recover

The big idea: **the workbook becomes the unit of access control.** Today,
sharing data with someone outside your perimeter means provisioning them in
your SaaS, emailing them a CSV with no policy attached, or screen-sharing.
A signed-and-encrypted workbook collapses all three into "send the file."

Concrete cases this unlocks:

- **Cross-org collaboration without provisioning.** A consultant at Firm A
  receives a workbook from Client B. They open it and authenticate with Firm
  A's Okta. Client B never had to create them an account; Client B's audit
  log still records "alice@firm-a.example opened workbook X at 14:32." Revoke
  access by removing them from a Firm A group — the next key fetch fails.

- **"Send the analysis, not the access."** Today, sharing a Looker dashboard
  with a customer means giving them a Looker seat. Sending a workbook means
  they sign in with their own corporate SSO, see your data, and you bill
  zero seats.

- **Sensitive analyses that survive being misforwarded.** An exec emails a
  comp-planning workbook to the wrong distribution list. The file leaks; the
  data doesn't, because the people who received it aren't in the
  `comp-planning` group at the IdP.

- **Compliance-by-default.** GDPR/HIPAA/SOC2 audits ask "who accessed this
  data and when." The key broker is a single chokepoint that produces that
  log for free, even when the file lives on USB sticks.

- **Vendor / contractor flows.** Same as cross-org but inside a single
  contracting relationship. The contractor's access auto-expires when their
  engagement ends and the IdP group is rotated.

- **Federated analytics without a data warehouse.** Two companies want to
  compare metrics without moving data. Each holds a workbook with a CRDT
  view of *their own* numbers; the merged view exists only on machines that
  hold both keys. There is no central place where the joined data lives.

- **Killing the "is this the latest version?" thread.** Teams currently
  email `report-final-v3-alice-edits.xlsx` because the only way to merge is
  manually. CRDT sync means the file you're holding is always converging
  toward the latest.

The unifying principle is **the file is the channel**. Email, Slack, Drive,
USB — all of them become safe transports because the policy travels inside
the artifact, not alongside it.

## What we'd be building

Three pieces, in roughly this order of complexity:

### 1. Envelope encryption + key broker (table stakes)

The workbook file is symmetrically encrypted (AES-GCM, key per workbook).
The key itself is wrapped and held by a small service we run. Opening a
workbook is:

```
daemon → broker:  "I want to open workbook X"
broker → daemon:  "auth at <IdP authorize URL>"
daemon → browser: opens IdP login
IdP    → broker:  OIDC callback with user identity
broker → policy:  "is alice@acme.com in workbook X's allowlist?"
broker → daemon:  wrapped key + short-lived lease
daemon          : decrypts file in memory, serves it
```

Policy is per-workbook, written by the author at share time:

```yaml
access:
  idp: workos:org_abc123
  allow:
    - group: comp-planning
    - email: external-auditor@deloitte.com
  expires: 2026-09-01
```

WorkOS is the obvious pick for the IdP layer — they exist precisely to
abstract over Okta/Azure AD/Google/SAML so we don't write 14 connectors.
For solo users with no IdP, a "log in with email magic link" fallback
covers the gap.

Key rotation = re-encrypt the file (cheap; workbooks are small). Revocation
= remove the user from the IdP group; their next lease fails. Cached leases
on the daemon side keep things working offline for a configurable window.

### 2. CRDT-backed local state (the unlock for collaboration)

Workbook content becomes a CRDT document — Automerge or Yjs. Even with one
user, this is a quiet upgrade: it gives us free undo/redo, conflict-free
merge across the user's own devices, and a clean change log.

The `.workbook.html` file format gains an embedded CRDT log alongside the
rendered HTML. Reading the file = applying the log to get current state.

This is the piece you said you "weren't sure how it works." The short
version: a CRDT is a data structure where any two replicas that have seen
the same set of edits arrive at the same state, regardless of order. Edits
carry enough metadata (timestamps, replica IDs, dependencies) that merge is
deterministic. There is no "conflict resolution UI" because there are no
conflicts — concurrent edits to the same cell produce a defined winner, or
both, depending on the field type.

Automerge is more rigorous and battle-tested for documents. Yjs is faster
and has better tooling for editor-style use cases. For workbooks
(structured cells + free-text blocks) Automerge is probably the better fit.

### 3. P2P transport (only when realtime is the goal)

Once two daemons hold the key and a CRDT, they need to exchange edits. The
options:

- **Central relay.** Edits flow through our server. Simplest. We see the
  ciphertext but not contents (clients encrypt under the workbook key
  before sending). This is what 90% of "P2P" products actually do because
  NAT traversal is a nightmare.
- **True P2P via iroh or libp2p.** Daemons discover each other via a
  rendezvous service we run, then connect directly via QUIC with hole-
  punching. Iroh is Rust-native, lines up with `workbooksd`, and handles
  the NAT pain. Falls back to a relay when direct connection fails.

Recommendation: build the relay first because it's a week of work and
unblocks every collaboration use case. Add iroh when bandwidth costs or
latency become real problems.

## What this is *not*

- **Not a Google Docs clone.** Realtime cursor-following and presence are
  features the CRDT layer makes *possible*, not features we have to ship.
  The interesting product is "send a file, recipient signs in, edits merge
  back" — async by default, realtime when both parties happen to be open.
- **Not a new auth product.** WorkOS or Clerk does the IdP work. Our piece
  is the key broker and the policy layer. Rolling our own auth is a tarpit
  with no upside.
- **Not blockchain.** "Distributed peer-to-peer ledger" in CRDT terms is
  just an append-only log of edits with replica IDs. No consensus protocol,
  no proof-of-anything. Stay far from that vocabulary in marketing copy.

## Hard parts, called out honestly

- **The key broker is a SPOF for opening files.** If our service is down,
  no one can open a workbook for the first time. Mitigations: aggressive
  client-side caching of leases, multi-region deploy, "offline grace
  period" baked into the lease. Worst case (we shut down): authors can
  export with policy stripped.
- **Revocation has a window.** Cached leases mean removed users keep access
  until cache expiry. This is the classic OAuth refresh-token tradeoff.
  Tunable per workbook.
- **NAT traversal is genuinely hard.** Even with iroh, ~10% of connections
  fall back to the relay. Plan for it; don't pretend it doesn't happen.
- **CRDT migration of existing workbooks.** The current substrate format is
  not a CRDT. Converting is a one-time mechanical migration, but it's a
  format break — old daemons can't read new files. Phase carefully.
- **Audit log integrity.** "Who opened this" only matters if the log is
  trustworthy. The broker holds the canonical log; the daemon's local log
  is advisory. Be clear which is which.
- **Per-workbook IdP fragmentation.** A user with workbooks from five
  different orgs ends up with five different SSO sessions. Daemon UX needs
  to make this not annoying — probably a single "identity wallet" that
  remembers which IdP goes with which workbook.

## Recommended path

Three phases, each independently shippable:

**Phase A — encrypted-at-rest with broker.** WorkOS integration, simple
allowlist policy, no collaboration. Ships the headline value ("send a
workbook, recipient signs in, audit log everything") without the CRDT and
P2P complexity. Probably 4-6 weeks.

**Phase B — CRDT substrate.** Migrate the workbook format to an Automerge-
backed log. No network sync yet — but local undo/redo and merging across
the same user's devices via key sync. Ships independently as a quality-of-
life upgrade. 6-8 weeks, mostly format and migration work.

**Phase C — sync transport.** Central encrypted relay first, iroh P2P
second when warranted. Realtime collaboration becomes a real feature.
Quotable as "Figma for analyses." 4-6 weeks for the relay; iroh is open-
ended.

Phase A alone is probably enough to validate the market hypothesis. If
nobody wants the encrypted-share-with-SSO flow, the CRDT and P2P work is
wasted. Ship A, watch what people do, then commit to B and C.

## Open questions

- Do we want to be the broker, or do we want to ship an open protocol so
  enterprises can self-host it? (Self-host is a much harder sell but
  removes the SPOF concern.)
- Does the policy live in the file (signed by the author) or only on the
  broker? In-file policy is auditable but rotation is harder.
- What's the minimum viable IdP support? WorkOS gets us most enterprises
  for one integration; Google Sign-In covers most prosumers; magic-link
  covers the long tail.
- Pricing model: per-workbook? per-recipient? per-broker-call? This
  determines whether the architecture needs to track per-event metering.
- How does this interact with the existing keychain-based secrets model?
  Probably: secrets are still per-user in the local keychain; the
  encryption key is the new thing. They don't conflict.

## Recommendation in one sentence

Build Phase A against WorkOS, treat it as a real product hypothesis to
validate before touching CRDTs, and be prepared to throw the broker away
and replace it with a federated protocol if the market wants self-hosting.
