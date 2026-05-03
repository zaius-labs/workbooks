//! `com.apple.LaunchServices.OpenWith` xattr writer — macOS only.
//!
//! Why this exists: macOS Sequoia (and Ventura+) blocks any
//! programmatic claim of `public.html` as a default handler — apps
//! attempting LSSetDefaultRoleHandlerForContentType, defaults plist
//! edits, or even removing the existing entry all get silently
//! overridden by launchservicesd. Apple gates browser-default
//! changes behind explicit user consent (System Settings → Default
//! web browser, or Get Info → Change All).
//!
//! BUT: macOS still honours the per-file OpenWith xattr above the
//! system default. When LaunchServices opens a file, it checks for
//! `com.apple.LaunchServices.OpenWith` first; only if absent does
//! it fall back to the per-UTI default. This gives us the bypass:
//! stamp the xattr on every workbook file we touch, and that file
//! routes to Workbooks regardless of what the user has set as their
//! default browser.
//!
//! This module exposes one function: `stamp(path)`. It writes the
//! xattr in the exact binary-plist format Finder writes when a user
//! does Get Info → "Open with: Workbooks" → "Change All" (which is
//! macOS's user-consent path for the same outcome — but per file,
//! not per UTI). LaunchServices treats both writes identically.
//!
//! Where we call it from:
//!   - `/open` handler: every workbook the user opens via Workbooks
//!     gets stamped, so subsequent double-clicks route automatically.
//!   - `/save` handler: every workbook the daemon writes gets stamped.
//!   - `workbooksd stamp <path>` subcommand: used by the .pkg
//!     postinstall to bulk-stamp existing files in ~/Downloads,
//!     ~/Desktop, ~/Documents.
//!
//! Failure mode: silent best-effort. If setxattr returns an error
//! (file deleted, permissions, network volume that strips xattrs),
//! we log and move on. The workbook still opens correctly the first
//! time via right-click; the user just won't get the auto-routing
//! benefit.

#[cfg(target_os = "macos")]
use std::path::Path;

/// macOS bundle identifier of the Workbooks app — kept in sync with
/// manager/src-tauri/tauri.conf.json's identifier and with the
/// .pkg's bundle layout. If the consolidated app's identifier ever
/// changes, this constant moves with it.
pub const WORKBOOKS_BUNDLE_ID: &str = "sh.workbooks.launcher";

/// macOS install path for Workbooks.app. The xattr payload references
/// this so LaunchServices can find the bundle even if its identifier
/// hasn't been re-cached. Mirrors what Finder writes.
pub const WORKBOOKS_APP_PATH: &str = "/Applications/Workbooks.app";

const XATTR_NAME: &str = "com.apple.LaunchServices.OpenWith";

/// Stamp `path` so LaunchServices opens it via Workbooks regardless
/// of the user's default browser. Returns `Ok(())` on success, an
/// error string on failure. Best-effort callers should swallow the
/// error.
#[cfg(target_os = "macos")]
pub fn stamp(path: &Path) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;

    // Build the binary-plist payload. The shape mirrors what Finder
    // writes for a file you've explicitly chosen to open with
    // Workbooks via Get Info → "Always Open With":
    //   bundleidentifier        = "sh.workbooks.launcher"
    //   bundlerecordidentifier  = "sh.workbooks.launcher"
    //   path                    = "/Applications/Workbooks.app"
    //   version                 = 0
    let mut dict = plist::Dictionary::new();
    dict.insert(
        "bundleidentifier".into(),
        plist::Value::String(WORKBOOKS_BUNDLE_ID.into()),
    );
    dict.insert(
        "bundlerecordidentifier".into(),
        plist::Value::String(WORKBOOKS_BUNDLE_ID.into()),
    );
    dict.insert(
        "path".into(),
        plist::Value::String(WORKBOOKS_APP_PATH.into()),
    );
    dict.insert("version".into(), plist::Value::Integer(0i64.into()));

    let mut buf: Vec<u8> = Vec::new();
    plist::to_writer_binary(&mut buf, &plist::Value::Dictionary(dict))
        .map_err(|e| format!("plist serialize: {e}"))?;

    // setxattr() via libc. CString conversion can fail only if the
    // path contains an interior NUL — vanishingly unlikely on Mac
    // filesystems, but we propagate it as an error rather than panic.
    let cpath = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|e| format!("path cstring: {e}"))?;
    let cname = std::ffi::CString::new(XATTR_NAME).expect("static xattr name is C-safe");

    // SAFETY: setxattr is a thread-safe POSIX-style call; we pass
    // valid CStrings and a valid byte buffer with its length.
    let rc = unsafe {
        libc::setxattr(
            cpath.as_ptr(),
            cname.as_ptr(),
            buf.as_ptr() as *const _,
            buf.len(),
            0, // position: always 0 for normal xattrs (only nonzero for resource forks)
            0, // options: 0 = create-or-replace
        )
    };
    if rc != 0 {
        return Err(format!(
            "setxattr {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

/// Non-macOS no-op. Lets the call sites compile cross-platform without
/// `cfg` gates everywhere; xattrs in the macOS-LaunchServices sense
/// don't exist on Linux/Windows.
#[cfg(not(target_os = "macos"))]
pub fn stamp(_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}
