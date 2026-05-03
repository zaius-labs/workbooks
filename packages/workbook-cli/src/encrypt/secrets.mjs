// Shared helpers for reading + validating unlock secrets. Used by both
// `workbook encrypt` (data-block mode) and `workbook build --encrypt`
// (whole-HTML mode). Keep these CLI-side; runtime-side decryption
// lives in `@work.books/runtime/encryption`.

import { promises as fs } from "node:fs";
import { stdin } from "node:process";

/** Read passphrase from --password / --password-stdin / --password-file
 *  / env var, in that priority order. Returns null if no source given. */
export async function readPassphrase(opts, { fallbackEnv } = {}) {
  if (opts["password-stdin"]) {
    return readStdinFirstLine();
  }
  if (opts["password-file"]) {
    return readPasswordFile(opts["password-file"]);
  }
  if (opts.password) {
    return String(opts.password);
  }
  if (fallbackEnv && process.env[fallbackEnv]) {
    return process.env[fallbackEnv];
  }
  return null;
}

async function readPasswordFile(filePath) {
  // Reject world- or group-readable files unless explicitly overridden.
  // A passphrase file with `-rw-r--r--` is a leak waiting to happen.
  try {
    const st = await fs.stat(filePath);
    const mode = st.mode & 0o777;
    if (mode & 0o077) {
      const allow = process.env.WORKBOOK_ALLOW_INSECURE_PW_FILE === "1";
      const msg =
        `password file ${filePath} is group/world-readable (mode ${mode.toString(8)}). ` +
        `Run \`chmod 600 ${filePath}\` so only you can read it. ` +
        `Override with WORKBOOK_ALLOW_INSECURE_PW_FILE=1 if intentional.`;
      if (!allow) throw new Error(msg);
      process.stderr.write(`workbook: WARNING — ${msg}\n`);
    }
  } catch (e) {
    if (e?.message?.startsWith("password file")) throw e;
  }
  const data = await fs.readFile(filePath, "utf8");
  return data.split(/\r?\n/, 1)[0];
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

/** Throws unless the passphrase clears the bar. age uses scrypt N=2^18,
 *  so casual brute-force is hard, but a 6-char dictionary word is still
 *  crackable in days by a determined attacker. We require 14+ chars OR
 *  4 distinct character classes. */
export function assertStrongPassphrase(passphrase) {
  if (!passphrase) throw new Error("empty passphrase");
  if (passphrase.length >= 14) return;
  const classes =
    /[a-z]/.test(passphrase) +
    /[A-Z]/.test(passphrase) +
    /[0-9]/.test(passphrase) +
    /[^A-Za-z0-9]/.test(passphrase);
  if (classes >= 4) return;
  const allow = process.env.WORKBOOK_ALLOW_WEAK_PASSPHRASE === "1";
  const msg =
    `passphrase too weak: ${passphrase.length} chars, ${classes} character classes. ` +
    `Use 14+ chars OR mix lower/upper/digit/symbol. ` +
    `(Diceware-style "correct horse battery staple" works well.) ` +
    `Override with WORKBOOK_ALLOW_WEAK_PASSPHRASE=1 if you understand the risk.`;
  if (!allow) throw new Error(msg);
  process.stderr.write(`workbook: WARNING — ${msg}\n`);
}
