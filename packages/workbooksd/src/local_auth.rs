// C9.5 — local-credential gate before sensitive sealed-workbook
// operations.
//
// Closes THREAT_MODEL.md §4.1 row 15: stolen unlocked laptop with
// cached lease + wrapped DEK in OS keychain = adversary opens every
// sealed workbook the user previously opened, until lease expiry.
// The fix: gate cached-lease opens (and later, secret reads) behind
// a local platform-authenticator gesture. macOS Touch ID / Apple
// Watch / system password are all handled by the LocalAuthentication
// framework. Linux + Windows return Unsupported until proper impls
// land.
//
// Consumer (lands with C1.9 lease cache):
//   match local_auth::prompt("Open 'Q1 forecast'") {
//       Ok(LocalAuthOutcome::Authorized) => unwrap_cached_dek()?,
//       Ok(LocalAuthOutcome::Cancelled)  => return user_cancelled(),
//       Ok(LocalAuthOutcome::Unsupported) => {
//           // Policy hint decides: fail-closed (deny) or fall through
//           // to a fresh broker auth. Default fail-closed for
//           // "recheck=on_open" workbooks.
//       }
//       Err(e) => log_and_deny(e),
//   }
//
// Tracker: bd show core-l6n.5

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalAuthOutcome {
    /// User completed the prompt successfully.
    Authorized,
    /// User declined / cancelled / app reason was rejected by policy.
    Cancelled,
    /// Platform doesn't support local-presence prompts. Caller decides
    /// whether to fail closed or fall through to a different path.
    Unsupported,
}

#[derive(Debug)]
pub enum LocalAuthError {
    /// Platform / framework error. The string carries the platform's
    /// own error description (NSError localizedDescription on macOS).
    Platform(String),
    /// Hard timeout from the daemon side — we bound the wait so a
    /// stuck prompt doesn't pin a request handler forever.
    Timeout,
}

impl std::fmt::Display for LocalAuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Platform(e) => write!(f, "local-auth platform error: {e}"),
            Self::Timeout => write!(f, "local-auth prompt timed out"),
        }
    }
}

impl std::error::Error for LocalAuthError {}

/// Prompt the user with a local-presence check. Blocks the calling
/// thread until the user completes or cancels the prompt, or the
/// platform timeout fires. The `reason` is shown verbatim in the
/// system prompt — keep it short and specific (e.g.
/// "Open 'Q1 forecast'").
///
/// Hard timeout of 60 seconds — covers slow biometric attempts but
/// bounds a forgotten dialog.
pub fn prompt(reason: &str) -> Result<LocalAuthOutcome, LocalAuthError> {
    platform::prompt(reason)
}

#[cfg(target_os = "macos")]
mod platform {
    //! macOS impl via the LocalAuthentication framework.
    //!
    //! LAContext.evaluatePolicy is async — completion handler called
    //! on a background queue. We bridge to sync via std::sync::mpsc
    //! and a 60s recv_timeout. The framework owns the UI thread, so
    //! the prompt renders correctly even when the daemon's calling
    //! thread is a tokio worker.
    //!
    //! Policy: deviceOwnerAuthentication = biometric + system password
    //! fallback. The user gets Touch ID / Apple Watch first; if those
    //! fail or aren't available, the password sheet appears. This is
    //! the right default for "prove user is here" — biometric-only
    //! locks out the (rare but real) user with no enrolled biometric.
    use super::{LocalAuthError, LocalAuthOutcome};
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};
    use std::sync::mpsc;
    use std::time::Duration;

    const PROMPT_TIMEOUT: Duration = Duration::from_secs(60);

    pub fn prompt(reason: &str) -> Result<LocalAuthOutcome, LocalAuthError> {
        // SAFETY: LAContext is the documented entry point; alloc/init
        // pattern is standard objc2. The reason string is held by
        // NSString for the duration of the call.
        let context = unsafe { LAContext::new() };
        let reason_ns = NSString::from_str(reason);

        // First, canDeviceUseEvaluatePolicy — if the system has no
        // configured authentication mechanism (very old hardware, no
        // password set), return Unsupported rather than a misleading
        // "platform error." objc2 binding returns Result<(), Retained<NSError>>
        // for the *_error variant; Ok = canEvaluate, Err = cannot.
        let can_eval = unsafe {
            context.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication)
        };
        if can_eval.is_err() {
            // Some "can't evaluate" cases are recoverable (no biometry
            // enrolled but password works) — those return Ok for
            // DeviceOwnerAuthentication. An Err here means even the
            // password fallback is unusable; treat as Unsupported.
            return Ok(LocalAuthOutcome::Unsupported);
        }

        let (tx, rx) = mpsc::channel::<Result<LocalAuthOutcome, LocalAuthError>>();

        // The completion handler must be a stable Block; objc2 wants
        // RcBlock so the framework can retain it. The closure is
        // FnMut(Bool, *mut NSError) — we send a single result and
        // drop the channel.
        let tx_clone = tx.clone();
        let block = RcBlock::new(move |success: Bool, error: *mut NSError| {
            let outcome = if success.as_bool() {
                Ok(LocalAuthOutcome::Authorized)
            } else if error.is_null() {
                // Framework convention: success=false + nil error is
                // "user cancelled."
                Ok(LocalAuthOutcome::Cancelled)
            } else {
                let err_msg = unsafe {
                    (*error).localizedDescription().to_string()
                };
                // Distinguish user-cancel codes from real errors. The
                // common cancel codes (-2 LAErrorUserCancel, -4
                // LAErrorSystemCancel, -8 LAErrorAppCancel) all
                // surface as "Cancelled" to the caller. Other codes
                // bubble as Platform errors.
                let code = unsafe { (*error).code() };
                match code {
                    -2 | -4 | -8 | -9 => Ok(LocalAuthOutcome::Cancelled),
                    _ => Err(LocalAuthError::Platform(err_msg)),
                }
            };
            // Send is best-effort — if the daemon already timed out
            // and dropped the receiver, the closure runs but the send
            // fails silently. That's fine; result is discarded.
            let _ = tx_clone.send(outcome);
        });

        unsafe {
            context.evaluatePolicy_localizedReason_reply(
                LAPolicy::DeviceOwnerAuthentication,
                &reason_ns,
                &block,
            );
        }

        match rx.recv_timeout(PROMPT_TIMEOUT) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => Err(LocalAuthError::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(
                LocalAuthError::Platform(
                    "completion handler dropped without reply".into(),
                ),
            ),
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    //! Linux stub. Real impl options:
    //!  - polkit (org.freedesktop.policykit1) — system-prompt for
    //!    privilege escalation, works on most desktops with logind.
    //!  - libsecret + Secret Service auth — already in our keyring
    //!    chain, but doesn't natively prompt for re-auth.
    //!  - WebAuthn platform authenticator — modern but spotty
    //!    desktop support today.
    //! Filed as follow-up to C9.5; for now the daemon falls back to
    //! the broker round-trip on Linux, which is acceptable but loses
    //! the offline-grace property.
    use super::{LocalAuthError, LocalAuthOutcome};
    pub fn prompt(_reason: &str) -> Result<LocalAuthOutcome, LocalAuthError> {
        Ok(LocalAuthOutcome::Unsupported)
    }
}

#[cfg(target_os = "windows")]
mod platform {
    //! Windows stub. Real impl: Windows Hello via the
    //! UserConsentVerifier WinRT API (Windows.Security.Credentials.UI),
    //! or WebAuthn platform authenticator. Either path is a
    //! significant FFI chunk; deferred to follow-up.
    use super::{LocalAuthError, LocalAuthOutcome};
    pub fn prompt(_reason: &str) -> Result<LocalAuthOutcome, LocalAuthError> {
        Ok(LocalAuthOutcome::Unsupported)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod platform {
    use super::{LocalAuthError, LocalAuthOutcome};
    pub fn prompt(_reason: &str) -> Result<LocalAuthOutcome, LocalAuthError> {
        Ok(LocalAuthOutcome::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcome_variants_are_exhaustive() {
        // Compile-time guard that the enum doesn't gain a variant
        // without the consumers (C1.9 lease cache, future secret
        // re-auth) being updated.
        let outcomes = [
            LocalAuthOutcome::Authorized,
            LocalAuthOutcome::Cancelled,
            LocalAuthOutcome::Unsupported,
        ];
        for o in outcomes {
            match o {
                LocalAuthOutcome::Authorized
                | LocalAuthOutcome::Cancelled
                | LocalAuthOutcome::Unsupported => {}
            }
        }
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn non_macos_returns_unsupported() {
        // On non-macOS we always return Unsupported. The macOS test
        // would actually prompt the user for Touch ID — not safe to
        // run in CI, so it's not included here.
        let r = prompt("test reason");
        assert!(matches!(r, Ok(LocalAuthOutcome::Unsupported)));
    }
}
