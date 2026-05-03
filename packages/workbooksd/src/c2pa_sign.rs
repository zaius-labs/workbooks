// C2PA / Content Authenticity Initiative — opt-in sidecar signing.
//
// On every save (when the workbook has approved the `c2pa`
// permission), we build a Content Credentials manifest from the
// in-file edit log and sign it with a per-machine ed25519 key,
// writing the result as a sidecar `.workbook.html.c2pa`.
//
// Why sidecar and not embedded:
//   - The official c2pa Rust crate doesn't yet support HTML as
//     an asset binding format. Sidecars are the documented
//     escape hatch and the Reader auto-pairs by filename.
//   - Sidecar means the .workbook.html stays one self-contained
//     file (the project's north-star). The .c2pa is a second
//     file you SHIP IF YOU CARE — clone-and-open without it
//     keeps working.
//
// Why per-machine, not PKI:
//   - Self-signed end-entity cert held by the daemon. No CA, no
//     org. The portal viewer at workbooks.sh/inspect (core-5ah.13)
//     surfaces the signer cert's fingerprint so a viewer can
//     match "this is the same machine that signed last week's
//     save" without trusting a chain of authorities.
//   - Upgrade path to Adobe-style PKI is core-5ah.15 (deferred);
//     same Builder API, just swap the cert source.

use std::path::{Path, PathBuf};

use c2pa::{
    assertions::DataHash, create_signer::from_keys, hash_stream_by_alg, Builder, Reader,
    SigningAlg,
};
use serde_json::json;

use crate::edit_log::Entry;

/// Returns true when this build was compiled with c2pa support. We
/// could feature-gate the entire module but the dep is only ~1m of
/// build time and we want the same binary to work for everyone —
/// the runtime cost is zero unless `c2pa` permission is granted.
pub fn enabled() -> bool { true }

/// Where the daemon's persistent signing identity lives. One pair
/// (cert + key) shared across every workbook on this machine, so
/// the portal can correlate "all saves from this signer."
fn identity_dir() -> PathBuf {
    let mut p: PathBuf = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    #[cfg(target_os = "macos")]
    { p.push("Library/Application Support/sh.workbooks.workbooksd"); }
    #[cfg(not(target_os = "macos"))]
    { p.push(".local/share/workbooksd"); }
    p.push("signing");
    p
}

fn cert_path() -> PathBuf { identity_dir().join("cert.pem") }
fn key_path()  -> PathBuf { identity_dir().join("key.pem") }

/// Re-export the identity dir for sister modules (claim_sign.rs).
/// The directory holds cert.pem + key.pem from this module plus
/// author_identity.json from claim_sign — keeping all per-machine
/// signing identity material under one $HOME path simplifies
/// backup, perms-tightening, and reset.
pub fn identity_dir_for_claim_signer() -> PathBuf {
    identity_dir()
}

/// Mint a per-machine ed25519 keypair + self-signed cert if none
/// exists yet. Idempotent — every subsequent save loads the same
/// identity. Returns `(cert_pem, key_pem)`.
pub fn ensure_identity() -> Result<(Vec<u8>, Vec<u8>), String> {
    let dir = identity_dir();
    if let (Ok(c), Ok(k)) = (
        std::fs::read(cert_path()),
        std::fs::read(key_path()),
    ) {
        return Ok((c, k));
    }

    // Mint fresh.
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    let alg = &rcgen::PKCS_ED25519;
    let kp = rcgen::KeyPair::generate_for(alg)
        .map_err(|e| format!("ed25519 keygen: {e}"))?;

    let mut params = rcgen::CertificateParams::new(vec!["workbooks.local".to_string()])
        .map_err(|e| format!("cert params: {e}"))?;
    params.distinguished_name.push(rcgen::DnType::CommonName, "workbooks-daemon");
    params.distinguished_name.push(rcgen::DnType::OrganizationName, "Workbooks (per-machine)");
    // c2pa enforces an EKU on the signing cert from a fixed list
    // (see c2pa-rs/src/crypto/cose/valid_eku_oids.cfg). We add
    // emailProtection because it's the broadest-supported member
    // of the list and lets us self-sign without a CA. The portal
    // viewer surfaces the cert's identity directly to the user
    // anyway — the EKU is just a c2pa-spec gate.
    params.extended_key_usages = vec![
        rcgen::ExtendedKeyUsagePurpose::EmailProtection,
    ];
    // Without a digitalSignature key usage flag the c2pa profile
    // check fails with "missing digitalSignature EKU". Set the
    // canonical signing flags.
    params.key_usages = vec![
        rcgen::KeyUsagePurpose::DigitalSignature,
        rcgen::KeyUsagePurpose::ContentCommitment,
    ];
    // c2pa's profile check requires an AuthorityKeyIdentifier on
    // every signing cert. rcgen 0.13 omits it by default for
    // self-signed certs; flip the flag so the resulting cert
    // carries the AKI extension (which on a self-signed cert
    // points back to its own subject key — equivalent to SKI).
    params.use_authority_key_identifier_extension = true;
    // The portal validates against the cert ANCHORED IN THE
    // MANIFEST at save time, not a wall-clock current cert — so
    // expiration here only governs "is this signer still issuing
    // new claims," not "are old claims still valid." Stretch
    // validity well into the future; we'll re-mint when we need to.
    let now = time::OffsetDateTime::now_utc();
    params.not_before = now;
    params.not_after = now + time::Duration::days(365 * 5);

    let cert = params.self_signed(&kp)
        .map_err(|e| format!("self-sign: {e}"))?;
    let cert_pem = cert.pem();
    let key_pem = kp.serialize_pem();

    // Atomic-ish: write key first (the secret), then cert. If we
    // crash in between, ensure_identity finds an inconsistent
    // pair next time and re-mints — fine, no save has been signed
    // with the half-state yet.
    std::fs::write(key_path(), key_pem.as_bytes())
        .map_err(|e| format!("write key: {e}"))?;
    std::fs::write(cert_path(), cert_pem.as_bytes())
        .map_err(|e| format!("write cert: {e}"))?;
    // Tighten perms on the key — owner read/write only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(
            key_path(),
            std::fs::Permissions::from_mode(0o600),
        );
    }

    Ok((cert_pem.into_bytes(), key_pem.into_bytes()))
}

/// Build + sign + write the sidecar. Called from save_workbook
/// when the `c2pa` permission is granted. `body` is the final HTML
/// (with edit log already appended) so its sha256 in the assertion
/// matches what's on disk after this call.
///
/// The manifest carries:
///   - claim_generator_info: "workbooksd <version>"
///   - assertion `wb.edit_log`: full edit-log array
///   - assertion `wb.workbook_id`: the substrate UUID
///   - assertion `wb.content_sha256`: hash of the HTML being signed
///
/// We use custom labels (`wb.*`) rather than CAWG's training-mining
/// since our use case is "workbook authorship," not LLM training
/// data. The C2PA spec allows any `<reverse-domain>.<label>` so
/// this is fully compliant.
pub fn sign_sidecar(
    html_path: &Path,
    body: &[u8],
    workbook_id: &str,
    log_entries: &[Entry],
) -> Result<PathBuf, String> {
    let (cert, key) = ensure_identity()?;

    // Trust list: register our own self-signed cert as a user
    // anchor so the crate's trust check passes. Without this the
    // signer fails with "the certificate is invalid" — the c2pa
    // crate enforces a chain of trust by default and won't fall
    // back to "unknown self-signed = ok." Per-machine identity by
    // design isn't anchored anywhere external, so we anchor against
    // ourselves. The portal viewer (.13) surfaces the cert
    // fingerprint to the user explicitly, so the user can decide
    // whether to trust this signer the same way they'd trust an
    // ssh host key.
    let cert_str = std::str::from_utf8(&cert)
        .map_err(|e| format!("cert utf8: {e}"))?;
    let toml = format!(
        "[trust]\nuser_anchors = \"\"\"\n{cert_str}\n\"\"\"\n[cawg_trust]\nuser_anchors = \"\"\"\n{cert_str}\n\"\"\"\n"
    );
    c2pa::settings::Settings::from_toml(&toml)
        .map_err(|e| format!("c2pa settings: {e}"))?;

    let signer = from_keys(&cert, &key, SigningAlg::Ed25519, None)
        .map_err(|e| format!("c2pa signer: {e}"))?;

    use sha2::{Digest, Sha256};
    let content_sha = hex::encode(Sha256::digest(body));

    // Builder takes a JSON manifest definition (see c2pa spec
    // § Manifest Definition). We skip the asset/format binding
    // since this is a sidecar — the Reader pairs by filename.
    let manifest_def = json!({
        "claim_generator_info": [{
            "name": "workbooksd",
            "version": env!("CARGO_PKG_VERSION"),
        }],
        "format": "text/html",
        "title": html_path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("workbook.html"),
        "assertions": [
            {
                "label": "wb.workbook_id",
                "data": { "workbook_id": workbook_id },
            },
            {
                "label": "wb.content_sha256",
                "data": { "sha256": content_sha, "size": body.len() },
            },
            {
                "label": "wb.edit_log",
                "data": {
                    "entries": log_entries.iter().map(|e| json!({
                        "ts": e.ts,
                        "agent": e.agent,
                        "sha256_after": e.sha256_after,
                        "size_after": e.size_after,
                    })).collect::<Vec<_>>(),
                },
            },
        ],
    });

    let mut builder = Builder::from_json(&manifest_def.to_string())
        .map_err(|e| format!("c2pa manifest parse: {e}"))?;

    // Sidecar mode: c2pa's Builder::sign() refuses unrecognized
    // formats (HTML isn't a registered asset binding format yet
    // per the C2PA spec). The escape hatch is `data_hashed`
    // signing: prime the builder with a DataHash placeholder
    // (which also satisfies the "claim must have hash binding"
    // invariant), compute the real sha256 of the HTML, then call
    // sign_data_hashed_embeddable. The output is a detached
    // manifest tagged "application/c2pa" — Reader pairs it with
    // the HTML by re-hashing at validate time.
    let _placeholder = builder
        .data_hashed_placeholder(signer.reserve_size(), "application/c2pa")
        .map_err(|e| format!("c2pa placeholder: {e}"))?;

    let mut dh = DataHash::new("workbook_content", "sha256");
    let mut src = std::io::Cursor::new(body.to_vec());
    let hash = hash_stream_by_alg("sha256", &mut src, None, true)
        .map_err(|e| format!("c2pa hash: {e}"))?;
    dh.set_hash(hash);

    let manifest_bytes = builder
        .sign_data_hashed_embeddable(&*signer, &dh, "application/c2pa")
        .map_err(|e| format!("c2pa sign: {e}"))?;

    // Sidecar conventionally is `<original>.c2pa` — Reader
    // auto-pairs by adding the suffix to whatever filename is
    // passed in.
    let sidecar = sidecar_path_for(html_path);
    std::fs::write(&sidecar, &manifest_bytes)
        .map_err(|e| format!("write sidecar {}: {e}", sidecar.display()))?;
    Ok(sidecar)
}

/// `<file>.c2pa` next to the source. Reader expects this exact
/// suffix — anything else is silently ignored.
pub fn sidecar_path_for(html_path: &Path) -> PathBuf {
    let mut p = html_path.to_path_buf();
    let mut name = p
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("workbook.html")
        .to_string();
    name.push_str(".c2pa");
    p.set_file_name(name);
    p
}

/// Read the sidecar back and surface the manifest's signer +
/// assertions. Used by the portal viewer (core-5ah.13) and by the
/// E2E test to verify the round-trip.
pub fn read_sidecar(html_path: &Path) -> Result<ReadSummary, String> {
    let sidecar = sidecar_path_for(html_path);
    if !sidecar.exists() {
        return Err(format!("no sidecar at {}", sidecar.display()));
    }
    // Reader::from_file pairs HTML + sidecar by filename. The
    // crate refuses to read formats it doesn't recognize as
    // C2PA-binding, but `from_manifest_data_and_stream` lets us
    // read a sidecar directly.
    let manifest_bytes = std::fs::read(&sidecar)
        .map_err(|e| format!("read sidecar: {e}"))?;
    // Read the manifest as a self-contained C2PA stream — the
    // detached form we wrote at sign time is parseable as
    // "application/c2pa". Cross-checking against the HTML's
    // current bytes (validating the DataHash assertion) is a
    // separate step the portal viewer does explicitly; here we
    // just decode the manifest and surface its claims.
    let mut cur = std::io::Cursor::new(manifest_bytes);
    let reader = Reader::from_stream("application/c2pa", &mut cur)
        .map_err(|e| format!("c2pa read: {e}"))?;
    let active = reader
        .active_manifest()
        .ok_or_else(|| "no active manifest".to_string())?;
    let assertion_labels: Vec<String> = active
        .assertions()
        .iter()
        .map(|a| a.label().to_string())
        .collect();
    Ok(ReadSummary {
        claim_generator: active
            .claim_generator()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        assertion_labels,
        validation_passed: reader.validation_status().is_none()
            || reader
                .validation_status()
                .map(|v| v.iter().all(|s| s.passed()))
                .unwrap_or(true),
    })
}

#[derive(Debug)]
pub struct ReadSummary {
    pub claim_generator: String,
    pub assertion_labels: Vec<String>,
    pub validation_passed: bool,
}
