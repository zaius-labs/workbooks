# Substrate test suite

```sh
# One-time setup of standalone deps (sidesteps monorepo workspace pin):
mkdir -p /tmp/wb-spike-deps
cd /tmp/wb-spike-deps
npm init -y
npm install yjs @sqlite.org/sqlite-wasm tsx playwright
npx playwright install chromium firefox webkit  # for browser tests

# Run the full conformance suite:
cd <repo>/vendor/workbooks/packages/workbook-substrate
node test/conformance/run-all.mjs

# Include the slow browser parser-containment test:
node test/conformance/run-all.mjs --include-browsers
```

## What's covered

| Test | Type | Coverage |
|------|------|----------|
| `test/smoke.mjs` | parser | basic round-trip, snapshot CIDs, WAL replay, tampered CID detection, trailing-op recovery |
| `test/mutate-smoke.mjs` | mutate | seq monotonicity, parent-CID chaining, listener subscribe/unsubscribe |
| `test/compact-identity-smoke.mjs` | compact + identity | WAL→snapshot fold, compaction_seq bump, post-compact mutator state, identity migration, orphan GC |
| `test/transport-smoke.mjs` | transport | negotiate fallback to T5 in Node; T5 semantics + commitPatch |
| `test/conformance/version-refusal.mjs` | conformance | unknown substrate_version refused; missing/malformed wb-meta refused |
| `spikes/replay/yjs-determinism.mjs` | yjs | replay commutativity + bit-stable encoding |
| `spikes/replay/sqlite-sessions.mjs` | sqlite | Sessions API availability + DATA/NOTFOUND conflict policy |
| `spikes/write/fingerprint-guard.mjs` | identity | (workbook_id, fingerprint) cache scenarios |
| `spikes/parser/test-browsers.mjs` | parser (3 browsers) | DOM extraction at 20MB workbook scale |

## What's NOT covered (yet)

- T2 / T3 / T4 transports against real browser FSA picker flows. Manual verification needed; documented in `spikes/write/FINDINGS.md`.
- PWA file_handlers end-to-end (requires a real installed PWA + OS file association).
- SQLite hydration via `hydrateSqliteTarget` — code path mirrors the Sessions spike but isn't wired into the substrate smoke. To add: spin up a real WASM SQLite, hydrate from a generated snapshot, verify roundtrip.

## Adding a test

For a pure-Node invariant test: drop a `.mjs` into `test/conformance/` and add it to `run-all.mjs` tests array. Match the existing harness pattern: write a temp file with TS imports, run via `tsx`, exit non-zero on failure.

For a browser-driven test: add a `.html` + `.mjs` pair into `spikes/<area>/`, install playwright in `/tmp/wb-spike-deps`, drive the page from the `.mjs`. Add to `run-all.mjs` under the `--include-browsers` gate.
