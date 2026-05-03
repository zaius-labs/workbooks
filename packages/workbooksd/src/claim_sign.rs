// Author-claim signing (C8.7).
//
// Sister of c2pa_sign.rs — same per-machine ed25519 key, different
// signature target. Where c2pa_sign produces an opt-in `.c2pa` sidecar
// in the C2PA crate's manifest format, this module produces a tiny
// signed JSON claim that workbook-cli embeds directly in the sealed
// envelope's meta tags. The recipient's pre-auth shell verifies the
// claim in-browser via WebCrypto Ed25519 against the broker's public
// pubkey list — see vendor/workbooks/packages/workbook-cli/src/encrypt/
// wrapStudio.mjs (`canonicalClaimBytes` + `<meta name="wb-author-*">`).
//
// Wire shape — the bytes signed are exactly what wrapStudio reproduces
// in JS at verify time:
//
//   ordered = sort_keys({author_email, author_sub, key_id, ts, workbook_id})
//   bytes   = utf8(JSON.stringify(ordered, default-separators))
//
// "default separators" = `,` + `:` (no spaces). Drift of any kind
// breaks verification; the wrap-studio-claim.test.mjs unit test pins
// the exact expected layout.

use std::path::PathBuf;

use ed25519_dalek::{Signer, SigningKey, VerifyingKey};

use crate::c2pa_sign::ensure_identity;

/// Public ed25519 verifying key from the per-machine identity, as raw
/// 32 bytes. This is what the daemon registers with the broker via
/// POST /v1/authors/me/keys (base64url-encoded), and what the C8 shell
/// verifier imports via `crypto.subtle.importKey("raw", ..., "Ed25519")`.
pub fn pubkey_bytes() -> Result<[u8; 32], String> {
    let signing = load_signing_key()?;
    Ok(signing.verifying_key().to_bytes())
}

/// Sign the canonical-claim bytes for one (workbook_id, ts) save.
///
/// Returns the raw 64-byte ed25519 signature. The caller (HTTP layer)
/// is responsible for base64url-encoding it for transport to the CLI
/// + into the wrapStudio meta tag.
///
/// The CALLER also passes (author_sub, author_email, key_id) — the
/// daemon can't pluck those from thin air; they come from the broker
/// session + author-key-registration response stored in
/// signing/author_identity.json. See author_identity::load_or_init.
pub fn sign_claim(args: ClaimArgs<'_>) -> Result<[u8; 64], String> {
    let signing = load_signing_key()?;
    let bytes = canonical_claim_bytes(&args);
    let sig = signing.sign(&bytes);
    Ok(sig.to_bytes())
}

#[derive(Clone, Copy)]
pub struct ClaimArgs<'a> {
    pub author_sub: &'a str,
    pub author_email: &'a str,
    pub key_id: &'a str,
    pub workbook_id: &'a str,
    pub ts: i64,
}

/// Reproduce wrapStudio's canonicalClaimBytes() byte-for-byte.
///
/// Spec: keys sorted alphabetically, JSON.stringify default separators
/// (`,` + `:`). Numbers serialize as plain integers (ts is unix
/// seconds — well within 2^53, no scientific notation risk).
///
/// Test pin: wrap-studio-claim.test.mjs asserts the expected layout
///   {"author_email":"alice@acme.example","author_sub":"workos|user_alice","key_id":"k1","ts":1700000000,"workbook_id":"wb_x"}
fn canonical_claim_bytes(args: &ClaimArgs<'_>) -> Vec<u8> {
    // Build the JSON manually so we control the byte layout exactly —
    // serde_json::to_vec with sort_keys could drift if a future serde
    // version flips quoting style, separator handling, or numeric
    // formatting. Manual is one tighter screw than we'd otherwise
    // need but the verifier on the other side is a JS Object.keys+
    // JSON.stringify which is hard to nail down across browser
    // engines except by being exactly this strict.
    let mut s = String::with_capacity(256);
    s.push('{');
    s.push_str("\"author_email\":");
    push_json_string(&mut s, args.author_email);
    s.push_str(",\"author_sub\":");
    push_json_string(&mut s, args.author_sub);
    s.push_str(",\"key_id\":");
    push_json_string(&mut s, args.key_id);
    s.push_str(",\"ts\":");
    s.push_str(&args.ts.to_string());
    s.push_str(",\"workbook_id\":");
    push_json_string(&mut s, args.workbook_id);
    s.push('}');
    s.into_bytes()
}

/// JSON-string-escape a UTF-8 source. Escapes the same set
/// JSON.stringify produces: `"` `\` `\b` `\f` `\n` `\r` `\t` plus
/// control chars below 0x20 as `\u00XX`. Other bytes pass through.
fn push_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Extract the raw ed25519 signing key from the PEM-encoded private
/// key file written by c2pa_sign::ensure_identity.
///
/// rcgen serializes ed25519 keys as PKCS#8 ("BEGIN PRIVATE KEY"). The
/// PKCS#8 envelope is a fixed prefix + 32 raw seed bytes; we parse the
/// PEM, decode the base64 body, then pluck the seed by structural
/// knowledge. ed25519-dalek constructs the SigningKey from the seed.
///
/// Why not pkcs8 crate parse: avoids dragging another dep through the
/// security surface for a 16-byte fixed prefix we already know. The
/// trade-off is a fragile dependency on rcgen's PKCS#8 layout staying
/// stable, which it is — RFC 8410 fixes the encoding.
fn load_signing_key() -> Result<SigningKey, String> {
    let (_cert, key_pem) = ensure_identity()?;
    let key_pem_str = std::str::from_utf8(&key_pem).map_err(|e| format!("key utf8: {e}"))?;

    let body = pem_body(key_pem_str, "PRIVATE KEY")
        .ok_or_else(|| "could not find PEM 'PRIVATE KEY' block in identity".to_string())?;

    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let der = STANDARD
        .decode(body.replace(['\n', '\r', ' '], ""))
        .map_err(|e| format!("base64: {e}"))?;

    // PKCS#8 ed25519 layout (RFC 8410): fixed 16-byte prefix, then
    // OCTET STRING of the 32-byte seed. The OCTET STRING tag (0x04)
    // and length (0x20) precede the seed at offsets 14 and 15.
    if der.len() < 48 || der[14] != 0x04 || der[15] != 0x20 {
        return Err("unexpected PKCS#8 ed25519 layout (prefix mismatch)".to_string());
    }
    let seed: [u8; 32] = der[16..48]
        .try_into()
        .map_err(|_| "seed slice not 32 bytes".to_string())?;
    Ok(SigningKey::from_bytes(&seed))
}

/// Extract the body of a single named PEM block. Returns None if the
/// block isn't present.
fn pem_body<'a>(pem: &'a str, label: &str) -> Option<&'a str> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let s = pem.find(&begin)? + begin.len();
    let e = pem[s..].find(&end)? + s;
    Some(pem[s..e].trim())
}

/// Where the registered author identity lives — sister of
/// c2pa_sign::cert_path() / key_path().
///
/// Schema:
///   { author_sub, author_email, key_id, broker_url, registered_at }
///
/// Written 0600. Reset by deleting the file (e.g., to re-register
/// against a different broker / sub).
pub fn author_identity_path() -> PathBuf {
    let mut p = crate::c2pa_sign::identity_dir_for_claim_signer();
    p.push("author_identity.json");
    p
}

/// Verify a signature locally — used by the unit tests + by
/// integration code that wants a sanity check before submitting to
/// the broker. Production verification happens in the recipient's
/// browser, not here.
pub fn verify_claim(
    args: &ClaimArgs<'_>,
    sig: &[u8; 64],
    pubkey: &[u8; 32],
) -> Result<bool, String> {
    let bytes = canonical_claim_bytes(args);
    let vk = VerifyingKey::from_bytes(pubkey).map_err(|e| format!("pubkey parse: {e}"))?;
    let signature = ed25519_dalek::Signature::from_bytes(sig);
    Ok(vk.verify_strict(&bytes, &signature).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_layout_matches_js_spec() {
        // Exact pin from wrap-studio-claim.test.mjs (Section 2).
        let args = ClaimArgs {
            author_sub: "workos|user_alice",
            author_email: "alice@acme.example",
            workbook_id: "wb_x",
            key_id: "k1",
            ts: 1700000000,
        };
        let got = String::from_utf8(canonical_claim_bytes(&args)).unwrap();
        let expected =
            r#"{"author_email":"alice@acme.example","author_sub":"workos|user_alice","key_id":"k1","ts":1700000000,"workbook_id":"wb_x"}"#;
        assert_eq!(got, expected);
    }

    #[test]
    fn json_string_escaping_handles_control_chars() {
        let mut out = String::new();
        push_json_string(&mut out, "a\"b\\c\nd\te");
        assert_eq!(out, r#""a\"b\\c\nd\te""#);
    }

    #[test]
    fn sign_then_verify_roundtrip() {
        // Generate a fresh keypair locally — we don't want this test
        // to touch ensure_identity()'s on-disk identity.
        use rand::rngs::OsRng;
        let mut csprng = OsRng;
        let signing = SigningKey::generate(&mut csprng);
        let pubkey = signing.verifying_key().to_bytes();

        let args = ClaimArgs {
            author_sub: "workos|user_test",
            author_email: "test@ex.example",
            workbook_id: "wb_test_xyz",
            key_id: "k_test",
            ts: 1730000000,
        };
        let bytes = canonical_claim_bytes(&args);
        let sig = signing.sign(&bytes).to_bytes();

        assert!(verify_claim(&args, &sig, &pubkey).unwrap());

        // Tampered ts → verify fails.
        let tampered = ClaimArgs {
            ts: 1730000001,
            ..args
        };
        assert!(!verify_claim(&tampered, &sig, &pubkey).unwrap());
    }
}
