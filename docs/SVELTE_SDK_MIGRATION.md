# Migrating to `@work.books/runtime/svelte`

How to move a Svelte 5 workbook (or workbook-style app like colorwave)
from local `$state` + localStorage to persistent state via Y.Doc, with
no flicker and free undo/redo.

---

## TL;DR — what you replace, with what

| before                                            | after                                          |
|---------------------------------------------------|------------------------------------------------|
| `let count = $state(0)`                           | `app.count` (inside `<WorkbookReady>`)         |
| `let items = $state([])` + push/splice            | `app.items` array directly                     |
| `localStorage.setItem("k", v)` + `getItem("k")`   | `app.k = v`                                    |
| `let body = $state("")` (long text, multi-author) | `wb.text("body", "default")`                   |
| Cmd+Z / Cmd+Y handlers                            | `undo().bindKeyboard()` once at app mount      |

Everything in `app.*` round-trips through the workbook file. Refresh
restores it. Multi-tab edits merge via CRDT.

---

## Step 1 — wrap the app in `<WorkbookReady>`

The boundary suspends children until the Y.Doc binds. Without it,
`wb.app()` would have to await asynchronously, which is awkward at
the top of every Svelte component. Wrap once at the root:

```svelte
<!-- App.svelte -->
<script>
  import { WorkbookReady } from "@work.books/runtime/svelte";
  import RealApp from "./RealApp.svelte";
</script>

<WorkbookReady>
  {#snippet fallback()}
    <div class="boot">Loading…</div>
  {/snippet}

  <RealApp />
</WorkbookReady>
```

`<WorkbookReady>` resolves immediately on hot reloads (the Y.Doc is
cached); cold loads see the fallback for ~50–200 ms while the runtime
parses the workbook spec.

---

## Step 2 — declare your app shape

In the component that *owns* the persistent state (typically the root
of the real app), declare the shape with `wb.app()`:

```svelte
<!-- RealApp.svelte -->
<script>
  import { app, undo } from "@work.books/runtime/svelte";

  type Plugin = { id: string; name: string; enabled: boolean };

  const state = app({
    count: 0,
    user: { name: "alice", theme: "dark" },
    plugins: [] as Plugin[],
    layout: { chatWidth: 500, leftTab: "chat" },
  });

  const u = undo();
  u.bindKeyboard();
</script>

<button onclick={() => state.count++}>{state.count}</button>
<input bind:value={state.user.name} />
<input type="number" bind:value={state.layout.chatWidth} />

<button onclick={() => state.plugins.push({ id: crypto.randomUUID(), name: "x", enabled: true })}>
  Add plugin
</button>

<ul>
  {#each state.plugins as plugin (plugin.id)}
    <li>
      <input type="checkbox" bind:checked={plugin.enabled} />
      {plugin.name}
    </li>
  {/each}
</ul>

<button onclick={() => u.undo()} disabled={!u.canUndo}>Undo</button>
<button onclick={() => u.redo()} disabled={!u.canRedo}>Redo</button>
```

Notes:

- **No `.value`** — read and write `state.x` directly. Reads register
  Svelte deps via the Proxy + an internal reactor.
- **Nested objects** become Y.Maps, **arrays** become Y.Arrays — but
  authors don't have to think about that. Mutations look like plain
  JS.
- **`bind:value`** works because `state.x = …` sets through the Proxy.
- **Defaults** on top-level keys are seeded only if the underlying
  Y.Map / Y.Array is empty after hydration. Existing user state always
  wins.

---

## Step 3 — for state that doesn't fit `wb.app`

| use case                              | use this                              |
|---------------------------------------|---------------------------------------|
| a single scalar outside any app shape | `state(id, default)`                  |
| a long string with multi-author edits | `text(id, initial)`                   |
| a record list with stable `.id`s      | `list<T>(id)`                         |

```ts
import { state, text, list } from "@work.books/runtime/svelte";

const sessionCounter = state("session-count", 0);
const composition = text("composition", "<html>");
const plugins = list<Plugin>("plugins");

sessionCounter.value++;        // .value because no proxy at this level
composition.value = "<html>…"; // diff-shrunk write
plugins.upsert({ id: "x", … });
plugins.list;                  // T[]
```

These are the same primitives `wb.app()` is built on. Most workbooks
will use `wb.app()` for the bulk of their state and reach for
`state` / `text` / `list` only for cross-component atoms.

---

## Step 4 — drop your old persistence plumbing

Once state moves to `wb.app`, you can usually delete:

- `localStorage.setItem` / `getItem` calls — `app.*` reads from /
  writes to Y.Doc, the substrate captures the deltas, the file
  persists.
- Reactive `$state` declarations whose only job was to mirror
  localStorage.
- Any custom autosave timers — substrate's WAL plus `Cmd+S` handles it.
- Manual undo/redo logic — `wb.undo()` does it for free across all
  app state.

---

## Step 5 — keep these as-is (don't migrate)

Some state should NOT live in the workbook file:

- **Per-browser UI preferences** that the user wants to control
  independently of which workbook they're viewing (monitor sizes,
  keyboard shortcut customizations). Keep these in localStorage.
- **Secrets** — API keys belong in localStorage namespaced to the
  workbook, never in the saved file. Use `getEnv()` / `setEnv()`
  helpers like `examples/svelte-app/src/routes/Settings.svelte` does.
- **External resources** — fetched CSVs, model weights, API
  responses. The workbook *uses* them but doesn't *own* them. Load
  via URL or the existing `<wb-data>` block.
- **Transient UI state** — modal-open booleans, hover states,
  drag-in-progress flags. These are session-scoped, not document
  state. Plain `$state` is right for these.

The rule of thumb: **if the user expects this to be there when they
share the file with someone else, persist it. Otherwise, don't.**

---

## Common pitfalls

### Pitfall 1: `wb.app()` outside `<WorkbookReady>`

```ts
// THROWS — Y.Doc not bound yet
const app = wb.app({ count: 0 });
```

The boundary is required. The error message points at this directly.

### Pitfall 2: passing a non-stable shape

```ts
// Bad — creates a new shape on every render
{#each items as item}
  <ChildComponent state={app({ inner: item })} />
{/each}
```

`wb.app()` should be called once per persistent state surface, not in
loops or render functions. Hoist it to module or component-init scope.

### Pitfall 3: mutating defaults

```ts
const DEFAULT = { count: 0 };
const app = wb.app(DEFAULT);
app.count++;
console.log(DEFAULT.count); // ⚠ might be 1
```

Pass a fresh object literal each time, or freeze your defaults. The
Proxy's writes can leak through to the input shape on first
materialization.

### Pitfall 4: assuming JSON fidelity

```ts
const app = wb.app({ when: new Date() });
// On reload, app.when is a string, not a Date.
```

We use JSON encoding under the hood — `Date`, `Map`, `Set`, `BigInt`,
`Uint8Array` all round-trip lossy. Stick to plain JSON shapes. (A
richer serializer is on the horizon — see task #28.)

---

## Verifying the round-trip

Once migrated:

1. Open the workbook via `workbooksd open <path>`
2. Mutate state in the UI
3. Cmd+S (the workbook runtime's save handler / substrate autosave
   commits all of `wb.app`'s state at once)
4. Refresh the tab
5. State should be exactly as you left it

If any specific state surface doesn't survive, it's because:

- It's still in plain `$state` — migrate it.
- It's in localStorage — migrate it (or accept that it's per-browser).
- It's on a value type that JSON can't represent — coerce it (`Date`
  → ISO string).

---

## Questions / horizon

- **Schema versioning** — when shape v1 → v2, you'll need migrations.
  Tracked in task #26. Today: rename the key, leave the old data,
  ship a one-time migrator.
- **TOON serialization** for token-efficient agent context — task #25.
- **Eliminate the `wb-saved-state` script** — task #27. Once everyone
  migrates to `wb.app`, the second persistence channel goes away.
