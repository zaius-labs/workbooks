# @work.books/substrate

Workbook substrate v0 — file-as-database persistence for workbook HTML files.

## Goal

A workbook is a single `.html` file that is *the* database. State (yjs CRDT bytes for the spec/composition, optionally SQLite bytes for relational data) lives inline in the file. Edits are persisted by writing the file back to disk through the strongest transport available on the user's browser/OS.

## File model (v0)

```
<!DOCTYPE html>
<html>
<head>
  <meta name="workbook-substrate" content="v0">

  <script type="application/json" id="wb-meta">
    {"workbook_id": "uuid", "schema": 0, "runtime_version": "0.1.0"}
  </script>

  <!-- Cold image. Compacted periodically. One per data container. -->
  <script type="application/octet-stream"
          id="wb-snapshot:composition"
          data-cid="bafy…"
          data-format="yjs">base64…</script>

  <script type="application/octet-stream"
          id="wb-snapshot:data"
          data-cid="bafy…"
          data-format="sqlite">base64…</script>

  <!-- Hot log. Append-only at the format level; physical writes
       depend on the transport. -->
  <script type="application/json" id="wb-wal">
  [
    {"seq": 1, "target": "composition", "parent_cid": "bafy…",
     "cid": "bafy…", "payload_b64": "…"},
    {"seq": 2, "target": "data", "parent_cid": "bafy…",
     "cid": "bafy…", "payload_b64": "…"}
  ]
  </script>

  <script type="module" id="workbook-runtime">…</script>
</head>
<body>
  <div id="app"></div>
</body>
</html>
```

All persisted bytes live inside `<script type="application/octet-stream">` or `<script type="application/json">` data blocks — parser-inert, content preserved verbatim, retrievable via `document.getElementById(id).textContent` or via `fetch(self.location).then(r => r.text())` for binary-safe extraction.

## Status

In development. See `spikes/` for in-progress feasibility studies and `bd show core-1ja` for the project plan.
