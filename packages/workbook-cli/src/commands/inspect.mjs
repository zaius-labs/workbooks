// `workbook inspect` — read-only metadata view of a studio-v1 envelope.
// Tells you what the file is, where its broker lives, and which views
// it carries — without decrypting anything.
//
// Spec: vendor/workbooks/docs/ENCRYPTED_FORMAT.md
// Tracker: bd show core-1fi.1.3
//
// Usage:
//   workbook inspect <path>
//   workbook inspect <path> --json

import { promises as fs } from "node:fs";
import { parseEnvelope, decodePayload } from "../encrypt/wrapStudio.mjs";

export async function runInspect(opts) {
  const inPath = opts._?.[0] ?? opts.in;
  if (!inPath) throw new Error("usage: workbook inspect <path> [--json]");

  const html = await fs.readFile(inPath, "utf8");
  const env = parseEnvelope(html);

  if (!env) {
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ path: inPath, encryption: null }) + "\n",
      );
    } else {
      process.stdout.write(`${inPath}: not a studio-v1 envelope\n`);
    }
    process.exit(opts.json ? 0 : 1);
  }

  const payload = decodePayload(env.payloadB64 ?? "");

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({
        path: inPath,
        encryption: env.encryption,
        workbook_id: env.workbookId,
        broker_url: env.brokerUrl,
        policy_hash: env.policyHash,
        cipher: env.cipher,
        payload_bytes: payload.length,
        views: env.views,
      }) + "\n",
    );
    return;
  }

  process.stdout.write(`${inPath}\n`);
  process.stdout.write(`  encryption:  ${env.encryption}\n`);
  process.stdout.write(`  workbook_id: ${env.workbookId}\n`);
  process.stdout.write(`  broker_url:  ${env.brokerUrl}\n`);
  process.stdout.write(`  policy_hash: ${env.policyHash}\n`);
  process.stdout.write(`  cipher:      ${env.cipher}\n`);
  process.stdout.write(`  payload:     ${payload.length} bytes (base64-encoded in <wb-payload>)\n`);
  process.stdout.write(`  views:\n`);
  for (const v of env.views) {
    process.stdout.write(
      `    - ${v.id}: offset=${v.offset} len=${v.len}\n`,
    );
  }
}
