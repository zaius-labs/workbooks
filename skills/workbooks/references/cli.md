# `workbook` CLI

The CLI ships as `@work.books/cli`. Install globally or use via
`bunx`/`npx`.

```bash
npm install -g @work.books/cli
# or, ad-hoc:
bunx -p @work.books/cli workbook <command>
```

## Commands

```
workbook init <name>         scaffold (--template=spa | document | notebook)
workbook dev   [project]     dev server with HMR (default :5173)
workbook build [project]     compile to dist/<slug>.workbook.html
workbook check [project]     lint the project
workbook explain <rule>      print rationale + fix for a check rule
workbook encrypt             wrap a payload in a passphrase lock
workbook keygen              generate an Ed25519 author keypair
```

## `workbook init`

```
workbook init my-thing                     # default: spa
workbook init my-notebook --template=notebook
workbook init my-doc      --template=document
```

Drops a project tree:

```
my-thing/
├── package.json
├── workbook.config.mjs
└── src/
    └── index.html
```

`workbook.config.mjs` declares the slug, version, render-shape, env
vars the workbook needs at runtime, and any Vite plugins.

## `workbook dev`

Starts a Vite-based dev server with the runtime served from
`/__workbook/` (no inlining, fast reload). Use this while authoring.

```bash
workbook dev
# → http://localhost:5173
```

The dev server is local-only. Don't ship a workbook by exposing the
dev server to the network.

## `workbook build`

Bundles the project into a single `.workbook.html` file. The pipeline:

1. Vite assembles the user code (single-file plugin)
2. Workbook plugin injects:
   - workbook-spec manifest
   - save handler (Cmd+S → workbooksd or FSA-API)
   - install toast (bottom-left card if no daemon detected)
   - portable runtime assets (base64 wasm + bindgen + bundle)
3. The whole HTML is wrapped in a DecompressionStream sandwich so the
   on-disk size shrinks ~3x while keeping the file self-contained

```bash
workbook build
# → dist/my-thing.workbook.html  (typical: 800 KB – 8 MB)
```

Output is always `dist/<slug>.workbook.html`. **Don't rename it to
`<slug>.html`** — the double extension is required by the workbooksd
path validator and the macOS file-type association.

### Build flags

```
--out <dir>     output directory (default dist)
--no-wasm       skip inlining wasm + runtime bundle (smaller; dev only)
--encrypt       wrap the artifact in an age-v1 passphrase lock screen
                pair with --password-stdin / --password-file
                or set encrypt.passwordEnv in workbook.config.mjs
                (default WORKBOOK_PASSWORD)
```

## `workbook check`

Lints the project source for the rules the runtime cares about. Fast;
run it before commit.

```bash
workbook check
# → reports rule violations with severity + fix hints
workbook check --reporter=json    # tool-friendly
```

When a rule fails, run `workbook explain <rule-id>` to read its
rationale and fix recipe.

## `workbook explain`

```bash
workbook explain manifest-missing-slug
```

Prints the rule's rationale + a concrete fix. Use this instead of
guessing.

## `workbook encrypt`

Wrap a payload (CSV, SQLite, secrets) inside a `<wb-data>` element
with age-v1 passphrase + optional X25519 recipients.

```bash
workbook encrypt \
  --in dataset.csv \
  --out src/data.html \
  --id customers \
  --mime text/csv \
  --password-stdin
```

The lock screen is a tiny pre-runtime gate: the workbook won't
hydrate until the passphrase or a registered identity unlocks the
data block.

## `workbook keygen`

Generate an Ed25519 keypair for signing workbooks. Used by hosts that
verify provenance (`signal-workbooks` worker, etc.).

```bash
workbook keygen --out wb-author.key
```

## Common config knobs

`workbook.config.mjs`:

```js
export default {
  name: "My thing",
  slug: "my-thing",
  type: "spa",                // "document" | "notebook" | "spa"
  version: "0.1",
  entry: "src/index.html",
  // disable the install toast for cloud-hosted workbooks where
  // pointing users at workbooks.sh doesn't apply:
  installToast: { enabled: false },
  // disable Cmd+S save flow (rare):
  save: { enabled: false },
  // declare runtime env vars the workbook will prompt for at first run:
  env: {
    OPENROUTER_API_KEY: { label: "OpenRouter key", prompt: "sk-or-…", required: true, secret: true },
  },
  // standard Vite config — anything here flows through:
  vite: { plugins: [/* … */] },
};
```
