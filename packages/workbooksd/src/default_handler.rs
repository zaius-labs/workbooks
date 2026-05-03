//! `workbooksd set-default-handler <UTI> <BUNDLE_ID>` — flip a UTI's
//! macOS default handler via the public LaunchServices API.
//!
//! Why this exists in the daemon:
//!
//!   The .pkg postinstall needs to make Workbooks the default for
//!   public.html so all .html double-clicks route through us, where
//!   we content-sniff for wb-meta / wb-permissions and either forward
//!   to the daemon or hand off to the user's previous default
//!   browser. Setting that default from a shell script is hard:
//!     - `defaults write com.apple.LaunchServices/...` edits the
//!       LSHandlers array but cfprefsd often ignores the change
//!       until logout.
//!     - PyObjC was stripped from /usr/bin/python3 in macOS Sonoma+,
//!       so `python3 -c "import CoreServices ..."` fails on stock Macs.
//!     - Bundling `duti` adds a third-party signed binary to ship.
//!     - swiftc requires Xcode CLT, not always installed.
//!
//!   So we add a subcommand to workbooksd itself. Same Apple
//!   Developer ID-signed Mach-O, same notarization ticket, same
//!   binary the user already trusts.
//!
//! The function is intentionally no-frills: succeed quietly, fail
//! with a printed error code; the postinstall doesn't fail an
//! install if this returns non-zero.

#[cfg(target_os = "macos")]
pub fn set_default_handler(uti: &str, bundle_id: &str) -> i32 {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    // Roles bitmask mirroring CoreServices' LSRolesMask. We pass
    // kLSRolesAll (0xFFFFFFFF) so Workbooks becomes default for
    // every role — Editor, Viewer, Shell, None — that the UTI's
    // declarations support. For public.html the only role we claim
    // is Editor, so the user's actual default for Viewer is left
    // intact… in theory. In practice macOS treats kLSRolesAll as
    // "all candidates' supported roles", which lines up with what
    // the user expects: open in Workbooks regardless.
    const K_LS_ROLES_ALL: u32 = 0xFFFF_FFFF;

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSSetDefaultRoleHandlerForContentType(
            in_content_type: CFStringRef,
            in_role: u32,
            in_handler_bundle_id: CFStringRef,
        ) -> i32;
    }

    let cf_uti = CFString::new(uti);
    let cf_bid = CFString::new(bundle_id);
    unsafe {
        LSSetDefaultRoleHandlerForContentType(
            cf_uti.as_concrete_TypeRef(),
            K_LS_ROLES_ALL,
            cf_bid.as_concrete_TypeRef(),
        )
    }
}

#[cfg(not(target_os = "macos"))]
pub fn set_default_handler(_uti: &str, _bundle_id: &str) -> i32 {
    // Non-Mac targets don't have LaunchServices — return a
    // distinct error so callers can no-op gracefully.
    -1
}
