// studio-v1 envelope parser + AES-GCM decrypt.
//
// Envelope format (sister implementation in
// packages/workbook-cli/src/encrypt/wrapStudio.mjs):
//
//   <meta name="wb-encryption"   content="studio-v1">
//   <meta name="wb-workbook-id"  content="<base64url id>">
//   <meta name="wb-broker-url"   content="https://broker.example/">
//   <meta name="wb-policy-hash"  content="sha256:<hex>">
//   <meta name="wb-cipher"       content="aes-256-gcm">
//   <meta name="wb-views"        content='[{"id":"default","iv":"…",
//                                            "offset":0,"len":N,
//                                            "mac":"…"}]'>
//   …
//   <script id="wb-payload" type="application/octet-stream">
//     <base64-payload>
//   </script>
//
// AD bytes: "studio-v1|<workbookId>|<viewId>|<policyHash>" (UTF-8).
// AES-GCM: WebCrypto-style — ciphertext and 16-byte tag are stored
// separately in the views descriptor; the decryptor reassembles.
//
// This module is pure: no I/O, no broker calls, no global state. It
// returns cleartext as `SecretBox<Vec<u8>>` so the value is zeroized
// on drop and never accidentally formatted into a log line.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use secrecy::{ExposeSecret, SecretBox, SecretSlice};
use serde::Deserialize;

#[derive(Debug)]
pub enum EnvelopeError {
    NotEncrypted,
    UnsupportedCipher(String),
    MissingMeta(&'static str),
    BadViewsJson(String),
    BadBase64(&'static str),
    BadDekLength(usize),
    BadIvLength(usize),
    BadMacLength(usize),
    PayloadOutOfBounds,
    DecryptFailed,
    UnknownView(String),
}

impl std::fmt::Display for EnvelopeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotEncrypted => write!(f, "not a studio-v1 envelope"),
            Self::UnsupportedCipher(c) => write!(f, "unsupported cipher: {c}"),
            Self::MissingMeta(name) => write!(f, "missing meta tag: {name}"),
            Self::BadViewsJson(e) => write!(f, "wb-views JSON parse error: {e}"),
            Self::BadBase64(field) => write!(f, "bad base64 in {field}"),
            Self::BadDekLength(n) => write!(f, "DEK must be 32 bytes, got {n}"),
            Self::BadIvLength(n) => write!(f, "IV must be 12 bytes, got {n}"),
            Self::BadMacLength(n) => write!(f, "MAC must be 16 bytes, got {n}"),
            Self::PayloadOutOfBounds => write!(f, "view offset+len exceeds payload"),
            Self::DecryptFailed => write!(f, "AES-GCM decrypt failed (auth)"),
            Self::UnknownView(id) => write!(f, "no view with id {id}"),
        }
    }
}

impl std::error::Error for EnvelopeError {}

#[derive(Debug, Clone, Deserialize)]
pub struct ViewDescriptor {
    pub id: String,
    pub iv: String,
    pub offset: usize,
    pub len: usize,
    pub mac: String,
}

#[derive(Debug)]
pub struct Envelope {
    pub workbook_id: String,
    pub broker_url: String,
    pub policy_hash: String,
    pub cipher: String,
    pub views: Vec<ViewDescriptor>,
    /// Decoded payload bytes (the concatenated ciphertext for all views).
    pub payload: Vec<u8>,
}

/// Cheap check used at file-open time before paying parse cost.
pub fn looks_like_envelope(html: &str) -> bool {
    // Match the meta tag with either single or double quotes; tolerant
    // of attribute order. Anchored on the encryption value to avoid
    // matching unrelated wb-* meta tags.
    html.contains("wb-encryption") && html.contains("studio-v1")
}

/// Parse the envelope's meta tags + payload. Does NOT decrypt.
pub fn parse(html: &str) -> Result<Envelope, EnvelopeError> {
    let encryption =
        meta_value(html, "wb-encryption").ok_or(EnvelopeError::MissingMeta("wb-encryption"))?;
    if encryption != "studio-v1" {
        return Err(EnvelopeError::NotEncrypted);
    }
    let workbook_id =
        meta_value(html, "wb-workbook-id").ok_or(EnvelopeError::MissingMeta("wb-workbook-id"))?;
    let broker_url =
        meta_value(html, "wb-broker-url").ok_or(EnvelopeError::MissingMeta("wb-broker-url"))?;
    let policy_hash =
        meta_value(html, "wb-policy-hash").ok_or(EnvelopeError::MissingMeta("wb-policy-hash"))?;
    let cipher =
        meta_value(html, "wb-cipher").ok_or(EnvelopeError::MissingMeta("wb-cipher"))?;
    if cipher != "aes-256-gcm" {
        return Err(EnvelopeError::UnsupportedCipher(cipher));
    }
    let views_raw =
        meta_value(html, "wb-views").ok_or(EnvelopeError::MissingMeta("wb-views"))?;
    let views: Vec<ViewDescriptor> = serde_json::from_str(&views_raw)
        .map_err(|e| EnvelopeError::BadViewsJson(e.to_string()))?;

    let payload_b64 =
        payload_value(html).ok_or(EnvelopeError::MissingMeta("wb-payload"))?;
    // Payload is standard base64 (with padding) per wrapStudio; views
    // descriptors carry base64url. Tolerate either to be defensive.
    let payload = STANDARD
        .decode(&payload_b64)
        .or_else(|_| URL_SAFE_NO_PAD.decode(payload_b64.trim_end_matches('=')))
        .map_err(|_| EnvelopeError::BadBase64("wb-payload"))?;

    Ok(Envelope {
        workbook_id,
        broker_url,
        policy_hash,
        cipher,
        views,
        payload,
    })
}

/// Decrypt one view of an envelope using a freshly-released DEK.
///
/// `dek` is taken as a SecretSlice so callers must explicitly expose
/// the bytes — it's harder to accidentally log. Returns plaintext as
/// SecretBox so the caller can zeroize on drop.
pub fn decrypt_view(
    env: &Envelope,
    view_id: &str,
    dek: &SecretSlice<u8>,
) -> Result<SecretBox<Vec<u8>>, EnvelopeError> {
    let view = env
        .views
        .iter()
        .find(|v| v.id == view_id)
        .ok_or_else(|| EnvelopeError::UnknownView(view_id.to_string()))?;

    let dek_bytes = dek.expose_secret();
    if dek_bytes.len() != 32 {
        return Err(EnvelopeError::BadDekLength(dek_bytes.len()));
    }
    let iv = decode_b64url(&view.iv).ok_or(EnvelopeError::BadBase64("view.iv"))?;
    if iv.len() != 12 {
        return Err(EnvelopeError::BadIvLength(iv.len()));
    }
    let mac = decode_b64url(&view.mac).ok_or(EnvelopeError::BadBase64("view.mac"))?;
    if mac.len() != 16 {
        return Err(EnvelopeError::BadMacLength(mac.len()));
    }

    let end = view
        .offset
        .checked_add(view.len)
        .ok_or(EnvelopeError::PayloadOutOfBounds)?;
    if end > env.payload.len() {
        return Err(EnvelopeError::PayloadOutOfBounds);
    }
    let ciphertext = &env.payload[view.offset..end];

    // AES-GCM in `aead` expects ciphertext||tag.
    let mut sealed = Vec::with_capacity(ciphertext.len() + mac.len());
    sealed.extend_from_slice(ciphertext);
    sealed.extend_from_slice(&mac);

    let cipher = Aes256Gcm::new_from_slice(dek_bytes).map_err(|_| EnvelopeError::BadDekLength(dek_bytes.len()))?;
    let nonce = Nonce::from_slice(&iv);
    let ad = build_ad(&env.workbook_id, view_id, &env.policy_hash);

    let plaintext = cipher
        .decrypt(
            nonce,
            aes_gcm::aead::Payload {
                msg: &sealed,
                aad: &ad,
            },
        )
        .map_err(|_| EnvelopeError::DecryptFailed)?;

    Ok(SecretBox::new(Box::new(plaintext)))
}

fn build_ad(workbook_id: &str, view_id: &str, policy_hash: &str) -> Vec<u8> {
    format!("studio-v1|{workbook_id}|{view_id}|{policy_hash}").into_bytes()
}

fn decode_b64url(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s.trim_end_matches('=')).ok()
}

/// Pull the `content` attribute of a `<meta name="…">` tag. Tolerant
/// of attribute order, single/double quotes, and HTML entity escaping
/// inside values (wrapStudio escapes `&` `"` `'` `<` `>`).
fn meta_value(html: &str, name: &str) -> Option<String> {
    // Two passes: name-then-content and content-then-name. wrapStudio
    // emits name-first, but a hand-edited file might reverse it.
    let lower = html.to_ascii_lowercase();
    let key = format!("name=\"{name}\"");
    let key_alt = format!("name='{name}'");
    let mut idx = lower.find(&key).or_else(|| lower.find(&key_alt))?;
    // Walk from this match to the enclosing `<meta` and `>`.
    let tag_start = lower[..idx].rfind("<meta").or_else(|| lower[..idx].rfind("<META"))?;
    let tag_end_rel = lower[tag_start..].find('>')?;
    let tag = &html[tag_start..tag_start + tag_end_rel];
    // Re-anchor for the content attribute search inside this tag only.
    idx = tag.to_ascii_lowercase().find("content=")?;
    let after = &tag[idx + "content=".len()..];
    let quote = after.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let body = &after[1..];
    let end = body.find(quote)?;
    Some(html_unescape(&body[..end]))
}

fn payload_value(html: &str) -> Option<String> {
    // Find a `<script ... id="wb-payload" ...>` opening tag and the
    // following `</script>`. We accept either id="wb-payload" or
    // id='wb-payload'; type attribute order is irrelevant.
    let lower = html.to_ascii_lowercase();
    let needle_dq = "id=\"wb-payload\"";
    let needle_sq = "id='wb-payload'";
    let mark = lower.find(needle_dq).or_else(|| lower.find(needle_sq))?;
    let open_start = lower[..mark].rfind("<script")?;
    let open_end_rel = lower[open_start..].find('>')?;
    let body_start = open_start + open_end_rel + 1;
    let close_rel = lower[body_start..].find("</script>")?;
    Some(html[body_start..body_start + close_rel].trim().to_string())
}

fn html_unescape(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    use secrecy::SecretSlice;

    /// Build a minimal envelope HTML the same way wrapStudio.mjs
    /// would, then round-trip it through parse + decrypt.
    fn build_fixture() -> (String, [u8; 32], &'static [u8]) {
        let plaintext: &[u8] = b"<!doctype html><h1>secret</h1>";
        let workbook_id = "wb_test_12345";
        let view_id = "default";
        let policy_hash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
        let dek = [7u8; 32];
        let iv = [3u8; 12];

        let cipher = Aes256Gcm::new_from_slice(&dek).unwrap();
        let nonce = Nonce::from_slice(&iv);
        let ad = build_ad(workbook_id, view_id, policy_hash);
        let sealed = cipher
            .encrypt(
                nonce,
                aes_gcm::aead::Payload {
                    msg: plaintext,
                    aad: &ad,
                },
            )
            .unwrap();
        let (ct, tag) = sealed.split_at(sealed.len() - 16);

        let payload_b64 = STANDARD.encode(ct);
        let iv_b64 = URL_SAFE_NO_PAD.encode(iv);
        let mac_b64 = URL_SAFE_NO_PAD.encode(tag);

        let views_json = format!(
            r#"[{{"id":"{view_id}","iv":"{iv_b64}","offset":0,"len":{},"mac":"{mac_b64}"}}]"#,
            ct.len()
        );

        let html = format!(
            r#"<!doctype html><html><head>
<meta name="wb-encryption" content="studio-v1">
<meta name="wb-workbook-id" content="{workbook_id}">
<meta name="wb-broker-url" content="https://broker.example/">
<meta name="wb-policy-hash" content="{policy_hash}">
<meta name="wb-cipher" content="aes-256-gcm">
<meta name="wb-views" content='{views_json}'>
</head><body>
<script id="wb-payload" type="application/octet-stream">{payload_b64}</script>
</body></html>"#
        );
        (html, dek, plaintext)
    }

    #[test]
    fn looks_like_envelope_basic() {
        let (html, _, _) = build_fixture();
        assert!(looks_like_envelope(&html));
        assert!(!looks_like_envelope("<html><body>plain</body></html>"));
    }

    #[test]
    fn parse_then_decrypt_roundtrip() {
        let (html, dek, plaintext) = build_fixture();
        let env = parse(&html).expect("parse");
        assert_eq!(env.workbook_id, "wb_test_12345");
        assert_eq!(env.cipher, "aes-256-gcm");
        assert_eq!(env.views.len(), 1);
        assert_eq!(env.views[0].id, "default");

        let dek_secret: SecretSlice<u8> = SecretSlice::new(dek.to_vec().into_boxed_slice());
        let cleartext = decrypt_view(&env, "default", &dek_secret).expect("decrypt");
        assert_eq!(cleartext.expose_secret().as_slice(), plaintext);
    }

    #[test]
    fn decrypt_with_wrong_dek_fails() {
        let (html, _, _) = build_fixture();
        let env = parse(&html).unwrap();
        let bad: SecretSlice<u8> = SecretSlice::new(vec![0u8; 32].into_boxed_slice());
        let err = decrypt_view(&env, "default", &bad).unwrap_err();
        assert!(matches!(err, EnvelopeError::DecryptFailed));
    }

    #[test]
    fn decrypt_unknown_view_fails() {
        let (html, dek, _) = build_fixture();
        let env = parse(&html).unwrap();
        let dek_secret: SecretSlice<u8> = SecretSlice::new(dek.to_vec().into_boxed_slice());
        let err = decrypt_view(&env, "nope", &dek_secret).unwrap_err();
        assert!(matches!(err, EnvelopeError::UnknownView(_)));
    }

    /// Cross-implementation check: parse + decrypt a fixture sealed
    /// by the real wrapStudio.mjs (the JS author-side implementation).
    /// This is the actual interop guarantee — pinning the AD format,
    /// the base64 vs base64url split between payload and view fields,
    /// and the HTML escaping of `wb-views` inside a single-quoted
    /// content attribute.
    ///
    /// Skipped unless the env vars are set; CI sets them by running
    /// `node tests/seal-fixture.mjs` first.
    #[test]
    fn decrypts_real_wrapstudio_fixture() {
        let (Ok(path), Ok(dek_b64)) = (
            std::env::var("WB_FIXTURE_HTML"),
            std::env::var("WB_FIXTURE_DEK"),
        ) else {
            eprintln!("skipping: set WB_FIXTURE_HTML + WB_FIXTURE_DEK");
            return;
        };
        let html = std::fs::read_to_string(path).expect("read fixture html");
        assert!(looks_like_envelope(&html));
        let env = parse(&html).expect("parse");
        assert_eq!(env.cipher, "aes-256-gcm");
        assert_eq!(env.views[0].id, "default");

        let dek_bytes = URL_SAFE_NO_PAD
            .decode(dek_b64.trim_end_matches('='))
            .expect("dek b64url");
        let dek_secret: SecretSlice<u8> =
            SecretSlice::new(dek_bytes.into_boxed_slice());
        let plaintext =
            decrypt_view(&env, "default", &dek_secret).expect("decrypt");
        let s = std::str::from_utf8(plaintext.expose_secret()).unwrap();
        assert!(s.contains("hello sealed world"));
    }
}
