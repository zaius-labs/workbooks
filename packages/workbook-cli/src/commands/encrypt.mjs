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
    const filePath = opts["password-file"];
    // Permission check — reject world- or group-readable on POSIX.
    // A passphrase file with `-rw-r--r--` is a leak waiting to
    // happen (any other process can read it). Override via
    // WORKBOOK_ALLOW_INSECURE_PW_FILE=1 if you really mean it.
    try {
      const st = await fs.stat(filePath);
      // POSIX mode bits — ignore on platforms that don't surface them.
      const mode = st.mode & 0o777;
      if (mode & 0o077) {
        const allow = process.env.WORKBOOK_ALLOW_INSECURE_PW_FILE === "1";
        const msg =
          `--password-file ${filePath} is group/world-readable (mode ${mode.toString(8)}). ` +
          `Run \`chmod 600 ${filePath}\` so only you can read it. ` +
          `Override with WORKBOOK_ALLOW_INSECURE_PW_FILE=1 if intentional.`;
        if (!allow) throw new Error(msg);
        process.stderr.write(`workbook encrypt: WARNING — ${msg}\n`);
      }
    } catch (e) {
      // If stat itself fails we want the actual file read error to
      // surface a clearer message — only re-throw our own check.
      if (e?.message?.startsWith("--password-file")) throw e;
    }
    const data = await fs.readFile(filePath, "utf8");
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

  // Passphrase strength sanity check. age uses scrypt N=2^18 — strong
  // against casual brute force, but a 6-char dictionary word is still
  // crackable in days by a determined attacker. We require 14+ chars
  // OR at least 4 distinct character classes; surface a clear error
  // rather than silently accepting "hunter2" + asking the user to
  // ship the file.
  if (password.length < 14) {
    const classes = (
      /[a-z]/.test(password) +
      /[A-Z]/.test(password) +
      /[0-9]/.test(password) +
      /[^A-Za-z0-9]/.test(password)
    );
    if (classes < 4) {
      const allow = process.env.WORKBOOK_ALLOW_WEAK_PASSPHRASE === "1";
      const msg =
        `passphrase too weak: ${password.length} chars, ${classes} character classes. ` +
        `Use 14+ chars OR mix lower/upper/digit/symbol. ` +
        `(Diceware-style "correct horse battery staple" works well.) ` +
        `Override with WORKBOOK_ALLOW_WEAK_PASSPHRASE=1 if you understand the risk.`;
      if (!allow) throw new Error(msg);
      process.stderr.write(`workbook encrypt: WARNING — ${msg}\n`);
    }
  }

  // Lazy-load the encryption + signature helpers from @work.books/runtime
  // so we share one integration across CLI + runtime.
  const { encryptWithPassphrase, AGE_ENCRYPTION_TAG } =
    await import("@work.books/runtime/encryption");

  const plaintext = new Uint8Array(await fs.readFile(opts.in));
  const sha = await sha256Hex(plaintext);
  const ciphertext = await encryptWithPassphrase(plaintext, password);
  const body = bytesToBase64(ciphertext);

  // Optional Ed25519 signing — closes the attribute-tamper + author-
  // identity gaps. Sign over (id, mime, encryption, sha256, ciphertext).
  let pubkey;
  let sig;
  if (opts["sign-key"] || opts["sign-key-file"]) {
    const { signBlock } = await import("@work.books/runtime/signature");
    const privKeyB64 = await readSignKey(opts);
    const signature = signBlock(
      {
        id: opts.id,
        mime,
        encryption: AGE_ENCRYPTION_TAG,
        sha256: sha,
        ciphertext,
      },
      privKeyB64,
    );
    pubkey = signature.pubkey;
    sig = signature.sig;
  }

  const attrs = [
    `id="${htmlEscapeAttr(opts.id)}"`,
    `mime="${htmlEscapeAttr(mime)}"`,
    `encryption="${AGE_ENCRYPTION_TAG}"`,
    `encoding="base64"`,
    `sha256="${sha}"`,
  ];
  if (pubkey && sig) {
    attrs.push(`pubkey="${htmlEscapeAttr(pubkey)}"`);
    attrs.push(`sig="${htmlEscapeAttr(sig)}"`);
  }
  const element = `<wb-data ${attrs.join(" ")}>\n${body}\n</wb-data>\n`;

  await fs.writeFile(opts.out, element, "utf8");

  const summary =
    `workbook encrypt: ${opts.in} (${plaintext.byteLength} B) → ` +
    `${opts.out} (${body.length} B base64)\n` +
    `  id=${opts.id} mime=${mime} sha256=${sha}\n` +
    (pubkey ? `  signed by ${pubkey.slice(0, 16)}...\n` : "");
  process.stdout.write(summary);
}

async function readSignKey(opts) {
  if (opts["sign-key-file"]) {
    const data = await fs.readFile(opts["sign-key-file"], "utf8");
    return data.split(/\r?\n/, 1)[0].trim();
  }
  if (opts["sign-key"]) return String(opts["sign-key"]).trim();
  throw new Error("readSignKey: no key source");
}
