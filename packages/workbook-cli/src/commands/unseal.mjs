// `workbook unseal` — testing-only decrypt of a studio-v1 envelope.
// Bypasses the broker entirely; you must supply the DEK directly.
//
// Spec: vendor/workbooks/docs/ENCRYPTED_FORMAT.md
// Tracker: bd show core-1fi.1.3
//
// Usage:
//   workbook unseal --in dist/foo.sealed.html --out dist/foo.unsealed.html \
//                   --dek <base64url 32-byte DEK>
//
// This exists so seal/unseal can be tested as a round-trip without
// standing up the broker. Production decryption flows through the
// daemon (C1.8) and the broker; this command should never run on a
// real recipient's machine.

import { promises as fs } from "node:fs";
import {
  parseEnvelope,
  decodePayload,
  decryptView,
  base64UrlToBytes,
} from "../encrypt/wrapStudio.mjs";

export async function runUnseal(opts) {
  const inPath = opts.in;
  const outPath = opts.out;
  const dekB64 = opts.dek;
  const wantViewId = opts.view ?? "default";

  if (!inPath) throw new Error("missing --in <path-to-sealed.html>");
  if (!outPath) throw new Error("missing --out <path>");
  if (!dekB64) throw new Error("missing --dek <base64url>");

  const html = await fs.readFile(inPath, "utf8");
  const env = parseEnvelope(html);
  if (!env) throw new Error(`${inPath} is not a studio-v1 envelope`);

  const view = env.views.find((v) => v.id === wantViewId);
  if (!view) {
    throw new Error(
      `view '${wantViewId}' not in envelope (have: ${env.views.map((v) => v.id).join(", ")})`,
    );
  }

  const dek = base64UrlToBytes(dekB64);
  if (dek.length !== 32) {
    throw new Error(`--dek must decode to 32 bytes, got ${dek.length}`);
  }

  const payload = decodePayload(env.payloadB64 ?? "");
  const ciphertext = payload.slice(view.offset, view.offset + view.len);
  const iv = base64UrlToBytes(view.iv);
  const mac = base64UrlToBytes(view.mac);

  const plaintext = await decryptView({
    dek,
    iv,
    ciphertext,
    mac,
    workbookId: env.workbookId,
    viewId: view.id,
    policyHash: env.policyHash,
  });

  await fs.writeFile(outPath, plaintext);
  process.stdout.write(
    `unsealed view=${view.id} workbook_id=${env.workbookId} bytes=${plaintext.length} → ${outPath}\n`,
  );
}
