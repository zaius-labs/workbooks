# Svelte SDK ↔ Yjs ↔ Workbooks: design notes

This is a thinking document. The goal: figure out what the *fully*
realized persistent-state story looks like for workbook authors using
Svelte 5, and then plan the path between today and that.

---

## The shipped baseline

What lives at `@work.books/runtime/svelte` today:

```svelte
import { state, list, text } from "@work.books/runtime/svelte";

const counter     = state("counter", 0);
const plugins     = list<Plugin>("plugins");
const composition = text("composition", "<html>");
```

Each is a class instance with a Svelte-reactive `.value` / `.list`
getter, mutation methods, and a `.ready()` promise. Reads register
dependencies in `$effect` / `$derived`. Writes go to a Y.Doc; the
substrate's WAL captures Y.Doc updates; the file rewrites on save.

This works. But it leaves a few things on the table.

---

## Where Yjs and Svelte 5 already fit naturally

This is the part worth understanding before the gaps. Both systems
are built on the same idea:

1. **Mutable values that broadcast their changes.** Y.Map, Y.Array,
   Y.Text fire observer events on every mutation. Svelte 5 `$state`
   variables are signals that fire dependent re-evaluations on every
   write. Same shape, different name.

2. **Per-property reactivity, not per-snapshot.** Svelte 5 doesn't
   re-render a whole component when one field changes — only the
   templates / `$effect`s that actually read that field re-run. Yjs
   observers fire only on the keys that changed. Both are
   fine-grained.

3. **Local-first.** Svelte's reactivity is in-process; Yjs's CRDT
   layer keeps multiple in-process states converging. They compose.

The pattern that emerges: **Y.Doc as the durable state graph,
Svelte 5 runes as the reactive read-side.** Writes go through the
durable layer; reads go through the reactive layer; the two are kept
in sync by a thin observer bridge.

That's exactly what `state` / `list` / `text` do today. So at the
primitive level, we're aligned. The question is whether the *shape*
exposed to authors makes the most of the pairing.

---

## Five things we could do that the current SDK doesn't

### 1. Proxy-based root state (the SyncedStore pattern)

The most ergonomic API would let authors write:

```svelte
<script>
  const app = wb.app({
    count: 0,
    user: { name: "alice", theme: "dark" },
    todos: [],
  });
</script>

<button onclick={() => app.count++}>{app.count}</button>
<input bind:value={app.user.name} />

{#each app.todos as todo}
  <li>{todo.text}</li>
{/each}
```

No `.value`. No `.list`. Just an object that *behaves* like JS but
persists to Y.Doc. Reads through a Proxy register Svelte deps; writes
go straight to Y.Maps / Y.Arrays underneath. Nested objects → nested
Y.Maps, arrays → Y.Arrays, all transparently.

This is what the [SyncedStore](https://syncedstore.org/) library does
for Yjs in the React/plain-JS world. We can either:

- **Adopt it.** Mature, MIT, ~few KB. Wrap with our SDK conventions.
- **Build our own.** Better Svelte 5 integration, no extra dep, more
  control. ~1–2 days of work.

The current `state` / `list` / `text` primitives stay — they're the
right tool for *individual* persistent atoms (a single counter, a
single body of text). `wb.app()` would be the right tool for the
"persistent app shape" of bigger workbooks.

**Why this matters**: it's the difference between "I have to think
about persistence" and "I just write Svelte code." Most authors will
default to the latter as soon as they realize the option exists.

### 2. `<WorkbookReady>` suspense boundary

Y.Doc registration is async — the runtime creates it after parsing
the workbook spec, not at module load. Svelte components mount
synchronously. So today, components might render with default values
for one tick and then re-render with hydrated values once Y.Doc
binds. That causes flicker on cold load.

A boundary component fixes it:

```svelte
<WorkbookReady fallback={<Spinner />}>
  <App />
</WorkbookReady>
```

`<App />` only mounts after Y.Doc is bound. No flash of default
state. The fallback covers the (typically short, ~50–200ms) window.

Uses `await wb.ready()` under the hood + an `{#await}` template.

### 3. Y.UndoManager wired into the SDK

Y.Doc has built-in undo/redo via `Y.UndoManager` — it tracks
mutations on a scope and exposes `.undo()` / `.redo()`. The SDK
should expose this directly:

```svelte
import { undoManager } from "@work.books/runtime/svelte";

// Cmd+Z / Cmd+Shift+Z ↔ undoManager.undo() / .redo()
// Listed for awareness in the menubar; doesn't need plumbing.
```

This gives every workbook free, automatic undo across *every piece of
persistent state*, without authors writing a single undo handler.
That's a real and visible UX win — and it's a feature that's
impossible (or expensive) to add later if state lives in plain
`$state` instead of Y.Doc.

### 4. Eliminate the `wb-saved-state` second-channel

Today there are TWO persistence paths a workbook can use:

- The substrate's WAL (Y.Doc-backed) — committed via the daemon.
- `<script id="wb-saved-state">` written by `saveHandler.mjs` — captures form
  values, localStorage, sessionStorage on Cmd+S; restored on load.

These don't compose. If a workbook uses substrate, the saveHandler
script is bypassed by colorwave's autosave override; if a workbook
doesn't use substrate, the WAL never gets written. Authors have to
know which path they're on.

The end state: **Y.Doc is the only persistence path.** The
`wb-saved-state` script goes away. Everything flows through wb.* /
runtime/svelte primitives. Forms get a `bind:value={someState.value}`
helper or a directive. localStorage migrators run on first boot.

This is the big "no exceptions" simplification. It also makes
substrate's hydration the single source of truth — no race between
WAL replay and saveHandler rehydrate.

### 5. Schema versioning + migrations

State schemas evolve. v1 had `darkMode: bool`; v2 has `theme: "dark"
| "light"`. Without migrations, an old saved file will deserialize
with the wrong shape and silently break.

```ts
const settings = wb.state("settings", {
  schema: 2,
  default: { theme: "dark", density: "comfortable" },
  migrate: {
    1: (v1) => ({
      theme: v1.darkMode ? "dark" : "light",
      density: "comfortable",
    }),
  },
});
```

The SDK runs migrations once on first read post-hydration, then
writes the migrated state back. Authors get clean version transitions
without writing migration plumbing.

---

## Two real points of friction (worth naming, not necessarily solving)

### Friction 1: Svelte 5 runes are compiler magic

`$state`, `$derived`, `$effect` are not runtime APIs. They're macros
the Svelte compiler rewrites at build time. We **cannot** ship a
factory function that returns a bare reactive variable — there's no
runtime hook to register one.

The closest we get is class fields with `$state.raw` (which we do
today) or `$state` (works but adds deep proxying we usually don't
want). Hence the `.value` accessor.

The SyncedStore-style Proxy pattern threads this needle — `app.count`
*reads* like a bare variable in templates, even though under the hood
it's a Proxy + reactive class.

### Friction 2: JSON is a lossy serializer

`Y.Map.set("v", JSON.stringify(value))` works for 95% of data, but
loses `Date`, `Map`, `Set`, `Uint8Array`, `BigInt`, undefined, etc.
For workbook authors who pass arbitrary JS values into state, that
gotcha will eventually bite.

The fix: ship with a richer serializer (superjson / devalue). Adds
~3 KB, captures all standard JS types correctly. Not urgent but worth
queueing.

---

## What I'd land first

In order of impact-per-effort:

| # | item                          | rough scope | impact |
|---|-------------------------------|-------------|--------|
| 1 | `<WorkbookReady>` boundary    | 30 min      | high (eliminates flash) |
| 2 | Proxy-based `wb.app()`        | 1–2 days    | very high (UX leap) |
| 3 | Y.UndoManager exposure        | 2 hrs       | high (free undo everywhere) |
| 4 | Migrate colorwave to runes-SDK | 3–4 hrs    | unblocks the user RIGHT NOW |
| 5 | Schema versioning             | half-day    | low until v2 of any workbook |
| 6 | Eliminate wb-saved-state      | half-day    | medium (consistency) |
| 7 | Richer serializer (devalue)   | 1 hr        | low until someone hits Date |

Items 1, 3, 4 stack into one tight session: ship the suspense
boundary, expose undo, migrate colorwave, get save-round-trip working
end to end. Item 2 is the bigger architectural step that changes how
workbooks feel to author; worth doing as its own focused unit.

Items 5–7 are all "queue them and revisit." None block today's
problems.

---

## Open questions

1. **Adopt SyncedStore or build our own Proxy wrapper?** Adoption is
   faster, less to maintain, but a shared dep we don't fully control.
   Building our own is ~1–2 days of focused work for a tighter Svelte
   5 fit.

2. **Should `wb.app()` be the *primary* API, with `state` / `list` /
   `text` becoming the "low-level" primitives?** Or do we keep both
   first-class? My instinct: `wb.app()` is the primary, `state` /
   `list` / `text` for atomic state outside an app object.

3. **Where does the runtime-fetched data sit?** External fetches
   (CSVs, models, API responses) aren't persisted-app-state — they're
   loaded from URL or `<wb-data>` blocks. Should they be in `wb.app()`
   or kept separate? My instinct: separate, via the existing
   workbookDataResolver. Persistent state is about *user-mutable*
   things, not all data.
