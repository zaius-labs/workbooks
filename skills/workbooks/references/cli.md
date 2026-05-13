# `workbook` CLI

The CLI ships as `@work.books/cli`. Install globally or use via
`bunx`/`npx`.

```bash
npm install -g @work.books/cli
# or, ad-hoc:
bunx -p @work.books/cli workbook <command>
```

## Commands

Authoring:

```
workbook init <name>         scaffold (--template=spa | document | notebook)
workbook dev   [project]     dev server with HMR (default :5173)
workbook build [project]     compile to dist/<slug>.html
workbook check [project]     lint the project
workbook explain <rule>      print rationale + fix for a check rule
workbook encrypt             wrap a payload in a passphrase lock
workbook keygen              generate an Ed25519 author keypair
workbook unbundle <html>     extract embedded source bundle
```

Publishing + portal control plane (talks to auth.workbooks.sh):

```
workbook publish <html>      upload artifact → workbooks.sh/w/<id>
workbook env <action>        manage group env vars (list/set/rotate/delete/import)
workbook group <action>      list groups, members, workbooks, invite teammates
workbook mcp serve           expose all of the above as MCP tools for AI clients
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

Bundles the project into a single `.html` file. The pipeline:

1. Vite assembles the user code (single-file plugin)
2. Workbook plugin injects:
   - workbook-spec manifest
   - save handler (Cmd+S → File System Access API where supported, or
     legacy daemon path for users who have `workbooksd` installed)
   - portable runtime assets (base64 wasm + bindgen + bundle)
3. The whole HTML is wrapped in a DecompressionStream sandwich so the
   on-disk size shrinks ~3x while keeping the file self-contained
4. The compiled `.html` gets a gzipped source-bundle embed (default on)
   so recipients can `workbook unbundle` it back to source

```bash
workbook build
# → dist/my-thing.html  (typical: 800 KB – 8 MB)
```

Output is always `dist/<slug>.html`. Workbook identity is
content-based (`<meta name="wb-permissions">` / `<script id="wb-meta">`),
not filename-based.

The build embeds a gzipped JSON snapshot of the project source by
default — recipients can `workbook unbundle <file.html>` to recover the
project tree. Browsers ignore the embedded data entirely (the embed
uses a non-script `type` attribute), so it costs zero parse / render
overhead.

### Build flags

```
--out <dir>     output directory (default dist)
--no-wasm       skip inlining wasm + runtime bundle (smaller; dev only)
--no-bundle     skip embedding the source bundle (default ON)
--bundle-git    include the .git/ directory in the source bundle
--encrypt       wrap the artifact in an age-v1 passphrase lock screen
                pair with --password-stdin / --password-file
                or set encrypt.passwordEnv in workbook.config.mjs
                (default WORKBOOK_PASSWORD)
                (encrypted artifacts skip the source bundle automatically)
```

## `workbook unbundle`

Extracts the embedded source bundle from a built `.html` back into a
working source tree.

```bash
workbook unbundle path/to/my-thing.html ./my-thing-source
# default outDir is `<basename>-source/`
# --force overwrites a non-empty existing dir
```

Empty or non-bundled artifacts (built with `--no-bundle`) error out
with a clear message.

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

## `workbook publish`

Uploads a built `.html` to workbooks.sh and prints a public viewer URL.
On first use, opens the browser for a one-time loopback OAuth and caches
a bearer at `~/.config/workbooks/auth.json`.

```bash
workbook publish dist/my-thing.html
# → https://workbooks.sh/w/<id>

workbook publish dist/my-thing.html --group <gid>
# → gated to members of <gid>

workbook publish --revoke <id>
```

For unattended / CI use, set `WORKBOOKS_API_TOKEN=wbat_...` (create one
under Studio → Settings → API tokens) — the CLI skips the browser flow
entirely.

## `workbook env`

Manage the group-scoped environment variables the broker splices into
outbound workbook calls. **Authors** declare destinations + splice
rules in `workbook.config.mjs` (the `connect:` block); **admins** set
the values here. Plaintext only ever lives at the broker.

```bash
workbook env list --group <gid>

workbook env set OPENAI_KEY sk-... --group <gid>           # group-wide
workbook env set OPENAI_KEY sk-... --group <gid> \
                                   --workbook <wid>        # one workbook

workbook env rotate <env-var-id> --value sk-... --group <gid>
workbook env delete <env-var-id> --group <gid>
workbook env import .env --group <gid> [--replace]         # bulk paste
```

## `workbook group`

```bash
workbook group list                                # groups you belong to
workbook group members   --group <gid>             # roster + invites
workbook group workbooks --group <gid>             # workbooks in the group
workbook group invite teammate@example.com --group <gid> [--role admin|member]
```

## `workbook mcp serve`

A stdio MCP (Model Context Protocol) server that exposes every
publish / env / group / usage operation as a structured tool. Use it
to drive a Workbooks Studio account from Claude Code, Cursor, or any
other MCP client.

Claude Code config (`~/.claude/mcp.json`):

```json
{ "mcpServers": { "workbooks": { "command": "workbook", "args": ["mcp", "serve"] } } }
```

Tools surfaced:

- `workbooks_groups_list`, `workbooks_group_members`, `workbooks_group_workbooks`, `workbooks_group_invite`
- `workbooks_env_list`, `workbooks_env_set`, `workbooks_env_rotate`, `workbooks_env_delete`, `workbooks_env_import`
- `workbooks_publish` (uploads from a local path), `workbooks_workbook_revoke`
- `workbooks_workbook_views` (per-viewer usage rows)

Auth: same as the rest of the CLI. Set `WORKBOOKS_API_TOKEN` for
headless use, or run `workbook group list` once first to seed the
browser-session cache.

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
  // declare runtime env vars the workbook will prompt for at first run
  // (file:// + BYO-key path only — for hosted workbooks, prefer `connect:`):
  env: {
    OPENROUTER_API_KEY: { label: "OpenRouter key", prompt: "sk-or-…", required: true, secret: true },
  },
  // declare destinations + splice rules for the broker-proxied env-var
  // path. The author owns this; group admins set values via the Studio
  // (or `workbook env set`). Plaintext never reaches the browser.
  connect: {
    OPENAI_KEY:  { inject: "bearer",                    domains: ["api.openai.com"] },
    HUBSPOT_PAT: { inject: "header:Authorization",      domains: ["api.hubapi.com"] },
    STRIPE_KEY:  { inject: "query:secret",              domains: ["api.stripe.com"] },
  },
  // standard Vite config — anything here flows through:
  vite: { plugins: [/* … */] },
};
```
