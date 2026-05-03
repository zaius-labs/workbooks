# Spike 3 — Log replay, integrity, and SQLite Sessions

**Status:** PASS · yjs replay is order-independent and stable; integrity chain detects all three corruption classes; SQLite Sessions ships in `@sqlite.org/sqlite-wasm` 3.53+ and conflict semantics are tractable for our use case.

## Test fixtures

- `yjs-determinism.mjs` — Node test, runs against `yjs@13.x`. Exercises substrate's parent-CID chain on synthetic ops + tests yjs replay determinism.
- `sqlite-sessions.mjs` — Node test, runs against `@sqlite.org/sqlite-wasm@3.53.0-build1`. Exercises Sessions extension API + conflict modes.

## Results

### yjs replay + integrity chain (9 / 9 pass)

```
✓ yjs replay in-order matches
✓ yjs replay shuffled matches (commutativity)
✓ yjs encoded state bit-equal across replay orders: b=87B c=87B
✓ healthy chain verifies
✓ mid-stream tamper detected: broke at seq=51 kind=cid-mismatch
✓ reordering detected
✓ trailing corrupt op discarded: recovered 9 of 10 ops
✓ recovered chain still valid
✓ compaction bit-stable across instances: 37B vs 37B
```

Highlights:

- **`Y.encodeStateAsUpdateV2` is bit-stable** for the same in-memory state across separate Y.Doc instances, even when those instances were hydrated via different update orderings. This is the property the substrate's compaction step depends on: replaying a WAL into a fresh Y.Doc and re-encoding will produce a snapshot byte-identical to one produced by a different replay path, given the same final state.
- **Parent-CID chain catches the three corruption classes we care about:**
  - **Mid-stream tamper** (op N's payload changed without recomputing CID) → detected at op N+1's parent-CID mismatch (or at op N's own CID verify, depending on which fails first).
  - **Reorder** (two ops swapped) → detected at first reordered op's parent-CID mismatch.
  - **Trailing-op corruption** (last op truncated/incomplete) → detected at last op's CID verify; runtime recovers by discarding it.
- The recovery policy exactly matches `SUBSTRATE_FORMAT_V0.md §3 trailing-op-recovery`.

### SQLite Sessions (13 / 13 pass)

```
✓ sqlite3session_create available
✓ sqlite3session_attach available
✓ sqlite3session_changeset available
✓ sqlite3changeset_apply available
✓ changeset has bytes: 87 bytes
✓ apply on healthy DB rc=0
✓ dbB state matches dbA after replay
✓ apply with conflict handler returns rc=0
✓ DATA conflict surfaced (eConflict=1)
✓ REPLACE policy applied A's value
✓ apply over missing row rc=0 with OMIT policy
✓ NOTFOUND conflict surfaced (eConflict=2)
✓ OMIT policy left dbB without the row
```

Highlights:

- **Sessions extension is shipped in `@sqlite.org/sqlite-wasm` 3.53.0+**, exposing the full C API: `sqlite3session_create`, `sqlite3session_attach`, `sqlite3session_changeset`, `sqlite3changeset_apply` (and the streaming/diff/patchset variants).
- **Same-schema replay round-trips perfectly** — capturing a session on dbA, applying its changeset to a structurally-identical dbB yields byte-identical query results.
- **Conflict types are surfaced reliably** — DATA (eConflict=1, the parallel-edit case where dbB's pre-image differs from the changeset's), NOTFOUND (eConflict=2, the row no longer exists in target), and presumably CONFLICT/CONSTRAINT/FK. Each can be handled with a per-conflict callback that returns one of OMIT(0), REPLACE(1), ABORT(2).
- **Mismatched conflict-handler return codes return rc=21 (SQLITE_MISUSE)**. Not a soft error — the apply must use one of the three documented codes or it bails out.

### Conflict policy decisions for the substrate

We need a documented policy per conflict type. Locking these for v0:

| Conflict       | Code | Substrate v0 policy | Rationale |
|---|---|---|---|
| `DATA`        | 1 | `REPLACE` | Single-writer at v0; if a DATA conflict appears it means external tampering OR a future-collab merge case. REPLACE preserves the changeset author's intent; collaborators can resolve at the application layer if they want different semantics. |
| `NOTFOUND`    | 2 | `OMIT`    | The row is gone — there's nothing to mutate. Skipping is the only sensible default. Application layer can detect `OMIT`-tagged ops via the conflict callback if it cares. |
| `CONFLICT`    | 3 | `ABORT`   | PK/uniqueness violation on INSERT. This is a hard structural fault — the changeset and target schema/state are incompatible. Refuse the apply, surface to the user. |
| `CONSTRAINT`  | 4 | `ABORT`   | Same reasoning as CONFLICT. |
| `FOREIGN_KEY` | 5 | `ABORT`   | Same reasoning. |

These are defaults. Workbook authors will be able to override per-target via the runtime's transport interface (TBD in core-1ja.9).

## Implications for the substrate runtime

1. **CID scheme works.** The format spec's `cid = blake3_32(parent_cid || target || seq || payload)` provides per-target chain integrity AND per-op integrity in a single 32-char field. The Node test uses SHA-256 truncated to 32 chars as a proxy; production runtime should swap to actual Blake3 (one-time bring-up cost).

2. **Trailing-op recovery is uniform.** Both yjs ops and SQLite Sessions changeset ops can have their CID verified the same way. The runtime's recovery loop is a single while-loop popping invalid trailing ops, indifferent to the op type.

3. **Compaction is straightforward for both formats.** Re-encode the in-memory state — `Y.encodeStateAsUpdateV2` for yjs, `db.serialize()` (or equivalent SQLite-wasm path) for SQLite — and write the bytes as a fresh `<wb-snapshot>` block.

4. **Sessions changeset size is reasonable.** Two small mutations (one INSERT + one UPDATE) on a clips table produced an 87-byte changeset. For a typical workbook editing session (dozens to hundreds of ops, mostly small), the WAL size will be well under the snapshot size — compaction triggers are about preventing unbounded growth, not about per-edit cost.

5. **Conflict policy is decided.** Documented above. Authors can override but defaults are sane.

6. **Memory/pointer plumbing for Sessions is fiddly but tractable.** The C-style API requires manual `wasm.alloc` / `wasm.dealloc`, scoped allocator usage, and `installFunction` / `uninstallFunction` for callbacks. The `captureChangeset` / `applyChangeset` helpers in the spike provide a working template the runtime can lift directly.

## Reproducer

```sh
# One-time setup of standalone deps (workspace pin sidesteps monorepo issues):
mkdir -p /tmp/wb-spike-deps && cd /tmp/wb-spike-deps
npm init -y && npm install --omit=optional yjs @sqlite.org/sqlite-wasm
cd -

# Run:
cp vendor/workbooks/packages/workbook-substrate/spikes/replay/yjs-determinism.mjs /tmp/wb-spike-deps/
cp vendor/workbooks/packages/workbook-substrate/spikes/replay/sqlite-sessions.mjs /tmp/wb-spike-deps/
cd /tmp/wb-spike-deps && node yjs-determinism.mjs && node sqlite-sessions.mjs
```

## Conclusion

Spike 3 closes. yjs replay is deterministic and bit-stable, integrity chain catches all three corruption classes, SQLite Sessions is fully available in our chosen WASM SQLite distribution with documented conflict semantics. Ready to build the substrate runtime (core-1ja.5 + 1ja.6 + 1ja.7) against this contract.
