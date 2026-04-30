// Build-time helper — encrypts data/raw.csv with the demo passphrase
// and writes data/encrypted-block.html, the literal <wb-data> element
// the Vite plugin splices into src/index.html at the %DATA_BLOCK%
// marker. Re-run after editing data/raw.csv.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const PASSPHRASE = "correct-horse-battery-staple";
const RAW_PATH = path.join(ROOT, "data", "raw.csv");
const BLOCK_PATH = path.join(ROOT, "data", "encrypted-block.html");
const INDEX_TEMPLATE = path.join(ROOT, "src", "index.html");

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString("base64");
}

async function main() {
  const { encryptWithPassphrase, AGE_ENCRYPTION_TAG } = await import(
    "@work.books/runtime/encryption"
  );

  const plaintext = new Uint8Array(await fs.readFile(RAW_PATH));
  const sha = await sha256Hex(plaintext);
  const ciphertext = await encryptWithPassphrase(plaintext, PASSPHRASE);
  const body = bytesToBase64(ciphertext);

  const element =
    `<wb-data id="orders" mime="text/csv" encryption="${AGE_ENCRYPTION_TAG}" ` +
    `encoding="base64" sha256="${sha}">\n${body}\n</wb-data>\n`;

  await fs.writeFile(BLOCK_PATH, element, "utf8");

  // Splice the block into src/index.html at the %DATA_BLOCK% marker.
  // We keep the marker around so re-runs are idempotent.
  const indexHtml = await fs.readFile(INDEX_TEMPLATE, "utf8");
  // Match the marker comment + an optional previously-spliced block.
  const re = /<!-- BEGIN %DATA_BLOCK% -->[\s\S]*?<!-- END %DATA_BLOCK% -->|%DATA_BLOCK%/;
  const replacement =
    `<!-- BEGIN %DATA_BLOCK% -->\n` +
    `    ${element.trim()}\n` +
    `    <!-- END %DATA_BLOCK% -->`;
  if (!re.test(indexHtml)) {
    throw new Error(
      "src/index.html: missing %DATA_BLOCK% marker. " +
        "Add `%DATA_BLOCK%` (or the BEGIN/END comment block) where the " +
        "<wb-data> element should be spliced.",
    );
  }
  await fs.writeFile(INDEX_TEMPLATE, indexHtml.replace(re, replacement), "utf8");

  process.stdout.write(
    `encrypt-sample: ${RAW_PATH}\n` +
      `  plaintext   ${plaintext.byteLength} B\n` +
      `  ciphertext  ${ciphertext.byteLength} B (${body.length} base64)\n` +
      `  sha256      ${sha}\n` +
      `  passphrase  ${PASSPHRASE} (the demo's lock-screen prompt)\n` +
      `  → ${BLOCK_PATH}\n` +
      `  → ${INDEX_TEMPLATE} (spliced into %DATA_BLOCK%)\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`encrypt-sample: ${e?.stack ?? e}\n`);
  process.exit(1);
});
