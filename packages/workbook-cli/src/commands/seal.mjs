// `workbook seal` — wrap a built workbook in a studio-v1 envelope so
// it can be opened only by recipients who satisfy a broker-checked
// identity policy.
//
// Spec: vendor/workbooks/docs/ENCRYPTED_FORMAT.md
// Tracker: bd show core-1fi.1.3
//
// Usage:
//   workbook seal --in dist/foo.workbook.html \
//                 --out dist/foo.sealed.html \
//                 --broker https://broker.signal.ml \
//                 --policy policy.json
//
// On success, prints to stdout:
//   workbook_id=<base64url id>
//   policy_hash=sha256:<hex>
//   view=default dek=<base64url 32-byte DEK>
//
// The DEK MUST be registered with the broker before the sealed file
// is distributed (POST /v1/workbooks/:id/views/default/key). Until C1.7
// lands the broker's wrap endpoint, the operator copies the DEK out
// of seal's stdout and posts it manually with curl. After C1.7 the
// CLI will call the broker directly and never print the DEK.

import { promises as fs } from "node:fs";
import { wrapStudio } from "../encrypt/wrapStudio.mjs";

function looksLikeStudioEnvelope(html) {
  return /<meta\s+name=["']wb-encryption["']\s+content=["']studio-v1["']/i.test(
    html,
  );
}

export async function runSeal(opts) {
  const inPath = opts.in;
  const outPath = opts.out;
  const broker = opts.broker;
  const policyPath = opts.policy;
  const title = opts.title ?? "Sealed workbook";

  if (!inPath) throw new Error("missing --in <path-to-workbook.html>");
  if (!outPath) throw new Error("missing --out <path>");
  if (!broker) throw new Error("missing --broker <https://broker.url>");
  if (!policyPath) throw new Error("missing --policy <policy.json>");

  const html = await fs.readFile(inPath, "utf8");
  if (looksLikeStudioEnvelope(html)) {
    throw new Error(
      `${inPath} is already a studio-v1 envelope — refusing to double-wrap.`,
    );
  }

  const policyText = await fs.readFile(policyPath, "utf8");
  let policy;
  try {
    policy = JSON.parse(policyText);
  } catch (e) {
    throw new Error(`failed to parse --policy ${policyPath}: ${e.message}`);
  }

  const result = await wrapStudio({ html, brokerUrl: broker, policy, title });
  await fs.writeFile(outPath, result.html, "utf8");

  // Stable, parseable output. CI scripts can grep it.
  process.stdout.write(`workbook_id=${result.workbookId}\n`);
  process.stdout.write(`policy_hash=${result.policyHash}\n`);
  for (const v of result.views) {
    process.stdout.write(`view=${v.id} dek=${v.dek}\n`);
  }
  process.stdout.write(`out=${outPath}\n`);
}
