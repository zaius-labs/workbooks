// `workbook keygen` — generate a keypair. Two key types supported:
//
//   --type signing  (default) — Ed25519 author keypair for signing
//                                encrypted <wb-data> blocks (Phase C).
//   --type x25519              — age X25519 keypair for multi-recipient
//                                encryption (Phase D). Use the .pub
//                                (an `age1...` recipient) with
//                                `workbook encrypt --recipient ...`;
//                                hand the .priv (an
//                                `AGE-SECRET-KEY-1...` identity) to
//                                each user who should be able to
//                                decrypt.
//
// Usage:
//   workbook keygen --out keys/myauthor                # Ed25519 (signing)
//   workbook keygen --type x25519 --out keys/alice     # age recipient
//
// Output files (both types):
//   <out>.priv  — secret material, written 0600 (owner-only)
//   <out>.pub   — public material, safe to publish
//
// Loss of .priv:
//   - signing: lose the ability to sign new encrypted blocks; old
//     signed blocks remain verifiable.
//   - x25519: lose the ability to decrypt files addressed to this
//     identity. Re-encrypt anything you still need access to with a
//     fresh recipient.

import { promises as fs } from "node:fs";
import path from "node:path";

export async function runKeygen(opts) {
  if (!opts.out) {
    throw new Error("missing --out <basename>");
  }
  const type = opts.type ?? "signing";
  if (type !== "signing" && type !== "x25519") {
    throw new Error(
      `--type '${type}' not recognized. Use 'signing' (Ed25519) or 'x25519' (age recipient).`,
    );
  }

  let privateKey;
  let publicKey;
  let privNote;
  let pubNote;

  if (type === "signing") {
    const { generateKeypair } = await import("@work.books/runtime/signature");
    const kp = generateKeypair();
    privateKey = kp.privateKey;
    publicKey = kp.publicKey;
    privNote = "Ed25519 secret — passed via --sign-key/--sign-key-file";
    pubNote = "Ed25519 public — pinned via expectedAuthorPubkey";
  } else {
    const { generateX25519Identity } = await import(
      "@work.books/runtime/encryption"
    );
    const kp = await generateX25519Identity();
    privateKey = kp.identity;
    publicKey = kp.recipient;
    privNote = "AGE-SECRET-KEY-1... — passed to resolver via x25519Identities";
    pubNote = "age1... — passed to encrypt via --recipient";
  }

  const privPath = `${opts.out}.priv`;
  const pubPath = `${opts.out}.pub`;
  await fs.mkdir(path.dirname(privPath), { recursive: true });

  // Write priv with restricted permissions. Use writeFile + chmod
  // separately for portability — `mode` arg to writeFile doesn't
  // strip existing file permissions on overwrite.
  await fs.writeFile(privPath, privateKey + "\n", "utf8");
  await fs.chmod(privPath, 0o600);
  await fs.writeFile(pubPath, publicKey + "\n", "utf8");
  await fs.chmod(pubPath, 0o644);

  process.stdout.write(
    `workbook keygen (${type}): wrote\n` +
      `  ${privPath}  (0600 — ${privNote})\n` +
      `  ${pubPath}   (0644 — ${pubNote})\n` +
      `\n` +
      `${type === "signing" ? "pubkey" : "recipient"}: ${publicKey}\n`,
  );
}
