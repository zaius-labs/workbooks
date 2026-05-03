// Adversarial test harness for the age-format <wb-data> encryption
// + Ed25519 signing. Probes the failure modes that matter for "send
// this file with secrets to a colleague": wrong password, tampered
// ciphertext, truncation, signature forgery, attribute swap, etc.
// Run with:
//   node --experimental-strip-types security-test.mjs

import {
  encryptWithPassphrase,
  decryptWithPassphrase,
  encryptToRecipients,
  decryptWithIdentity,
  generateX25519Identity,
  createWebAuthnCredential,
  buildWebAuthnRecipient,
  buildWebAuthnIdentity,
  looksLikeAgeEnvelope,
} from "./packages/runtime/src/encryption.ts";
import {
  generateKeypair,
  signBlock,
  verifyBlock,
} from "./packages/runtime/src/signature.ts";

const PASSWORD = "correct-horse-battery-staple";
const WRONG_PASSWORD = "tr0ub4dor&3";
const PLAINTEXT = new TextEncoder().encode(
  "id,name,salary\n1,alice,150000\n2,bob,90000\n3,carol,210000\n",
);

let pass = 0;
let fail = 0;
function expect(name, ok, detail = "") {
  const tag = ok ? "PASS" : "FAIL";
  console.log(`${tag} ${name}${detail ? `  (${detail})` : ""}`);
  ok ? pass++ : fail++;
}

async function main() {
  const cipher = await encryptWithPassphrase(PLAINTEXT, PASSWORD);

  // ─── Sanity: positive path works ───
  {
    const got = await decryptWithPassphrase(cipher, PASSWORD);
    expect(
      "happy path: encrypt+decrypt round-trip",
      Buffer.compare(got, PLAINTEXT) === 0,
    );
  }

  // ─── Magic-bytes detector ───
  {
    expect("looksLikeAgeEnvelope: real envelope detected", looksLikeAgeEnvelope(cipher));
    expect(
      "looksLikeAgeEnvelope: random bytes rejected",
      !looksLikeAgeEnvelope(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x00])),
    );
    expect(
      "looksLikeAgeEnvelope: empty input rejected",
      !looksLikeAgeEnvelope(new Uint8Array(0)),
    );
  }

  // ─── Wrong password ───
  try {
    await decryptWithPassphrase(cipher, WRONG_PASSWORD);
    expect("wrong password rejected", false, "decrypt did NOT throw");
  } catch (e) {
    expect("wrong password rejected", true, e?.constructor?.name);
  }

  // ─── Empty password ───
  try {
    await decryptWithPassphrase(cipher, "");
    expect("empty password rejected", false, "decrypt did NOT throw");
  } catch (e) {
    expect("empty password rejected", true);
  }

  // ─── Tampered ciphertext: flip a byte mid-payload ───
  {
    const tampered = new Uint8Array(cipher);
    // Skip the age header (~few hundred bytes); flip a byte in the
    // chunk payload area.
    tampered[Math.floor(tampered.length * 0.7)] ^= 0x01;
    try {
      await decryptWithPassphrase(tampered, PASSWORD);
      expect("byte-flip in ciphertext rejected", false, "decrypt did NOT throw");
    } catch (e) {
      expect("byte-flip in ciphertext rejected", true);
    }
  }

  // ─── Tampered: flip a byte in the age HEADER ───
  {
    const tampered = new Uint8Array(cipher);
    // Find the first 'X' or known header byte and flip it. Header
    // is ASCII; flipping mid-base64 should break parsing.
    for (let i = 30; i < 80; i++) {
      if (tampered[i] >= 0x41 && tampered[i] <= 0x7a) {
        tampered[i] ^= 0x01;
        break;
      }
    }
    try {
      await decryptWithPassphrase(tampered, PASSWORD);
      expect("byte-flip in header rejected", false, "decrypt did NOT throw");
    } catch (e) {
      expect("byte-flip in header rejected", true);
    }
  }

  // ─── Truncation: cut off the last chunk ───
  {
    const truncated = cipher.slice(0, cipher.length - 10);
    try {
      await decryptWithPassphrase(truncated, PASSWORD);
      expect("truncated ciphertext rejected", false, "decrypt did NOT throw");
    } catch (e) {
      expect("truncated ciphertext rejected", true);
    }
  }

  // ─── Truncation: cut off most of the file ───
  {
    const stub = cipher.slice(0, 20);
    try {
      await decryptWithPassphrase(stub, PASSWORD);
      expect("severely-truncated rejected", false, "decrypt did NOT throw");
    } catch (e) {
      expect("severely-truncated rejected", true);
    }
  }

  // ─── Empty input ───
  try {
    await decryptWithPassphrase(new Uint8Array(0), PASSWORD);
    expect("empty input rejected", false, "decrypt did NOT throw");
  } catch (e) {
    expect("empty input rejected", true);
  }

  // ─── Concatenated ciphertexts: try to make the decrypter accept
  //     extra bytes after a valid age envelope (would let an
  //     attacker append their own data to a valid file) ───
  {
    const padded = new Uint8Array(cipher.length + 100);
    padded.set(cipher, 0);
    // Append random garbage after the valid envelope.
    for (let i = cipher.length; i < padded.length; i++) {
      padded[i] = Math.floor(Math.random() * 256);
    }
    try {
      const got = await decryptWithPassphrase(padded, PASSWORD);
      // age might tolerate trailing bytes silently. Let's see if it
      // decrypts to the original or includes the garbage.
      const matches = Buffer.compare(got, PLAINTEXT) === 0;
      if (matches) {
        expect("trailing-bytes ignored (security note: may be accepted)", true,
          "age tolerates trailing bytes — does not decode them");
      } else {
        expect("trailing-bytes produced different plaintext", false,
          `unexpected plaintext: ${new TextDecoder().decode(got).slice(0, 50)}...`);
      }
    } catch (e) {
      expect("trailing bytes rejected", true);
    }
  }

  // ─── Same plaintext, different ciphertexts (nonce uniqueness) ───
  {
    const c1 = await encryptWithPassphrase(PLAINTEXT, PASSWORD);
    const c2 = await encryptWithPassphrase(PLAINTEXT, PASSWORD);
    expect(
      "nonce uniqueness: same plaintext produces different ciphertext",
      Buffer.compare(c1, c2) !== 0,
    );
  }

  // ─── Empty plaintext (zero-byte file) ───
  {
    const c = await encryptWithPassphrase(new Uint8Array(0), PASSWORD);
    const got = await decryptWithPassphrase(c, PASSWORD);
    expect("zero-byte plaintext round-trips", got.length === 0);
  }

  // ─── Large plaintext (1 MB) ───
  {
    const big = new Uint8Array(1024 * 1024);
    // Node's WebCrypto getRandomValues caps at 64 KB per call — fill
    // in chunks. Real-world payload sizes (videos, sqlite dbs) may
    // hit this; the encryption itself doesn't, but our test fixture
    // would have crashed pre-fix.
    for (let i = 0; i < big.length; i += 65536) {
      crypto.getRandomValues(big.subarray(i, Math.min(i + 65536, big.length)));
    }
    const c = await encryptWithPassphrase(big, PASSWORD);
    const got = await decryptWithPassphrase(c, PASSWORD);
    expect(
      "1 MB plaintext round-trips",
      Buffer.compare(big, got) === 0,
      `${(c.length / 1024).toFixed(0)} KB ciphertext`,
    );
  }

  // ─── Header substitution: prepend a different file's age header ───
  {
    const otherCipher = await encryptWithPassphrase(
      new TextEncoder().encode("attacker-controlled content"),
      PASSWORD,
    );
    // Header ends with "\n--- <base64 HMAC>\n" then binary ciphertext.
    // Find the newline after the "--- " line.
    function findHeaderEnd(buf) {
      // Look for the literal "\n--- " sequence (start of HMAC line).
      for (let i = 0; i < buf.length - 5; i++) {
        if (buf[i] === 0x0a && buf[i + 1] === 0x2d && buf[i + 2] === 0x2d &&
            buf[i + 3] === 0x2d && buf[i + 4] === 0x20) {
          // Found "\n--- "; now find the newline that ends the line.
          for (let j = i + 5; j < buf.length; j++) {
            if (buf[j] === 0x0a) return j + 1; // past the trailing \n
          }
          return -1;
        }
      }
      return -1;
    }
    const eOrig = findHeaderEnd(cipher);
    const eOther = findHeaderEnd(otherCipher);
    if (eOrig > 0 && eOther > 0) {
      const swapped = new Uint8Array(eOther + cipher.length - eOrig);
      swapped.set(otherCipher.slice(0, eOther), 0);
      swapped.set(cipher.slice(eOrig), eOther);
      try {
        await decryptWithPassphrase(swapped, PASSWORD);
        expect("header-substitution rejected", false, "decrypt did NOT throw");
      } catch (e) {
        expect("header-substitution rejected", true);
      }
    } else {
      console.log("SKIP header-substitution (couldn't locate header boundary)");
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Phase C: Ed25519 signature attacks
  // ─────────────────────────────────────────────────────────────

  const { privateKey, publicKey } = generateKeypair();
  const { privateKey: attackerPriv, publicKey: attackerPub } = generateKeypair();
  const block = {
    id: "orders",
    mime: "text/csv",
    encryption: "age-v1",
    sha256: "0".repeat(64),
    ciphertext: cipher,
  };

  // ─── Happy path: sign + verify round-trip ───
  {
    const s = signBlock(block, privateKey);
    expect(
      "happy: signed block verifies",
      verifyBlock(block, s) === true,
    );
    expect(
      "happy: pubkey on the sig matches author",
      s.pubkey === publicKey,
    );
  }

  // ─── pubkey pinning rejects mismatch ───
  {
    const s = signBlock(block, privateKey);
    try {
      verifyBlock(block, s, attackerPub); // pin the WRONG pubkey
      expect("pubkey-pinning: mismatch rejected", false, "did NOT throw");
    } catch (e) {
      expect("pubkey-pinning: mismatch rejected", /pubkey mismatch/.test(e?.message ?? ""));
    }
  }

  // ─── pubkey pinning accepts match ───
  {
    const s = signBlock(block, privateKey);
    expect(
      "pubkey-pinning: match accepted",
      verifyBlock(block, s, publicKey) === true,
    );
  }

  // ─── id swap (the headline attribute-tamper attack) ───
  {
    const s = signBlock(block, privateKey);
    const tampered = { ...block, id: "different_target_cell" };
    try {
      verifyBlock(tampered, s);
      expect("id swap rejected", false, "did NOT throw");
    } catch (e) {
      expect("id swap rejected", /verification failed/.test(e?.message ?? ""));
    }
  }

  // ─── mime swap ───
  {
    const s = signBlock(block, privateKey);
    const tampered = { ...block, mime: "application/json" };
    try {
      verifyBlock(tampered, s);
      expect("mime swap rejected", false, "did NOT throw");
    } catch (e) {
      expect("mime swap rejected", /verification failed/.test(e?.message ?? ""));
    }
  }

  // ─── sha256 swap (substituting a different plaintext digest) ───
  {
    const s = signBlock(block, privateKey);
    const tampered = { ...block, sha256: "f".repeat(64) };
    try {
      verifyBlock(tampered, s);
      expect("sha256 swap rejected", false, "did NOT throw");
    } catch (e) {
      expect("sha256 swap rejected", /verification failed/.test(e?.message ?? ""));
    }
  }

  // ─── ciphertext byte flip ───
  {
    const s = signBlock(block, privateKey);
    const flipped = new Uint8Array(cipher);
    flipped[Math.floor(flipped.length * 0.7)] ^= 0x01;
    const tampered = { ...block, ciphertext: flipped };
    try {
      verifyBlock(tampered, s);
      expect("ciphertext flip caught by signature", false, "did NOT throw");
    } catch (e) {
      expect("ciphertext flip caught by signature", /verification failed/.test(e?.message ?? ""));
    }
  }

  // ─── attacker substitutes their own (pubkey, sig) for a tampered ciphertext ───
  // This is THE attack pubkey-pinning is designed to catch. Without
  // pinning, the attacker's signature verifies (since they signed
  // their tampered version with their own key). With pinning, we
  // detect that the file's pubkey isn't the one we expect.
  {
    const tamperedBlock = { ...block, id: "swapped_id" };
    const attackerSig = signBlock(tamperedBlock, attackerPriv);
    // Without pinning: signature verifies against attacker's own data.
    expect(
      "no pinning: attacker's signature on attacker's content verifies",
      verifyBlock(tamperedBlock, attackerSig) === true,
      "this is why pinning matters",
    );
    // With pinning: rejected because pubkey isn't the expected one.
    try {
      verifyBlock(tamperedBlock, attackerSig, publicKey);
      expect("pinning: attacker substitution rejected", false, "did NOT throw");
    } catch (e) {
      expect("pinning: attacker substitution rejected", /pubkey mismatch/.test(e?.message ?? ""));
    }
  }

  // ─── malformed signature inputs ───
  {
    const s = signBlock(block, privateKey);
    const badPubkey = { ...s, pubkey: "AAAA" }; // way too short
    try {
      verifyBlock(block, badPubkey);
      expect("malformed pubkey rejected", false, "did NOT throw");
    } catch (e) {
      expect("malformed pubkey rejected", /must be 32 bytes/.test(e?.message ?? ""));
    }
    const badSig = { ...s, sig: "AAAA" }; // way too short
    try {
      verifyBlock(block, badSig);
      expect("malformed sig rejected", false, "did NOT throw");
    } catch (e) {
      expect("malformed sig rejected", /must be 64 bytes/.test(e?.message ?? ""));
    }
  }

  // ─── deterministic canonicalization: same inputs, same sig (well, almost — Ed25519 is deterministic) ───
  {
    const s1 = signBlock(block, privateKey);
    const s2 = signBlock(block, privateKey);
    expect(
      "Ed25519 deterministic: same block + same key produces same sig",
      s1.sig === s2.sig,
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Phase E: WASM-side decrypt + handle registry
  //
  // Loads the runtime-wasm pkg, exercises the Rust-side decrypt
  // path that keeps plaintext inside linear memory. Verifies:
  //   - decrypt to handle round-trips through Polars-SQL
  //   - sha256 verification works without exporting plaintext
  //   - handle dispose removes bytes (subsequent ops see size 0)
  //   - wrong password produces an error from Rust (not a panic)
  // ─────────────────────────────────────────────────────────────

  let wasm;
  try {
    wasm = await import("./packages/runtime-wasm/pkg/workbook_runtime.js");
    // Node-friendly init: fetch() of file:// URLs doesn't work, so feed bytes
    // directly via fs.
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const wasmPath = url.fileURLToPath(
      new URL("./packages/runtime-wasm/pkg/workbook_runtime_bg.wasm", import.meta.url),
    );
    const wasmBytes = await fs.readFile(wasmPath);
    await wasm.default({ module_or_path: wasmBytes });
  } catch (e) {
    console.log(`SKIP Phase E (runtime-wasm pkg not built): ${e?.message ?? e}`);
    console.log(`\n${pass} pass / ${fail} fail`);
    process.exit(fail > 0 ? 1 : 0);
  }

  // Re-encrypt the same plaintext with typage so we exercise the
  // Rust decrypt against the canonical age format. (Phase A and
  // Phase E should interoperate — that's the point of using age.)
  const phaseECipher = await encryptWithPassphrase(PLAINTEXT, PASSWORD);

  // ─── decrypt-to-handle round trip ───
  {
    const handleId = wasm.ageDecryptToHandle(phaseECipher, PASSWORD);
    expect(
      "handle decrypt: returns numeric id",
      typeof handleId === "number" && handleId >= 0,
    );
    const size = wasm.handleSize(handleId);
    expect(
      "handle decrypt: size matches plaintext length",
      size === PLAINTEXT.byteLength,
      `got ${size} bytes`,
    );
    const expectedSha = await crypto.subtle.digest("SHA-256", PLAINTEXT)
      .then((d) => [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""));
    expect(
      "handle sha256: matches plaintext digest (computed in Rust, never exported)",
      wasm.handleSha256(handleId) === expectedSha,
    );
    // Escape hatch — verify it still produces correct bytes.
    const exported = wasm.handleExport(handleId);
    expect(
      "handleExport: produces same plaintext (escape hatch round-trip)",
      Buffer.compare(exported, PLAINTEXT) === 0,
    );
    // Dispose; subsequent ops should see slot empty.
    expect("dispose: returns true on first call", wasm.handleDispose(handleId) === true);
    expect("dispose: idempotent (false on second call)", wasm.handleDispose(handleId) === false);
    expect("disposed handle: handleSize returns 0", wasm.handleSize(handleId) === 0);
    expect("disposed handle: handleExport returns empty", wasm.handleExport(handleId).byteLength === 0);
    expect("disposed handle: handleSha256 returns empty string", wasm.handleSha256(handleId) === "");
  }

  // ─── wrong password through Rust path ───
  try {
    wasm.ageDecryptToHandle(phaseECipher, WRONG_PASSWORD);
    expect("Rust decrypt: wrong password rejected", false, "did NOT throw");
  } catch (e) {
    expect(
      "Rust decrypt: wrong password rejected",
      typeof e === "string" || e instanceof Error,
    );
  }

  // ─── tampered ciphertext through Rust path ───
  {
    const tampered = new Uint8Array(phaseECipher);
    tampered[Math.floor(tampered.length * 0.7)] ^= 0x01;
    try {
      wasm.ageDecryptToHandle(tampered, PASSWORD);
      expect("Rust decrypt: byte-flip rejected", false, "did NOT throw");
    } catch (e) {
      expect("Rust decrypt: byte-flip rejected", true);
    }
  }

  // ─── slot reuse: dispose + decrypt should reuse the same id ───
  {
    const id1 = wasm.ageDecryptToHandle(phaseECipher, PASSWORD);
    wasm.handleDispose(id1);
    const id2 = wasm.ageDecryptToHandle(phaseECipher, PASSWORD);
    expect(
      "Rust registry: disposed slot reused (slab semantics)",
      id1 === id2,
    );
    wasm.handleDispose(id2);
  }

  // ─────────────────────────────────────────────────────────────
  // Phase D: X25519 multi-recipient
  //
  // Mints three keypairs, encrypts to all three, verifies each
  // individually decrypts. Then fuzzes failure modes: wrong identity,
  // recipient-only file refuses passphrase, swapping recipients.
  // Also exercises the Rust path (ageDecryptWithIdentitiesToHandle).
  // ─────────────────────────────────────────────────────────────

  const alice = await generateX25519Identity();
  const bob = await generateX25519Identity();
  const carol = await generateX25519Identity();

  // ─── encrypt to three recipients ───
  const multiCipher = await encryptToRecipients(PLAINTEXT, {
    recipients: [alice.recipient, bob.recipient, carol.recipient],
  });
  expect(
    "Phase D encrypt: produces a valid age envelope",
    looksLikeAgeEnvelope(multiCipher),
  );

  // ─── each recipient can decrypt independently ───
  for (const [name, kp] of [["alice", alice], ["bob", bob], ["carol", carol]]) {
    const got = await decryptWithIdentity(multiCipher, kp.identity);
    expect(
      `Phase D: ${name} decrypts the multi-recipient file`,
      Buffer.compare(got, PLAINTEXT) === 0,
    );
  }

  // ─── stranger's identity fails ───
  {
    const stranger = await generateX25519Identity();
    let threw = false;
    try {
      await decryptWithIdentity(multiCipher, stranger.identity);
    } catch {
      threw = true;
    }
    expect("Phase D: stranger identity rejected", threw);
  }

  // ─── identity-format guard: passing a recipient as identity rejected ───
  {
    let threw = false;
    try {
      await decryptWithIdentity(multiCipher, alice.recipient);
    } catch {
      threw = true;
    }
    expect("Phase D: passing 'age1...' (a recipient) as identity rejected", threw);
  }

  // ─── combine passphrase + recipients: typage 0.2 limitation ───
  // age the format supports it; typage 0.2 doesn't expose
  // ScryptRecipient. We surface this with a clear error rather than
  // silently dropping one of the unlock paths. (Bump typage past 0.2
  // OR patch it to re-export ScryptRecipient to lift this.)
  {
    let threw = false;
    try {
      await encryptToRecipients(PLAINTEXT, {
        recipients: [alice.recipient],
        passphrase: PASSWORD,
      });
    } catch (e) {
      threw = /not supported|ScryptRecipient/.test(String(e?.message ?? e));
    }
    expect(
      "Phase D: combining passphrase + recipients fails clearly under typage 0.2",
      threw,
    );
  }

  // ─── tamper: byte-flip in body still rejected with X25519 unlock ───
  {
    const tampered = new Uint8Array(multiCipher);
    tampered[Math.floor(tampered.length * 0.7)] ^= 0x01;
    let threw = false;
    try {
      await decryptWithIdentity(tampered, alice.identity);
    } catch {
      threw = true;
    }
    expect("Phase D: byte-flip in multi-recipient body rejected", threw);
  }

  // ─── reject empty/missing recipients in encrypt ───
  {
    let threw = false;
    try {
      await encryptToRecipients(PLAINTEXT, {});
    } catch {
      threw = true;
    }
    expect(
      "Phase D: encryptToRecipients rejects empty config",
      threw,
    );
  }

  // ─── nonce uniqueness across multi-recipient files ───
  {
    const a = await encryptToRecipients(PLAINTEXT, {
      recipients: [alice.recipient],
    });
    const b = await encryptToRecipients(PLAINTEXT, {
      recipients: [alice.recipient],
    });
    expect(
      "Phase D: same plaintext + same recipient produces different ciphertext",
      Buffer.compare(a, b) !== 0,
    );
  }

  // ─── Rust path (ageDecryptWithIdentitiesToHandle) ───
  if (wasm.ageDecryptWithIdentitiesToHandle) {
    const handleId = wasm.ageDecryptWithIdentitiesToHandle(
      multiCipher,
      [bob.identity],
    );
    expect(
      "Phase D Rust: identity decrypt returns numeric handle",
      typeof handleId === "number" && handleId >= 0,
    );
    expect(
      "Phase D Rust: handleSize matches plaintext length",
      wasm.handleSize(handleId) === PLAINTEXT.byteLength,
    );
    const expectedSha = await crypto.subtle.digest("SHA-256", PLAINTEXT)
      .then((d) =>
        [...new Uint8Array(d)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
      );
    expect(
      "Phase D Rust: handleSha256 matches plaintext digest",
      wasm.handleSha256(handleId) === expectedSha,
    );
    wasm.handleDispose(handleId);

    // Multiple identities — Rust tries each in turn.
    const handleId2 = wasm.ageDecryptWithIdentitiesToHandle(
      multiCipher,
      [(await generateX25519Identity()).identity, carol.identity],
    );
    expect(
      "Phase D Rust: tries multiple identities, second matches",
      wasm.handleSize(handleId2) === PLAINTEXT.byteLength,
    );
    wasm.handleDispose(handleId2);

    // No matching identity — error.
    let threw = false;
    try {
      const stranger = await generateX25519Identity();
      wasm.ageDecryptWithIdentitiesToHandle(multiCipher, [stranger.identity]);
    } catch {
      threw = true;
    }
    expect("Phase D Rust: stranger identity rejected", threw);

    // Malformed identity — error.
    let threwMalformed = false;
    try {
      wasm.ageDecryptWithIdentitiesToHandle(multiCipher, ["NOT-AN-IDENTITY"]);
    } catch {
      threwMalformed = true;
    }
    expect("Phase D Rust: malformed identity rejected", threwMalformed);
  } else {
    console.log("SKIP Phase D Rust (ageDecryptWithIdentitiesToHandle binding missing)");
  }

  // ─────────────────────────────────────────────────────────────
  // Phase B: WebAuthn-PRF unlock
  //
  // WebAuthn requires a browser; we can't invoke createCredential or
  // exercise an actual passkey in Node. What we CAN verify here is:
  //   - the helpers exist and load without throwing at module-import
  //   - createCredential surfaces a clear "no WebAuthn available"
  //     error rather than crashing
  //   - buildWebAuthnRecipient / buildWebAuthnIdentity construct
  //     identity objects that typage's Decrypter accepts (so the
  //     Phase D wiring composes cleanly)
  //
  // The full encrypt-decrypt round-trip lives in browser tests.
  // ─────────────────────────────────────────────────────────────

  // ─── createCredential surfaces a clear error in Node ───
  {
    let threw = false;
    let msg = "";
    try {
      await createWebAuthnCredential({ keyName: "test", rpId: "example.com" });
    } catch (e) {
      threw = true;
      msg = String(e?.message ?? e);
    }
    expect(
      "Phase B: createWebAuthnCredential errors clearly in Node",
      threw,
      msg.slice(0, 60),
    );
  }

  // ─── buildWebAuthnIdentity constructs an Identity-shaped object ───
  // The constructor doesn't trigger WebAuthn — that happens during
  // unwrapFileKey. So we should be able to instantiate it in Node.
  {
    let id;
    let constructed = false;
    try {
      id = await buildWebAuthnIdentity({ rpId: "example.com" });
      constructed = id !== null && typeof id === "object";
    } catch {
      // Some typage builds may eagerly probe for navigator.credentials.
    }
    expect(
      "Phase B: buildWebAuthnIdentity returns an Identity-shaped object",
      constructed,
    );
    if (constructed) {
      expect(
        "Phase B: WebAuthn identity has unwrapFileKey method (typage Identity contract)",
        typeof (id).unwrapFileKey === "function",
      );
    }
  }

  // ─── buildWebAuthnRecipient is similarly Recipient-shaped ───
  {
    let recip;
    let constructed = false;
    try {
      recip = await buildWebAuthnRecipient({ rpId: "example.com" });
      constructed = recip !== null && typeof recip === "object";
    } catch {
      // ignore — same caveat as above
    }
    expect(
      "Phase B: buildWebAuthnRecipient returns a Recipient-shaped object",
      constructed,
    );
    if (constructed) {
      expect(
        "Phase B: WebAuthn recipient has wrapFileKey method (typage Recipient contract)",
        typeof (recip).wrapFileKey === "function",
      );
    }
  }

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

await main();
