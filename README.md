<!-- README — workbooks -->

<h1 align="center">Workbooks</h1>

<p align="center">
  <strong>Portable HTML mini-apps. One file. Email it. It runs anywhere.</strong><br/>
  <sub>The CLI compiles a project tree into a single .html, with the source bundled inside.</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@work.books/cli"><img src="https://img.shields.io/npm/v/@work.books/cli?style=flat-square&labelColor=0a0a0a&color=34d399&label=cli" alt="npm cli"></a>
  <a href="https://www.npmjs.com/package/@work.books/runtime"><img src="https://img.shields.io/npm/v/@work.books/runtime?style=flat-square&labelColor=0a0a0a&color=f5f5f5&label=runtime" alt="npm runtime"></a>
  <img src="https://img.shields.io/badge/license-Apache--2.0-6b7280?style=flat-square&labelColor=0a0a0a" alt="Apache-2.0">
</p>

---

## Why workbooks

Every device on Earth ships a browser. None of them ship Word, Excel,
Photoshop, or your favourite IDE. The browser is the only universal
viewer humans have agreed on.

But the browser was built for *visiting* — open a URL, look at a page,
move on. It was never designed to be the format for **artifacts you ship
to someone**: a chart with the data in it, a notebook with the
analysis baked in, a tool that works the moment you double-click.

Workbooks is the missing piece. The CLI takes your project — Svelte,
React, vanilla, whatever — and compiles it into a single self-contained
`.html` that runs in any browser. Your charts, your code, your data,
your fonts — all inlined. The recipient double-clicks and it just runs.

Better still: the CLI also embeds your **source tree** inside the .html
(gzipped, ignored by the browser, recovered with `workbook unbundle`).
The artifact is portable AND iterable — recipients can extract the
source, tweak it, rebuild. No server. No deploy. No login. Just a file.

---

## What's in the file

A workbook is **one HTML file**. Open it in any browser and it renders
— without anything installed.

Three things are inlined:

- **The runtime + your code** — what `workbook build` produces. Single JS chunk, no external CDN, no fetch on open. Wasm runtimes (Polars / Rhai / Plotters / Candle) ship inside the file when you opt into them.
- **The source bundle** — a gzipped JSON snapshot of your project tree (default on, opt out with `--no-bundle`). Recovers via `workbook unbundle`. Optional `.git/` history with `--bundle-git`.
- **Author claim + integrity guard** — optional Ed25519 signature over the artifact bytes. Recipients can verify the file came from you and hasn't been altered.

Share the file → you ship the artifact AND the source it came from.

---

## Try one

```sh
npm install -g @work.books/cli
workbook init my-thing --template=spa
cd my-thing
workbook dev          # Vite dev server, HMR
workbook build        # produces dist/my-thing.html
```

Out comes one `dist/my-thing.html` file. Email it. Drop it on a USB
stick. Put it on a CDN. It opens anywhere — it's plain HTML.

A recipient who wants to iterate:

```sh
workbook unbundle my-thing.html ./my-thing-source
cd my-thing-source && npm install
workbook dev
```

Their tree matches yours, modulo the ignored bits (no `node_modules`,
no `.env`, no `.git` unless you opted in).

---

## When you need persistence

Some workflows need state to survive a session: a binder of dashboards
shared between teammates, a chart whose data updates daily, a notebook
multiple people co-edit.

For those, share via **[workbooks.sh](https://workbooks.sh)** — upload
the `.html`, get a URL, recipients sign in with their own identity and
their state persists per-user. The `.html` stays portable; the hosted
view adds login, storage, and sharing.

You don't have to host a workbook to share it. Hosting is the path
**when you want recipients to keep their own state across sessions**.
For one-off artifacts (a cool chart, a tool, a presentation, a
self-contained calculator) the bare `.html` is the answer.

---

## Author config

A starter `workbook.config.mjs`:

```js
export default {
  name: "my thing",
  slug: "my-thing",
  type: "spa",                 // "document" | "notebook" | "spa"
  entry: "src/index.html",
  wasmVariant: "app",          // "app" | "minimal" | "default"
  // Source bundle is on by default. Opt out for proprietary trees:
  // bundle: false,
  // Or trim what travels:
  // bundle: { additionalIgnore: ["fixtures/", "*.bak"] },
  // Or include git history:
  // bundle: { includeGit: true },
};
```

Build flags:

```
workbook build [project]
  --no-bundle      skip embedding the source bundle
  --bundle-git     include the .git/ directory in the bundle
  --no-wasm        skip wasm + runtime inlining (dev-only, smaller files)
  --encrypt        wrap in a passphrase lock screen (age-v1)
  --out <dir>      output directory (default dist/)
```

Author guides:
[docs/WORKBOOK_AUTHORING.md](docs/WORKBOOK_AUTHORING.md) ·
[docs/SPEC.md](docs/SPEC.md) ·
[docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md).

---

## What's possible

A workbook is not "an app" or "a notebook" — it's a *shape*:

- **Charts with their data inside** — drop a Vega-Lite spec + JSON, share a single .html that re-renders the chart anywhere.
- **SQL workbenches** — Polars or DuckDB inlined, queries embedded, the recipient runs them locally.
- **Reactive notebooks** — cells, DAG, hot recompute. Cell sources travel with the file via the source bundle.
- **Self-contained micro-apps** — chess, drawing tools, image editors, calculators. State held in URL fragments or localStorage.
- **LLM-agent-authored artifacts** — colorwave, sift. Agents emit deliberately-structured workbooks (sections + outline + audit) that ship as portable HTML.
- **Encrypted workbooks** — passphrase-locked at rest, opened with the runtime; secrets never round-trip through any server.

The constraint isn't the format. The constraint is figuring out what
*you* want to put in a file that opens forever.

---

## Pieces

| Package | What | Notes |
|---|---|---|
| `packages/workbook-cli` | `workbook init`, `dev`, `build`, `unbundle`. | npm: `@work.books/cli` |
| `packages/runtime` | Browser-side runtime + SDK (`wb.text`, `wb.collection`, `wb.app`, `wb.secret`, `wb.fetch`). | npm: `@work.books/runtime` |
| `packages/runtime-wasm` | The Rust + WASM heavy lifters (Polars, Plotters, Rhai, Candle). Three pre-built feature slices. | npm: `@work.books/runtime-wasm` |
| `packages/workbook-substrate` | File-as-database parser + hydrator (used by save-in-place workbooks running under the legacy daemon). | npm: `@work.books/substrate` |
| `packages/workbooksd` | **Legacy.** Local Rust daemon for save-in-place editing. See "Legacy daemon" below. | ~1 MB single binary |
| `examples/` | Reference workbooks — each ships a built `.html` you can open. | clone-and-open |
| `docs/` | Spec, operations, security model. | start [here](docs/SPEC.md) |

---

## Legacy daemon

Earlier versions of workbooks centered on a small Rust daemon
(`workbooksd`) that brokered save-in-place — double-click a `.html`,
edit it, hit ⌘S, the bytes on disk update. The daemon is real, it
works, it's signed + notarized for macOS. It's still in this repo.

We've moved away from it as the **primary** model because:

- The macOS install + signing + Gatekeeper + LaunchServices routing
  story is high-cost for low-value-to-most-users.
- The dominant use case is shipping a finished artifact to someone,
  not co-editing one over time.
- Persistence-heavy workflows are better served by the hosted
  [workbooks.sh](https://workbooks.sh) viewer where users sign in
  with their own identity.

The daemon stays in-tree as a local-power-user tool. If you want
save-in-place locally, you can still install it. We're not building
new features for it; we're not deleting it either. Treat it as a niche.

---

## Status

**CLI** — published on npm (`@work.books/cli`). Stable. v0.5.0 added the
source-bundle stage.

**Runtime + runtime-wasm slices** — published on npm. Stable.

**Daemon** — legacy. Continues to ship signed builds for macOS / Linux
/ (pending) Windows. No new features planned.

**Hosted viewer (workbooks.sh)** — separate hosted surface; not in this
repo. The lander redirects you there.

The architecture is settled. The roadmap from here is about more
shapes, more examples, sharper docs.

---

## Questions you might have

**Is this just an Electron alternative?**
No. Electron ships a browser engine *with each app* (~150 MB). A workbook
ships nothing extra — your browser is the browser. A workbook .html
averages 1–10 MB depending on the WASM slice you opt into.

**Is this just a static-site generator?**
Closer, but no. An SSG builds an HTML file. A workbook is an HTML file
that bundles its own source tree, runtime, and (optionally) wasm
heavy-lifters. The recipient can extract the source and rebuild — try
that with a Hugo site.

**Why bundle the source?**
Because the artifact-and-its-source-as-one-file is the unique thing
the format unlocks. Recipients aren't blocked behind "find the repo,
clone it, hope it builds." Open the .html, run `workbook unbundle`,
iterate.

**What about state and login?**
Use [workbooks.sh](https://workbooks.sh) for hosted state. The local
daemon is legacy; we're not the right tool if you need a daemon-driven
save loop on every recipient's machine.

**Is the runtime open source?**
Yes. Apache-2.0. The whole repo: daemon, cli, runtime, runtime-wasm,
substrate. Anyone can build from source.

---

<p align="center">
  <strong>workbooks.sh</strong><br/>
  <sub>portable html mini-apps that travel with their source.</sub>
</p>
