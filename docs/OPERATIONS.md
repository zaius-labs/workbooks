# Workbook Operations Guide

A companion to `SPEC.md`. The spec defines *what a workbook is* — its format, schema, protocols, and runtime contract. This document defines *how a workbook is used* — its lifecycle, the agent's role in creating it, the persistence model, identity and auth, observability, quotas, editing UI, format conversions, snapshot history, discovery, and notifications.

If the spec answers "what's in the file?", this answers "what happens when a user clicks the New button?"

The lifecycle in this document focuses primarily on **document** and **notebook** workbooks — the analyst-facing artifacts produced by an agent. **SPA workbooks** (`manifest.type: "spa"`) follow a different lifecycle: they are authored by a developer using `@work.books/cli` (or hand-written), distributed as static `.html` files, and run client-side without any agent involvement at runtime. See `WORKBOOK_AS_APP.md` for the SPA authoring path. Some sections below — e.g. agent-driven creation, plan gates, server-side scheduling — apply only to document/notebook workbooks; that's noted inline.

---

## Lifecycle & User Journey

A workbook moves through five stages: creation, opening, running, editing, sharing. Archival is a sixth state, not a stage.

> **Document/notebook only.** SPA workbooks have a much simpler lifecycle: a developer runs `workbook build`, the resulting `.html` is shared as a static file, and the recipient opens it. No plan gate, no agent loop, no server-side runtime, no quota enforcement (except whatever the app itself implements). The rest of this section assumes document/notebook unless stated otherwise.

### Creation

The primary creation path is conversational with the agent.

1. User opens Signal and types a prompt: *"Analyze last quarter's churn data and build a model that predicts at-risk accounts."*
2. The frontend creates a new `sessions` record and starts the agent in `apps/sift`.
3. The agent creates an empty `workbooks` record bound to the session: `{ slug, ownerId, sessionId, blocks: [] }`.
4. The user is redirected to `/workbook/<slug>`. The Svelte UI mounts and subscribes to the workbook via a Convex reactive query.
5. The agent begins emitting blocks — one Convex mutation per block — and runs cells in its E2B sandbox. The user watches the workbook materialize in real time as Convex pushes block additions to the open page.
6. When the agent finishes, it marks the session `complete`. The workbook persists with its full block tree, populated SQLite layer, and embedded outputs.

Workbooks can also be created **without an agent**:
- `New blank workbook` from the dashboard creates an empty `workbooks` record. The user authors blocks directly.
- `Duplicate` creates a copy of an existing workbook with a fresh slug, preserving all blocks but resetting `provenance.dependencies` to unresolved.
- `Import .workbook file` reconstructs a workbook from an exported file (see Import & Format Conversions).

### Opening

When a user navigates to `/workbook/<slug>`:

1. SvelteKit route resolves the slug → workbook ID via Convex query.
2. The page subscribes to the workbook's reactive query: `convex.query(api.workbooks.get, { slug })`. Any future mutation to the workbook flows back into the page automatically.
3. The Svelte runtime mounts `Workbook.svelte` with the manifest.
4. SQLite layer is fetched from `manifest.data.externalUrl` (or read from the embedded layer if the workbook was opened from a `.workbook` file). sql.js loads it into the in-browser engine.
5. The state layer (cell outputs, plot images, variable previews) is loaded and each block component renders its embedded output.
6. The runtime selector reads `manifest.runtime.preferredHost` and attempts to connect. On success, the UI shows "Connected: Signal hosted" or "Connected: Local"; on failure, "Browser-only" with a Connect link.
7. The page is interactive. Display blocks render fully. SQL cells are runnable. Python cells show their last output and have a Run button gated on runtime connection.

Opening a `.workbook` file from disk follows the same flow with one exception: there is no Convex query — the manifest, SQLite, and state layers are all read from the embedded script tags. The page is fully usable; saving back to Convex requires an explicit "Import to Signal" action.

### Running

Cells run on three triggers:
- **Manual**: user clicks Run on a cell.
- **Reactive**: an `input` widget changes, or a URL parameter is set, and the dependency graph determines downstream cells need re-execution.
- **Scheduled**: a cron tick fires for a workbook with `schedule.enabled: true`.

The execution flow:

1. The reactive graph is computed from the static analyzer's `provides`/`reads` data on each cell. The runtime calculates the transitive closure of cells affected by the trigger.
2. Cells are queued in topological order. SQL cells with `runtime: sqllib` execute directly via sql.js. Python cells with `runtime: host` are dispatched to the connected runtime via Connect (`RunCell` RPC).
3. Cell outputs stream back as `CellOutput` messages — text via JSON-Lines over SSE, tables via Arrow Flight, plot images as base64. The cell's `outputs` array updates incrementally; the UI re-renders as outputs arrive.
4. Cell `status` transitions: `pending → running → ok | error`. Downstream cells update in cascade.
5. On completion, the runtime writes outputs back to Convex: `cell.outputs`, `cell.status`, `cell.lastRunAt`. The state layer is rewritten to match.
6. If the run originated from a schedule, `manifest.schedule.lastRunAt`, `lastRunStatus`, `lastRunId` are updated under the optimistic lock.

The user sees outputs streaming in real time. There is no "save" button for a run — completing a run is itself a durable mutation.

### Editing

Two distinct editing modes coexist on every workbook.

**Agent editing** (conversational refinement):
- User types into the composer attached to the open workbook: *"Make the funnel chart use absolute counts instead of percentages."*
- The composer message attaches to the workbook's session. The agent re-engages with full workbook context loaded into its system prompt.
- The agent uses workbook-mutation tools (`update_block`, `append_block`, `delete_block`, `reorder_blocks`) to modify the manifest. Each tool call is a Convex mutation under the optimistic lock.
- The user sees changes flow into the page as the agent works. No diffs to accept — the agent is collaborating, not proposing.

**Direct user editing**:
- Click a cell → a Monaco editor opens inline. Edit source. Save (`Cmd+S` or focus loss).
- Edit display block content (paragraph text, callout content) inline via contenteditable bound to a Convex mutation.
- Reorder blocks via drag handles. Delete blocks via context menu. Insert new blocks from a `+` menu.
- Edit `input` widget defaults via a properties panel.

Both modes write to the same Convex record. The agent and user can edit simultaneously — Convex's optimistic lock handles ordering. In practice the agent operates in larger atomic chunks (multiple blocks per session) while the user makes small targeted edits.

### Saving

There is no save button. Persistence is automatic and continuous.

| Edit type | Sync behavior |
|----------|---------------|
| Cell source code | Debounced 500 ms after typing stops |
| Display block content (paragraph, etc.) | Debounced 500 ms |
| Block reorder, insert, delete | Immediate (structural changes are atomic) |
| Cell outputs from a run | Immediate on cell completion |
| Schedule config, permissions, manifest metadata | Immediate |
| Agent-emitted block additions | Immediate (each tool call is a mutation) |

All mutations include the current `updatedAt` value as an optimistic lock. Stale writes are rejected and the client retries with the latest server state. The user sees a brief "syncing" indicator during retries; persistent failures surface a toast.

### Sharing

A workbook is private by default. Sharing flows:

- **Add collaborator**: enter a Signal user's email → adds them with `viewer` or `editor` role. Their Signal session token grants access on next page load.
- **Public link**: toggle `visibility: public`. The workbook becomes accessible at `https://signal.app/workbook/<slug>` to anyone with the link, view-only, no auth required. SQL cells and viewing work; cell execution does not (no runtime granted).
- **Signed link**: generate a time-bounded signed URL (`/workbook/<slug>?token=<jwt>&expires=<iso>`) that grants the specified role until expiration. Used for one-off shares without adding a permanent collaborator.
- **Export `.workbook` file**: a snapshot file the recipient can open in any browser (Tier 1 browser-only) or import into their own Signal account.

The deep link `signal://workbook/<slug>` opens the workbook in Signal app if installed, else falls back to web.

### Archival

A workbook is never silently deleted. Three terminal states:

- `status: "active"` — default; appears in lists and search
- `status: "archived"` — hidden from default views; still queryable, still loadable, schedules paused
- `status: "deleted"` — soft-deleted; retained 30 days then purged

Schedules on archived workbooks are paused (not removed). Archived workbooks loaded as cross-workbook dependencies emit a warning. Deleted workbooks return 404 to direct loads but the lockfile entries in dependent workbooks still resolve to their pinned `runId` data until the 30-day purge.

---

## Agent ↔ Workbook Interaction

The agent in `apps/sift` is the primary author of workbooks. The interaction model has three layers: tools, session binding, and sandbox sharing.

### Workbook tools

The agent runtime exposes a fixed set of workbook-mutation tools alongside its existing Python execution and search tools:

| Tool | Purpose |
|------|---------|
| `create_workbook(title, description)` | Create empty workbook bound to the current session. Returns `slug`. |
| `append_block(slug, block)` | Append a block to the workbook's block tree. |
| `insert_block(slug, block, afterBlockId)` | Insert at a specific position. |
| `update_block(slug, blockId, patch)` | Modify an existing block (title, source, props, etc.). |
| `delete_block(slug, blockId)` | Remove a block. |
| `reorder_blocks(slug, orderedBlockIds)` | Rearrange the block tree. |
| `run_cell(slug, cellId)` | Execute a cell in the workbook's sandbox. Streams output back. |
| `set_schedule(slug, schedule)` | Configure or update the workbook's cron schedule. |
| `set_widget_registries(slug, registries)` | Add trusted widget registries for `widget` blocks. |

These tools are thin wrappers over Convex mutations. The agent never writes Svelte or HTML — it composes blocks using kinds defined in the spec.

The agent's existing tools (`run_python`, `search_web`, `submit_doc`) continue to work and integrate with the workbook tools. For example, the agent might `run_python` to explore data, then `append_block({ kind: "code", ... })` to surface the working code as a cell in the workbook.

### Session binding

A `sessions` record represents one conversation. Sessions have a `workbookId` field — null for free-form sessions, set when a workbook is created within the session.

The relationship is **one-to-one bidirectional**: each session owns at most one workbook; each workbook is created by exactly one session. Subsequent edits via composer messages reuse the original session — the agent loads the workbook into context and mutates it, rather than starting a fresh session.

When a user wants to fork a workbook for a different conversation, they create a new session with `Duplicate workbook` — this creates a new session and a copy of the workbook, leaving the original untouched.

### Sandbox sharing

The agent runs Python in an E2B sandbox during workbook generation. **The same sandbox becomes the workbook's runtime sandbox** — there is no separate "agent sandbox" and "user sandbox."

Concretely:
- Session start → agent creates sandbox from the template.
- Agent runs cells via `run_cell` while building the workbook. Outputs stream back; state persists in the sandbox.
- Session ends → sandbox transitions from "agent-controlled" to "user-controlled" and remains attached to the workbook.
- When the user reopens the workbook later, they reconnect to this sandbox (or it resumes from pause). All variables and loaded models from the agent's session are still in scope.

This is critical for ML workflows: a model trained by the agent during workbook generation is still loaded in memory when the user reopens and runs an inference cell. The sandbox's `autorun` step replays setup cells if the sandbox cold-starts or is replaced.

### Conversational refinement loop

The agent's full workbook context is always available when the session is reopened. The system prompt for refinement turns includes:
- The current manifest (compressed to titles + structure for context efficiency)
- The current cell sources
- A summary of the recent run outputs
- The user's new message

The agent decides what to mutate, calls the appropriate tools, and the user sees changes flow in. There is no "diff approval" UI — the agent is treated as a collaborator with edit access, not a proposer.

If a user wants to revert agent changes, they use the standard undo / snapshot history (see Snapshot History).

---

## Persistence & Live-Document Model

Convex is the canonical source of truth. The Svelte UI is a reactive view onto Convex queries. The local runtime is a stateful executor whose results are persisted back through Convex.

### What's reactive vs durable

| Concept | Storage | Reactive to UI | Durability |
|---------|---------|---------------|------------|
| Manifest blocks | Convex `workbooks.blocks` | Yes (reactive query) | Persistent |
| Cell outputs | Convex `workbooks.blocks[i].outputs` | Yes | Persistent (last run only) |
| Cell `status` | Convex | Yes | Updated per execution |
| SQLite layer | R2 (URL in `workbooks.sqliteUrl`) | No (refetched on URL change) | Persistent |
| State layer (plot images, etc.) | R2 (URL in `workbooks.stateUrl`) | No (refetched on URL change) | Persistent |
| Sandbox in-memory state | E2B / local Docker | No | Ephemeral (lives until pause/destroy) |
| Streaming output during a run | Connect SSE stream | Yes (incremental) | Becomes persistent on cell completion |
| Run history | Convex `workbookRuns` table | Yes | Persistent (retention TBD) |

### Sync timing

The UI uses **optimistic mutations** for low-friction editing. When a user types in a cell:

1. The keystroke updates local Svelte state immediately. The UI re-renders.
2. After a 500 ms debounce, a Convex mutation is dispatched with `updatedAt` as the optimistic lock.
3. Convex commits the mutation and pushes the new state to all subscribers (including the originating tab).
4. The originating tab reconciles: the optimistic value is replaced with the server value (typically identical).
5. On lock conflict, the mutation is rejected and retried with the latest server state, replaying the local edit on top.

Structural mutations (insert, delete, reorder) skip the debounce and dispatch immediately — they're atomic and harder to merge if delayed.

Cell output writes are immediate on cell completion. Streaming outputs during a run are not persisted to Convex; only the final output state is. If a run is interrupted, partial outputs are lost (only the manifest's pre-run snapshot persists).

### Multi-tab semantics

Two tabs open on the same workbook see identical state via the reactive query. Edits in either tab flow to the other within ~50 ms. Both tabs run cells against the same backend sandbox, so cell outputs in tab A are visible in tab B once the run completes.

If both tabs edit the same cell within the debounce window, the optimistic lock resolves whichever mutation lands first. The losing tab gets a conflict response, retries with the new server state, and re-applies its edit on top. Most simple cases (typing in different cells, editing source vs. running a cell) never produce conflicts.

For Python cell execution, the sandbox is single-threaded by default. If two tabs trigger cell runs simultaneously, the runtime queues them — the second run waits for the first to finish.

### Conflict resolution UI

When the optimistic lock fails repeatedly (rare, indicates true concurrent editing), the UI shows a non-blocking toast: *"Another change was made. Reload to see the latest version."* Reloading replays the page from the latest server state. No automatic merge — Signal is single-writer per workbook by design.

---

## Identity, Auth, and Token Flow

### User identity

Signal uses WorkOS for authentication. A logged-in user has a JWT in an httpOnly cookie. Convex queries and mutations carry this JWT and resolve to a `users` record. All workbook ownership and permission checks resolve against the user's identity.

### Permission model

A workbook has:
- An `ownerId` — the user who created it. Cannot be changed (transfer not supported in v1).
- A `permissions.collaborators` list — `{ userId, role }` entries with role `editor` or `viewer`.
- A `permissions.visibility` field — `private`, `shared`, or `public`.

| Action | Required role |
|--------|--------------|
| View blocks, outputs | viewer (any permission grants this) |
| Run cells | editor or owner |
| Edit source / structure | editor or owner |
| Change permissions, schedule | owner |
| Delete | owner |

Public workbooks grant view to anyone with the link, no auth required. Run permissions are not granted by `public`.

### Cell-as-API tokens

Each workbook with `manifest.api.enabled: true` has a set of API tokens managed by the owner. Tokens are created in the workbook's settings panel:

```
[Generate token]
Name: weekly-forecast-cron
Scopes: ["signal:workbook:execute"]
Cells: ["cell-forecast"]
Expiry: 90 days
```

The token is shown once at creation, then stored hashed. Callers include it as `Authorization: Bearer <token>`. The middleware:
1. Validates the token (signature, expiry, hash match)
2. Checks the requested cell is in the token's `cells` allowlist
3. Checks the rate limit per `manifest.api.auth.rateLimit`
4. Dispatches the run

Revocation: deleting the token from the settings panel invalidates it immediately. Tokens are tied to the workbook, not the user — if the workbook owner changes, tokens continue to work (but only the new owner can manage them).

### MCP authentication

MCP clients authenticate one of two ways:

- **Public MCP resources** (`manifest.mcp.auth.public: true` and per-resource `public: true`): no auth. Anyone with the MCP server URL can read.
- **Private MCP** (default): clients present a Signal session token (cookie or Authorization header) with the configured scope. The MCP server validates the token before exposing any tool or resource. Per-resource and per-tool checks honor the workbook's permissions.

A separate "MCP service token" can be issued for headless MCP clients (other agents, CLI tools) that need to call the workbook's MCP without a user session. These are scoped like API tokens.

### Cross-workbook `load()` auth

When a Python cell calls `load("alice/customer-segments-v3")`, the runtime checks:
1. Is the calling workbook's owner authorized to read `alice/customer-segments-v3`? (own workbook, public, or explicit collaborator)
2. If yes, fetch and cache the source workbook's SQLite + state layers, scoped to the calling workbook's session.

If the source workbook becomes inaccessible after pinning (alice revokes access, deletes the workbook), the lockfile entry continues to work via the cached snapshot until the cache TTL expires (default 7 days). After expiry, the dependent workbook fails with a permission error on next run.

### Service tokens for scheduled runs

Scheduled runs need to authenticate but aren't tied to a user session. Each workbook with `schedule.enabled: true` gets an internal service token created automatically. The cron infrastructure presents this token when invoking the run. The token is invisible to users and rotates automatically every 30 days.

### Token revocation cascade

Permission changes invalidate dependent tokens:
- Removing a collaborator → their session can no longer access the workbook (next request returns 403)
- Changing visibility from public to private → no auto-invalidation of view; existing public-link visitors lose access on next request
- Deleting a workbook → all tokens (API, MCP service, schedule service) are invalidated; cross-workbook dependents see permission errors on next pull

---

## Observability

### Where errors surface

Cell execution errors:
- **Inline in the cell**: traceback displayed below the cell with collapsible frames. Default view shows the last frame (the user's code). Expandable to full traceback.
- **In the workbook's run log**: a tab in the workbook UI shows the last 50 runs with cell IDs, durations, statuses, and error summaries.
- **Searchable in Convex**: cell errors are stored in the `workbookRuns` table with manifest context, queryable for debugging.

Sandbox / runtime errors:
- **Banner at top of workbook**: "Runtime disconnected. [Reconnect]". Persists until reconnected.
- **Diagnostic panel**: opening it shows the runtime host's last 10 events (connect, sandbox start, errors, etc.).

Schedule failures:
- **In the workbook**: the schedule panel shows the last 10 runs with error details.
- **Push notification**: configurable per user (default on for owners). Email summary digest daily.
- **Webhook**: optional outbound webhook on schedule failure for integration with PagerDuty, Slack, etc.

### Logging

All cell executions emit structured logs:
```json
{
  "ts": "2025-01-15T10:00:00Z",
  "workbookId": "...",
  "cellId": "...",
  "runId": "...",
  "event": "cell_started | cell_completed | cell_errored",
  "durationMs": 1234,
  "outputBytes": 567,
  "errorClass": "...",
  "errorMessage": "..."
}
```

Logs are retained 30 days for free tier, 1 year for paid. Available via the workbook's diagnostic panel and via a per-org log export.

### Tracing

OpenTelemetry traces flow through the Connect runtime control plane. A user-initiated cell run generates a trace with spans for:
- UI dispatch
- Connect RPC
- Sandbox dispatch
- Cell execution (per-statement if instrumented)
- Output streaming
- Convex persistence

Traces are sampled (10% default) and viewable in the diagnostic panel. Useful for debugging "why did this cell take 8 seconds?" — typical answer: 6s cold-start, 1s actual code, 1s output upload.

### Performance metrics

Per workbook:
- Average cell duration (rolling 7-day)
- Sandbox warm vs cold ratio
- Schedule run success rate
- Cross-workbook dependency resolution time

Surfaced in the workbook's diagnostic panel and aggregated at org level for capacity planning.

---

## Quotas & Limits

Quotas balance user freedom with system stability. All limits are configurable per org for paid tiers.

### Per-workbook limits

| Resource | Free | Pro | Team |
|----------|------|-----|------|
| Total blocks | 1,000 | 5,000 | 25,000 |
| Cells | 200 | 1,000 | 5,000 |
| Embedded SQLite (forced external above) | 5 MB | 50 MB | 500 MB |
| External SQLite max | 100 MB | 5 GB | 50 GB |
| Cell exec time | 5 min | 30 min | 4 hours |
| Schedule frequency floor | daily | hourly | every 5 min |
| Concurrent scheduled runs | 1 | 5 | 50 |

### Per-user limits

| Resource | Free | Pro | Team |
|----------|------|-----|------|
| Total workbooks | 25 | unlimited | unlimited |
| Active workbooks (with sandbox) | 3 | 20 | 100 |
| API requests / day | 100 | 10,000 | 1,000,000 |
| MCP tool calls / day | 100 | 10,000 | unlimited |
| Cross-workbook dependencies per workbook | 5 | 50 | unlimited |

### Enforcement

Limits are enforced at mutation/dispatch time, not retroactively. Hitting a limit produces a clear error: *"This workbook has reached the 200-cell limit. Upgrade to Pro for 1,000 cells."*

Soft limits (sandbox count, frequency floors) automatically pause less-recently-used resources rather than rejecting new work — opening a fourth workbook on free tier pauses the least-recently-used sandbox.

Hard limits (block count, file size) reject the offending mutation and require explicit user action (delete blocks, upgrade plan).

---

## Editor UI

### Cell editor

Monaco is the cell source editor. Languages supported: Python, SQL, JavaScript. Features:

- Syntax highlighting for all three
- Autocomplete via language servers (Pyright for Python, sql-language-server for SQL, TS for JS)
- Real-time error squiggles
- Format-on-save (black for Python, prettier for SQL/JS)
- Find/replace within cell
- Multi-cursor editing
- Cmd+/ to toggle comment

Cells are full-width within the document column; long code is fine. Cells exceeding 50 lines collapse to a preview with an "Expand" toggle.

### Block editor

Display blocks (paragraph, markdown, callout) edit inline via contenteditable bound to a Convex mutation. Markdown blocks use `mdsvex`-style editing — typing markdown syntax renders inline.

Block reordering is via drag handles on the left margin. Hovering reveals a `+` button between blocks for inserting new blocks. The `+` opens a block picker showing all available kinds with brief descriptions.

### Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Enter` | Run current cell (or focused cell) |
| `Shift+Cmd+Enter` | Run all cells |
| `Cmd+S` | Force-sync (rarely needed; sync is automatic) |
| `Cmd+Z` / `Cmd+Shift+Z` | Undo / Redo |
| `Cmd+/` | Toggle comment in cell |
| `Cmd+K` | Command palette |
| `/` (in block) | Block-type picker (slash commands) |
| `Cmd+\` | Toggle composer / chat with agent |

### Undo/redo

Undo is Convex-aware. Each mutation produces an inverse mutation; the inverse stack is per-tab and survives reloads (stored in localStorage, keyed by workbook ID). Undo applies the inverse mutation through Convex, which propagates to all open tabs. Redo replays the original.

Granularity: each Convex mutation is one undo step. Typing 50 characters in a cell produces one debounced mutation = one undo step.

### Multi-user view (live cursors)

When two users have a workbook open, the UI shows live cursor positions and selection highlights for each user (with name + color). This is read-only awareness — both can edit, but they see where the other is working. Implemented via Convex presence subscriptions.

Real-time co-editing (CRDT-style merge) is out of scope. Users editing the same cell at the same time will produce optimistic-lock conflicts and reconciliation prompts.

---

## Import & Format Conversions

A workbook is canonical, but Signal interoperates with adjacent formats.

### Export formats

| Format | Purpose | Quality |
|--------|---------|---------|
| `.workbook` | Canonical Signal format | Lossless |
| `.ipynb` | Jupyter compatibility | Best-effort: code → cells, prose → markdown, charts → static images, runnable blocks → static |
| `.pdf` | Stakeholder reports | Pre-rendered via Puppeteer; cells are static; sized for print |
| `.md` | Documentation embedding | Manifest serialized to markdown; cells as fenced code blocks; charts as image links |
| `.xlsx` | Spreadsheet handoff | Tables only (one sheet per `table` block); charts as embedded images |
| `.html` (standalone) | Email-friendly | Same as `.workbook` portable mode but without runtime JS — pure pre-rendered HTML for read-only sharing |

All exports are generated on-demand from the canonical Convex record. None are cached on disk.

The `.ipynb` export is preserved as the most likely cross-tool migration path. Lossy: the manifest's structural blocks (input widgets, machine cards, schedule config, MCP tools) become markdown summaries since `.ipynb` has no equivalent.

### Import formats

| Format | What's mapped | What's lost |
|--------|---------------|-------------|
| `.ipynb` | Code cells → Python cells; markdown cells → markdown blocks; output images → embedded outputs | Magic commands, kernel metadata, custom cell metadata |
| `.csv` / `.tsv` | Data → SQLite layer table; auto-generates a `table` block | None — pure data import |
| `.xlsx` | Sheets → SQLite tables (one per sheet); auto-generates `table` blocks | Cell formulas, formatting, charts |
| `.workbook` | Full round-trip if `manifest.id` recognized; new workbook otherwise | None |
| `.parquet` / `.arrow` | Data → SQLite layer table | None |

Imports are explicit — drag-and-drop or "Import from file" in the dashboard. Auto-detection of file type. Preview before commit.

The `.ipynb → .workbook` import is documented in detail because it's the most likely migration path. Code cells are imported as Python `cell` blocks with `runtime: host`. Outputs are preserved as embedded outputs. The result is a working workbook that can be re-run in Signal.

---

## Snapshot History

Distinct from scheduled-run history (which captures one snapshot per cron firing): snapshot history captures **every save**.

### Snapshot triggers

A snapshot is created on:
- Every Convex mutation that changes `workbooks.blocks` (debounced text edits produce one snapshot per debounce; structural changes produce one each)
- Every cell run completion
- Every scheduled run
- Explicit "Save snapshot" action with a user-provided label

Snapshots are stored compactly: only the changed blocks plus a reference to the parent snapshot. Storage cost is sub-linear in workbook size.

Retention: 30 days for free tier, 1 year for paid, unlimited for explicitly labeled snapshots. Older snapshots are pruned (silently, with a notification).

### Time travel UI

A timeline scrubber at the top of the workbook UI shows snapshots as marks. Hovering a mark previews the workbook state at that snapshot. Clicking opens it in read-only "history view" — display blocks render as they were, cells show their saved outputs.

Restoring a snapshot creates a new snapshot whose state is a copy of the historic one. No destructive operations — restore is just another save.

### Branching

From any snapshot, a user can fork: "Create a new workbook from this snapshot." This produces a new `workbooks` record with a fresh slug, full block tree from the snapshot, and `provenance.forkedFrom: { workbookId, snapshotId }`. The fork is independent — edits to either don't affect the other.

This pattern is intended for "what if I tried this differently" exploration without polluting the main workbook with experiments.

### Snapshot diffs

Two snapshots can be diffed structurally — same machinery as scheduled-run diffs. Output: a list of which blocks were added, removed, or modified, and for cells, what their outputs changed. Renders inline in the timeline UI.

---

## Discovery

Users find workbooks four ways:

### Sessions panel

The left rail of Signal shows recent sessions, each with its associated workbook. Sorted by most recent activity. Pinned sessions (user-flagged) appear above unpinned.

### Search

Full-text search over:
- Workbook title, description, emoji
- Block content (paragraph, markdown, callout, code source, cell source)
- Cell output text content
- Tags

Implemented via Convex's search index. Results show a snippet with the match highlighted and the workbook's title as a link. Results respect permissions — users only see workbooks they have access to.

### Tags & folders

Workbooks support free-form tags (user-applied) and optional hierarchical folders. Tags are searchable; folders organize the dashboard view. Both are per-user (the same workbook can be tagged differently by different collaborators).

### Cross-workbook search

A specialized query: "show me every workbook that loads `customer-segments-v3`." This walks the dependency graph backwards via `provenance.dependencies` lookups. Useful for impact analysis: before deleting or renaming a workbook, see who depends on it.

Available as a dedicated search mode and as an automatic warning when archiving / deleting a workbook with dependents.

---

## Notifications & Comments

### Notifications

Configurable per user, with sensible defaults:

| Event | Default channel | Configurable |
|-------|----------------|--------------|
| Schedule run completes | None (just UI badge) | In-app, email, push, webhook |
| Schedule run errors | In-app + push | In-app, email, push, webhook |
| Workbook shared with you | In-app + email | All channels |
| You're @mentioned in a comment | In-app + push | All channels |
| Cross-workbook dependency you own is updated | None | In-app, email |
| Schedule about to hit quota | In-app + email | In-app, email, push |

Channels:
- **In-app**: notification center in the top bar
- **Email**: digest by default (daily summary), critical events immediate
- **Push**: mobile push via the Signal mobile app
- **Webhook**: outbound HTTPS POST with structured event payload, configured at org level

### Comments

Comments are anchored to block IDs. They appear in a sidebar when a block is selected.

Features:
- Threaded replies
- @mentions with notifications
- Resolve / unresolve
- Permalink to a specific comment (URL fragment)
- Markdown formatting + emoji reactions

Comments are stored in a separate `comments` table keyed by `(workbookId, blockId)` so they survive block reordering and are queryable independently.

Permission model: viewers can read comments; editors can post; owners can resolve and delete.

Comments do not appear in `.workbook` exports — they are Signal-app artifacts, not part of the document format. Future: optional embedded comments in `manifest.comments` for portability.
