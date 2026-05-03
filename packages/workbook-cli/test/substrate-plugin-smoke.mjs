#!/usr/bin/env node
// Smoke test for the substrate vite plugin.
//
// Doesn't run a full Vite build — exercises the transformIndexHtml
// hook directly with a fake config + a fake input HTML and checks the
// emitted slots.

import substratePlugin, {
  resolveWorkbookId, generateUlid, buildMetaJson,
} from "../src/plugins/substrate.mjs";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ": " + detail : ""}`);
  if (ok) pass++; else fail++;
}

// ULID-ish generation
{
  const id = generateUlid();
  check("generateUlid produces 26 chars", id.length === 26, id);
  check("generateUlid is alphanumeric (Crockford base32)",
    /^[0-9A-Z]+$/.test(id));
}

// resolveWorkbookId persists to .workbook-id
{
  const dir = mkdtempSync(join(tmpdir(), "wb-substrate-"));
  try {
    const id1 = await resolveWorkbookId(dir);
    check("resolveWorkbookId returns id", id1.length >= 16);
    check(".workbook-id file persisted", existsSync(join(dir, ".workbook-id")));
    const id2 = await resolveWorkbookId(dir);
    check("resolveWorkbookId stable across calls", id1 === id2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// buildMetaJson shape
{
  const json = buildMetaJson("01J0TEST", { schemaVersion: 5 });
  const meta = JSON.parse(json);
  check("buildMetaJson workbook_id", meta.workbook_id === "01J0TEST");
  check("buildMetaJson substrate_version=v0", meta.substrate_version === "v0");
  check("buildMetaJson schema_version respected", meta.schema_version === 5);
  check("buildMetaJson compaction_seq=0", meta.compaction_seq === 0);
  check("buildMetaJson empty snapshot map", Object.keys(meta.snapshot_cid_by_target).length === 0);
}

// Plugin transformIndexHtml
{
  const dir = mkdtempSync(join(tmpdir(), "wb-substrate-plug-"));
  try {
    const plugin = substratePlugin({ schemaVersion: 0 });
    await plugin.configResolved({ root: dir });
    const before = `<!DOCTYPE html><html><head><title>x</title></head><body></body></html>`;
    const after = plugin.transformIndexHtml.handler(before);

    check("emits wb-meta", /<script[^>]*\bid="wb-meta"/.test(after));
    check("emits wb-wal", /<script[^>]*\bid="wb-wal">\[\]<\/script>/.test(after));
    check("emits substrate version meta", /<meta name="workbook-substrate" content="v0">/.test(after));
    check("inserts before </head>", after.indexOf("wb-meta") < after.indexOf("</head>"));
    check("preserves original head content", after.includes("<title>x</title>"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
