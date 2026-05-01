#!/usr/bin/env node
// Conformance: parser refuses workbooks whose substrate_version is
// unknown. The runtime promise is "v0 readers only load v0 files."
// A workbook that claims v1 must NOT silently parse as v0 — the
// invariants might be different.

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(HERE, "..", "..", "src");

const harness = `
import { parseSubstrateFromHtml, SubstrateError } from "${SRC_DIR}/index.ts";

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(\`\${ok ? "✓" : "✗"} \${name}\${detail ? ": " + detail : ""}\`);
  if (ok) pass++; else fail++;
}

// 1. v0 file with bare structure parses.
{
  const meta = {
    workbook_id: "01J0CONF",
    substrate_version: "v0",
    schema_version: 0,
    compaction_seq: 0,
    snapshot_cid_by_target: {},
  };
  const html = \`<!DOCTYPE html><html><head>
<script type="application/json" id="wb-meta">\${JSON.stringify(meta)}</script>
<script type="application/json" id="wb-wal">[]</script>
</head><body></body></html>\`;
  const file = await parseSubstrateFromHtml(html);
  check("v0 minimal file parses", file.meta.workbook_id === "01J0CONF");
}

// 2. Unknown future version (v1) is refused.
{
  const meta = { workbook_id: "01J0FUTURE", substrate_version: "v1", schema_version: 0, compaction_seq: 0, snapshot_cid_by_target: {} };
  const html = \`<!DOCTYPE html><html><head>
<script type="application/json" id="wb-meta">\${JSON.stringify(meta)}</script>
<script type="application/json" id="wb-wal">[]</script>
</head></html>\`;
  let detected = false;
  try {
    await parseSubstrateFromHtml(html);
  } catch (e) {
    detected = e instanceof SubstrateError && e.code === "unsupported-substrate-version";
  }
  check("future substrate_version refused", detected);
}

// 3. Missing wb-meta is refused with descriptive error.
{
  const html = \`<!DOCTYPE html><html><head>
<script type="application/json" id="wb-wal">[]</script>
</head></html>\`;
  let code = null;
  try { await parseSubstrateFromHtml(html); }
  catch (e) { code = e.code; }
  check("missing wb-meta refused", code === "missing-meta");
}

// 4. Malformed wb-meta JSON is refused.
{
  const html = \`<!DOCTYPE html><html><head>
<script type="application/json" id="wb-meta">not-json-{{{</script>
<script type="application/json" id="wb-wal">[]</script>
</head></html>\`;
  let code = null;
  try { await parseSubstrateFromHtml(html); }
  catch (e) { code = e.code; }
  check("malformed wb-meta JSON refused", code === "invalid-meta-json");
}

console.log(\`\\n\${pass} passed, \${fail} failed\`);
process.exit(fail > 0 ? 1 : 0);
`;

const tmp = `/tmp/wb-conf-version-${process.pid}.mjs`;
writeFileSync(tmp, harness);
try {
  execSync(`tsx ${tmp}`, {
    stdio: "inherit",
    env: { ...process.env, PATH: `/tmp/wb-spike-deps/node_modules/.bin:${process.env.PATH}` },
  });
  unlinkSync(tmp);
} catch (e) {
  unlinkSync(tmp);
  process.exit(1);
}
