# `.workbook.html` format

A workbook is a single HTML document with three layers added on top of
plain HTML:

1. A **manifest** — JSON describing the workbook
2. A **runtime** — inlined WASM + JS that exposes Polars, SQLite, ML
3. **Custom elements** — `<wb-cell>`, `<wb-doc>`, `<wb-memory>`, etc.

The browser parses it as ordinary HTML. Everything else is opt-in.

## Anatomy

```
<!doctype html>
<html>
<head>
  <link rel="icon" href="data:image/svg+xml;base64,…" />

  <!-- Manifest. Tells hosts what this workbook is. -->
  <script id="workbook-spec" type="application/json">
    {
      "manifest": {
        "name": "My thing",
        "slug": "my-thing",
        "type": "spa",          // "document" | "notebook" | "spa"
        "version": "0.1"
      }
    }
  </script>

  <!-- Save handler. Cmd+S → atomic save (workbooksd or download). -->
  <!-- BEGIN workbook-save-handler -->
  <script>(function() { /* injected by workbook build */ })()</script>
  <!-- END workbook-save-handler -->

  <!-- Install toast. Bottom-left card if no daemon detected. -->
  <!-- BEGIN workbook-install-toast -->
  <script>(function() { /* injected by workbook build */ })()</script>
  <!-- END workbook-install-toast -->

  <!-- Portable assets. Inlined wasm + bindgen + runtime bundle. -->
  <!-- BEGIN workbook-runtime -->
  <script id="wasm-b64" type="text/plain">…base64 wasm…</script>
  <script id="bindgen-src" type="text/plain">…wasm-bindgen JS…</script>
  <script id="runtime-bundle-src" type="text/plain">…runtime JS…</script>
  <!-- END workbook-runtime -->
</head>
<body>
  <!-- Author's content. Plain HTML, custom elements, anything. -->
  …

  <!-- Last-saved state, written by the save handler on Cmd+S. -->
  <script id="wb-saved-state" type="application/json">
    { "v": 1, "ts": 1716000000000, "forms": {…}, "localStorage": {…} }
  </script>
</body>
</html>
```

## Custom elements

| Element       | Purpose                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------ |
| `<wb-cell>`   | A computational cell — the unit of the reactive DAG. `language="rhai"\|"sql"\|"chart"\|…`. |
| `<wb-doc>`    | A persistent CRDT document (Loro/Yjs) embedded in the file. Think shared-data slot.        |
| `<wb-memory>` | An Apache Arrow buffer — append-only typed memory the runtime can read/write.              |
| `<wb-data>`   | A blob of bytes (CSV, SQLite, encrypted, …) the workbook reads at runtime.                 |

`<wb-doc>` and `<wb-memory>` round-trip through Cmd+S — the runtime
exports their current state and rewrites the elements before the file
is saved. That's what makes the file act like a database.

## Render-mode shape

The `manifest.type` field decides what hosts wrap the content with:

- `document` → minimal chrome; reads top-to-bottom like an article
- `notebook` → cell run-buttons + status indicators auto-attached
- `spa` → no chrome; the workbook owns the full viewport

When in doubt, default to `spa` — it's the least opinionated.

## State persistence

Two persistence layers, distinct and complementary:

| Layer           | What                                          | Round-trips on Cmd+S?            |
| --------------- | --------------------------------------------- | -------------------------------- |
| `wb-saved-state`| Form values, localStorage, sessionStorage     | Yes (default `serializeWorkbookState()`) |
| `<wb-doc>`      | CRDT-shaped data (rich text, lists, JSON)     | Yes (`exportDoc()` per element)  |
| `<wb-memory>`   | Arrow buffer of typed rows                    | Yes (`exportMemory()` per element)|

To override what gets saved:

```js
window.serializeWorkbookState = () => ({
  conversation: getMessages(),
  dataset:      ipc.toBase64(),
});
window.rehydrateWorkbookState = (state) => { /* restore */ };
```

## Constraints

- **CSP** — workbooks run with a strict CSP from sandboxed hosts. No
  arbitrary network fetches without the workbook spec declaring them.
- **Single file** — assets are inlined as `<script type="text/plain">`
  + base64. No external `<link>` or `<img src="./…">` references.
- **Determinism** — `Math.random()` and `Date.now()` should not drive
  visible state without a seed; the substrate's integrity guard treats
  the file as content-addressable.

For deeper format details: see `docs/WORKBOOK_SPEC.md` in the workbooks repo.
