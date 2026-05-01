// workbook-cli vite plugin: substrate emit.
//
// When enabled (config.substrate = "v0"), this plugin:
//   1. Resolves a stable workbook_id for the project (read from
//      .workbook-id or generated + persisted on first build).
//   2. Injects substrate slots into the final HTML:
//        <script type="application/json" id="wb-meta">{...}</script>
//        <script type="application/octet-stream" id="wb-snapshot:TARGET" ...></script>
//        <script type="application/json" id="wb-wal">[]</script>
//   3. Optionally inlines the @work.books/substrate runtime via the
//      SDK virtual module (already handled by workbookVirtualModules
//      plugin).
//
// Runs in the `transformIndexHtml` hook with enforce: "post" so the
// slots land AFTER any other HTML transforms.

import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

const ID_FILE_NAME = ".workbook-id";

/** Read or generate the project's workbook_id.
 *
 *  Format: ULID-style 26-char Crockford base32 of (timestamp_ms · randomness).
 *  Persisted to <projectRoot>/.workbook-id so it's stable across rebuilds.
 *  Authors should commit this file (it's the workbook's identity).
 */
async function resolveWorkbookId(projectRoot) {
  const idPath = path.join(projectRoot, ID_FILE_NAME);
  try {
    const existing = (await fs.readFile(idPath, "utf8")).trim();
    if (existing.length >= 16) return existing;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const id = generateUlid();
  await fs.writeFile(idPath, id + "\n", "utf8");
  return id;
}

function generateUlid() {
  // Lightweight ULID: 10-char timestamp + 16-char randomness in
  // Crockford base32. Not Spec-strict but stable + sortable + fits.
  const ALPH = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const ts = Date.now();
  const tsChars = [];
  let n = ts;
  for (let i = 0; i < 10; i++) {
    tsChars.unshift(ALPH[n % 32]);
    n = Math.floor(n / 32);
  }
  const rand = crypto.randomBytes(16);
  const randChars = [];
  for (let i = 0; i < 16; i++) {
    randChars.push(ALPH[rand[i] % 32]);
  }
  return tsChars.join("") + randChars.join("");
}

/** Compute the meta block content for a fresh substrate workbook. */
function buildMetaJson(workbookId, options) {
  return JSON.stringify({
    workbook_id: workbookId,
    substrate_version: "v0",
    schema_version: options.schemaVersion ?? 0,
    created_at: new Date().toISOString(),
    compaction_seq: 0,
    snapshot_cid_by_target: {},
  }, null, 2);
}

/** Vite plugin entry point.
 *
 *  Usage in workbook.config.mjs (or vite.config that augments):
 *
 *    import substratePlugin from "@work.books/cli/plugins/substrate";
 *    export default {
 *      vite: { plugins: [substratePlugin({ workbookId, schemaVersion: 0 })] }
 *    };
 *
 *  Or, when integrated into the workbook build (set config.substrate
 *  = "v0"), the plugin auto-loads. */
export default function substratePlugin(opts = {}) {
  let workbookId = opts.workbookId;
  let projectRoot = null;

  return {
    name: "workbook-substrate-emit",
    enforce: "post",

    async configResolved(config) {
      projectRoot = config.root;
      if (!workbookId) {
        workbookId = await resolveWorkbookId(projectRoot);
      }
    },

    transformIndexHtml: {
      order: "post",
      handler(html) {
        if (!workbookId) return html;
        const metaJson = buildMetaJson(workbookId, opts);

        // Insert before </head>. If <head> is absent, prepend before
        // first <script> or <body>.
        const slots = [
          `<meta name="workbook-substrate" content="v0">`,
          `<script type="application/json" id="wb-meta">${metaJson}</script>`,
          `<script type="application/json" id="wb-wal">[]</script>`,
        ].join("\n");

        if (/<\/head>/i.test(html)) {
          return html.replace(/<\/head>/i, `${slots}\n</head>`);
        }
        // Fallback: prepend
        return slots + "\n" + html;
      },
    },
  };
}

export { resolveWorkbookId, generateUlid, buildMetaJson };
