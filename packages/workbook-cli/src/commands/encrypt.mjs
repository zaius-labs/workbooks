// `workbook encrypt` — produce an encrypted <wb-data> body from a
// plaintext file. Authors run this at build time to convert a CSV
// (or any other binary asset) into the inline-base64 form the
// runtime decrypts at mount.
//
// Usage:
//   workbook encrypt --in data/orders.csv \
//                    --out dist/orders.wb-data.html \
//                    --id orders --mime text/csv \
//                    --password "hunter2"
//
// Output: the literal <wb-data> element string ready to paste or
// inline. The element carries:
//   id            from --id (must match VALID_ID rules in the runtime)
//   mime          from --mime
//   encryption    "age-v1"
//   encoding      "base64"
//   sha256        of the PLAINTEXT bytes (the runtime verifies after
//                 decrypt — independent of compression / encoding)
//
// We deliberately don't try to splice it into a workbook HTML file;
// that's the host's responsibility. The CLI just emits the element.
//
// SECURITY:
//   --password on the command line shows in `ps`. For real use prefer
//   --password-stdin (read from stdin) which the script supports.
//   --password-file <path> reads the first line of a file.
//   In CI, source from a secret store and pipe to stdin.

import { promises as fs } from "node:fs";
import { stdin } from "node:process";

const VALID_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

const ALLOWED_MIMES = new Set([
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/jsonl",
  "application/x-sqlite3",
  "application/parquet",
  "application/octet-stream",
]);

async function readPassword(opts) {
  if (opts["password-stdin"]) {
    return readStdinFirstLine();
  }
  if (opts["password-file"]) {
    const data = await fs.readFile(opts["password-file"], "utf8");
    return data.split(/\r?\n/, 1)[0];
  }
  if (opts.password) return String(opts.password);
  throw new Error(
    "no passphrase: pass --password <s>, --password-stdin, or --password-file <path>",
  );
}

function readStdinFirstLine() {
  return new Promise((resolve, reject) => {
    let buf = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => { buf += chunk; });
    stdin.on("end", () => resolve(buf.split(/\r?\n/, 1)[0]));
    stdin.on("error", reject);
  });
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(bytes) {
  // Node 18+ has Buffer with base64; use it for speed + memory.
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString("base64");
}

function htmlEscapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

export async function runEncrypt(opts) {
  if (!opts.in) throw new Error("missing --in <path>");
  if (!opts.out) throw new Error("missing --out <path>");
  if (!opts.id) throw new Error("missing --id <data-id>");
  if (!VALID_ID.test(opts.id)) {
    throw new Error(
      `invalid --id '${opts.id}': must match ${VALID_ID.source}`,
    );
  }
  const mime = opts.mime ?? "application/octet-stream";
  if (!ALLOWED_MIMES.has(mime)) {
    throw new Error(
      `--mime '${mime}' not in the runtime's wb-data allowlist. ` +
        `Pick one of: ${[...ALLOWED_MIMES].join(", ")}`,
    );
  }

  const password = await readPassword(opts);
  if (!password) throw new Error("empty passphrase");

  // Lazy-load the encryption helper from @work.books/runtime so
  // we share one age-encryption integration. Resolves through the
  // workspace symlink in dev, the published runtime in prod.
  const { encryptWithPassphrase, AGE_ENCRYPTION_TAG } =
    await import("@work.books/runtime/encryption");

  const plaintext = new Uint8Array(await fs.readFile(opts.in));
  const sha = await sha256Hex(plaintext);
  const ciphertext = await encryptWithPassphrase(plaintext, password);
  const body = bytesToBase64(ciphertext);

  const attrs = [
    `id="${htmlEscapeAttr(opts.id)}"`,
    `mime="${htmlEscapeAttr(mime)}"`,
    `encryption="${AGE_ENCRYPTION_TAG}"`,
    `encoding="base64"`,
    `sha256="${sha}"`,
  ].join(" ");
  const element = `<wb-data ${attrs}>\n${body}\n</wb-data>\n`;

  await fs.writeFile(opts.out, element, "utf8");

  process.stdout.write(
    `workbook encrypt: ${opts.in} (${plaintext.byteLength} B) → ` +
      `${opts.out} (${body.length} B base64)\n` +
      `  id=${opts.id} mime=${mime} sha256=${sha}\n`,
  );
}
