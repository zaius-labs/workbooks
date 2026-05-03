# Spike 1 — Parser containment

**Status:** PASS · all three desktop engines parse the substrate format cleanly.

## Test fixture

A 20.46 MB synthetic workbook HTML containing:

- 3 × `<script type="application/octet-stream">` snapshots, each ~5 MB of base64-encoded random bytes (the worst case for parser length tolerance and base64 fidelity).
- 1 × `<script type="application/json">` WAL with 1500 mixed-target ops (40–240 B payload each), parent-CID-chained.
- 1 × `<script type="application/json" id="wb-meta">` with expected fingerprints.
- 1 inline `<script type="module">` runner that, on load, populates a `#results` table with per-check pass/fail.

Generator: `generate-test-file.mjs`. Driver: `test-browsers.mjs` (Playwright across Chromium / Firefox / WebKit).

## Results

| Browser  | compatMode    | pass / fail | Failed checks                                |
| -------- | ------------- | ----------- | -------------------------------------------- |
| Chromium | `CSS1Compat`  | 11 / 1      | `fetch(self.location)` blocked on `file://`  |
| Firefox  | `CSS1Compat`  | 12 / 0      | —                                            |
| WebKit   | `CSS1Compat`  | 11 / 1      | `fetch(self.location)` blocked on `file://`  |

Per-check results are written to `out/browser-results.json` for archive.

### What passed in all three engines

1. **Standards mode** — `document.compatMode === 'CSS1Compat'`. No quirks-mode triggers from the embedded data blocks.
2. **No DOM pollution** — `<body>` contains only the elements we authored. The base64 inside `<script type="application/octet-stream">` is fully contained as `textContent`; nothing leaks into the rendered DOM.
3. **Snapshot extraction via `getElementById('wb-snapshot:NAME').textContent`** — for all 3 snapshots, byte-length matches generation exactly, base64 round-trips through `atob → Uint8Array → SHA-256` to the source CID with no alteration.
4. **WAL parses cleanly** — `JSON.parse(getElementById('wb-wal').textContent)` returns 1500 op records.
5. **WAL `seq` monotonic** — verified strictly increasing across all 1500 ops.
6. **Parent-CID chain integrity** — verified per target (`composition`, `data`); chain consistent from snapshot CID through op N's `parent_cid`.

### What failed (expected, not blocking)

- **`fetch(self.location.href)` from `file://` URL.** Chrome and WebKit block this by CORS/security policy when the page is loaded via `file://`. Firefox permits it. The test harness logs this as a fail because it's a useful capability test, but the substrate runtime does **not** depend on it.

## Implications for the substrate design

1. **DOM-based extraction is the canonical extraction path.** `document.getElementById(id).textContent` works universally and returns content verbatim. The format spec should not require `fetch(self.location)` for any critical operation.

2. **`<script type="application/octet-stream">` is the right container** for snapshot blocks. Browser parsers treat its content as opaque text (no execution, no character escaping, no DOM creation), and we get byte-identical retrieval at 5 MB per block in all three engines. We tested up to 15 MB total of binary data without any browser parser misbehavior.

3. **`<script type="application/json">` works for the WAL**. JSON-encoded WAL is fine for v0; if size becomes a concern in v1 we can move to opaque base64 inside `<script type="application/octet-stream">` without changing the extraction path.

4. **Base64 fidelity holds** — random binary round-trips to source CID after `atob → SHA-256`. No silent character loss, no whitespace normalization beyond the leading/trailing newlines we added (those are stripped via `.replace(/\s/g, '')` before decode).

5. **Parse latency at 20 MB workbook scale is acceptable.** All three engines reach the in-page assertion runner within Playwright's default 60s timeout; in practice this is sub-second on dev hardware. We have not yet stress-tested 100 MB+ workbooks; flagged for the write-semantics spike.

## Constraint flagged for downstream tickets

The HTML must keep all data in `<script type=…>` containers. Trailing bytes after `</html>` would be parsed as character data and pollute the DOM (per the [HTML5 tokenizer initial insertion mode](https://html.spec.whatwg.org/multipage/parsing.html#the-initial-insertion-mode)). The format spec should explicitly forbid trailing-bytes for v0, and the build tool should never emit them.

If we ever revisit a polyglot APE / trailing-blob concept, the binary pieces must live inside script-tag containers, not as raw post-`</html>` bytes. (See parking-lot ticket for polyglot research.)

## Reproducer

```sh
cd vendor/workbooks/packages/workbook-substrate
node spikes/parser/generate-test-file.mjs --snapshot-mb=5 --wal-ops=1500
node spikes/parser/test-extract-node.mjs spikes/parser/out/spike-parser-test.html
# Browser drive (one-time: npx playwright install chromium firefox webkit)
node spikes/parser/test-browsers.mjs
```

The Playwright driver uses a standalone install at `/tmp/wb-spike-deps` to sidestep the monorepo's workspace-protocol pinning; see `test-browsers.mjs` header for details.

## Conclusion

Format is browser-safe across the three target engines. Spike closed. Proceed to file format v0 spec finalization (core-1ja.4) and runtime parser+hydrator (core-1ja.5).
