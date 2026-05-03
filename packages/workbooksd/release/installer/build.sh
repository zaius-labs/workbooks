#!/usr/bin/env bash
# Build a notarizable Workbooks-<version>.pkg from this Mac.
#
# Layout, post-consolidation:
#
#   /Applications/Workbooks.app
#       Tauri 2 + Svelte app that:
#         - embeds workbooksd as a Tauri sidecar
#           (Contents/MacOS/workbooksd, signed individually with
#           the Hardened Runtime)
#         - spawns the daemon detached at first launch (setsid)
#         - claims sh.workbooks.workbook UTI + public.html Alternate
#         - routes Finder odoc events to the daemon's /open
#       This replaces both the prior shell-script Workbooks.app AND
#       the standalone /usr/local/bin/workbooksd. One .app, one
#       binary path.
#
# Postinstall: removes the legacy LaunchAgent + /usr/local/bin/workbooksd
# if either is present (clean migration off the old install). See
# scripts/postinstall.
#
# Prereqs:
#   ~/.workbooks/notary.env populated by setup.sh (APPLE_DEV_ID_NAME +
#   notary credentials), plus a Developer ID INSTALLER cert in keychain
#   (separate from the Application cert used for code signing). Verify:
#     security find-identity -p basic -v | grep "Developer ID Installer"
#
# Usage:
#   ./build.sh 0.2.0                    # full build + sign + notarize
#   ./build.sh 0.2.0 --skip-notarize    # smoke-test without Apple round-trip
#   ./build.sh 0.2.0 --skip-sign        # build unsigned (layout debugging)

set -euo pipefail

VERSION="${1:?usage: $0 <version> [--skip-notarize|--skip-sign]}"
shift || true
SKIP_NOTARIZE=0
SKIP_SIGN=0
for arg in "$@"; do
  case "$arg" in
    --skip-notarize) SKIP_NOTARIZE=1 ;;
    --skip-sign)     SKIP_SIGN=1 ; SKIP_NOTARIZE=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

HERE=$(cd "$(dirname "$0")" && pwd)
RELEASE_DIR=$(cd "$HERE/.." && pwd)
RUNTIME_DIR=$(cd "$RELEASE_DIR/.." && pwd)
REPO_ROOT=$(cd "$RUNTIME_DIR/../.." && pwd)
MANAGER_DIR="$REPO_ROOT/manager"
ENV_FILE="$HOME/.workbooks/notary.env"

# Stable identifier across versions so the installer database
# correlates upgrades as the same product.
PKG_ID="sh.workbooks.workbooksd"

if [ "$SKIP_SIGN" = "0" ] || [ "$SKIP_NOTARIZE" = "0" ]; then
  if [ ! -f "$ENV_FILE" ]; then
    echo "Missing $ENV_FILE — run setup.sh first" >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

if [ "$SKIP_SIGN" = "0" ]; then
  : "${APPLE_DEV_ID_NAME:?not set in $ENV_FILE}"
  APPLE_DEV_ID_INSTALLER_NAME="${APPLE_DEV_ID_INSTALLER_NAME:-${APPLE_DEV_ID_NAME/Application/Installer}}"
  if ! security find-identity -p basic -v | grep -qF "$APPLE_DEV_ID_INSTALLER_NAME"; then
    echo "Developer ID Installer identity not found in keychain:" >&2
    echo "  $APPLE_DEV_ID_INSTALLER_NAME" >&2
    echo "Available identities:" >&2
    security find-identity -p basic -v >&2
    exit 1
  fi
fi

if [ "$SKIP_NOTARIZE" = "0" ]; then
  : "${APPLE_NOTARY_KEY_PATH:?not set in $ENV_FILE}"
  : "${APPLE_NOTARY_KEY_ID:?not set in $ENV_FILE}"
  : "${APPLE_NOTARY_ISSUER:?not set in $ENV_FILE}"
fi

# ── 1. Build workbooksd both arches ──────────────────────────────

TARGETS=(aarch64-apple-darwin x86_64-apple-darwin)
echo "[pkg] building workbooksd for both arches..."
for t in "${TARGETS[@]}"; do
  rustup target add "$t" >/dev/null 2>&1 || true
  ( cd "$RUNTIME_DIR" && cargo build --release --target "$t" )
  strip "$RUNTIME_DIR/target/$t/release/workbooksd" || true
done

STAGE_DIR=$(mktemp -d -t workbooks-pkg-XXXXXX)
trap 'rm -rf "$STAGE_DIR"' EXIT

# ── 2. Stage signed sidecar binaries for Tauri's bundler ─────────

# Tauri's bundler picks up `binaries/workbooksd-<TARGET>` from
# manager/src-tauri/binaries/, copies into Workbooks.app/Contents/MacOS/
# at bundle time, and strips the triple suffix. We pre-sign each
# arch here so the bundle ships with Hardened Runtime + a timestamp
# (Tauri's signing pass alone wouldn't cover externalBins).
mkdir -p "$MANAGER_DIR/src-tauri/binaries"
for t in "${TARGETS[@]}"; do
  src="$RUNTIME_DIR/target/$t/release/workbooksd"
  dst="$MANAGER_DIR/src-tauri/binaries/workbooksd-$t"
  cp "$src" "$dst"
  chmod +x "$dst"
  if [ "$SKIP_SIGN" = "0" ]; then
    echo "[pkg] codesigning sidecar $t..."
    codesign --sign "$APPLE_DEV_ID_NAME" \
             --options runtime --timestamp --force "$dst"
    codesign --verify --strict --verbose=2 "$dst"
  fi
done

# ── 3. Build the Tauri Manager bundle ────────────────────────────

echo "[pkg] building Tauri Manager (Workbooks.app)..."
( cd "$MANAGER_DIR" && bun install --silent 2>/dev/null || true
  cd "$MANAGER_DIR" && bun tauri build --bundles app )

TAURI_APP="$MANAGER_DIR/src-tauri/target/release/bundle/macos/Workbooks.app"
[ -d "$TAURI_APP" ] || { echo "expected $TAURI_APP, not found" >&2; exit 1; }

# ── 4. Re-sign the bundle (inner-out) ────────────────────────────
# Tauri signs the outer .app but doesn't touch the embedded sidecar
# during its own pass — and even when it does, --options runtime +
# --timestamp aren't applied in a way Apple's notary accepts. We
# re-sign explicitly: inner workbooksd first, then the outer .app.
#
# DO NOT use --deep here. --deep tries to re-sign every Mach-O it
# finds (including bundled framework dylibs Tauri already signed
# correctly) and Apple has been deprecating it. Inside-out manual
# signing is the supported path.

if [ "$SKIP_SIGN" = "0" ]; then
  echo "[pkg] re-signing Workbooks.app (inside-out)..."
  codesign --sign "$APPLE_DEV_ID_NAME" \
           --options runtime --timestamp --force \
           "$TAURI_APP/Contents/MacOS/workbooksd"
  codesign --sign "$APPLE_DEV_ID_NAME" \
           --options runtime --timestamp --force \
           "$TAURI_APP/Contents/MacOS/workbooks-manager"
  codesign --sign "$APPLE_DEV_ID_NAME" \
           --options runtime --timestamp --force \
           "$TAURI_APP"
  codesign --verify --strict --verbose=2 "$TAURI_APP"
fi

# ── 5. Notarize the .app standalone (so the bundle stays valid
#       even if the user pulls it OUT of the .pkg) ────────────────

if [ "$SKIP_NOTARIZE" = "0" ]; then
  echo "[pkg] notarizing Workbooks.app (typically 30s–3m)..."
  app_zip="/tmp/Workbooks-app-$$.zip"
  ditto -c -k --keepParent "$TAURI_APP" "$app_zip"
  xcrun notarytool submit "$app_zip" \
    --key "$APPLE_NOTARY_KEY_PATH" \
    --key-id "$APPLE_NOTARY_KEY_ID" \
    --issuer "$APPLE_NOTARY_ISSUER" \
    --wait
  rm -f "$app_zip"

  echo "[pkg] stapling Workbooks.app..."
  xcrun stapler staple "$TAURI_APP"
  xcrun stapler validate "$TAURI_APP"
fi

# ── 6. Build + sign + notarize the standalone daemon binary ──────
#
# The .pkg ships TWO things that operate independently:
#
#   /usr/local/bin/workbooksd       universal daemon, supervised by
#                                   a user-scoped LaunchAgent so it
#                                   starts at login + restarts on
#                                   crash. Browser-served workbooks
#                                   keep autosaving without the user
#                                   ever opening the Manager UI.
#
#   /Applications/Workbooks.app     Tauri Manager UI, opened on
#                                   demand (Spotlight, Dock, file
#                                   double-click). Detects the
#                                   running LaunchAgent daemon via
#                                   runtime.json and attaches; only
#                                   spawns its bundled sidecar as a
#                                   fallback if no daemon is up.
#
# Both signed/notarized; LaunchAgent is bootstrapped by postinstall.

UNIVERSAL_BIN="$STAGE_DIR/workbooksd-universal"
echo "[pkg] lipo'ing daemon into universal binary for /usr/local/bin..."
lipo -create -output "$UNIVERSAL_BIN" \
  "$RUNTIME_DIR/target/aarch64-apple-darwin/release/workbooksd" \
  "$RUNTIME_DIR/target/x86_64-apple-darwin/release/workbooksd"

if [ "$SKIP_SIGN" = "0" ]; then
  echo "[pkg] codesigning universal daemon..."
  codesign --sign "$APPLE_DEV_ID_NAME" \
           --options runtime --timestamp --force "$UNIVERSAL_BIN"
  codesign --verify --strict --verbose=2 "$UNIVERSAL_BIN"
fi

if [ "$SKIP_NOTARIZE" = "0" ]; then
  echo "[pkg] notarizing universal daemon..."
  bin_zip="/tmp/workbooksd-universal-$$.zip"
  ditto -c -k --keepParent "$UNIVERSAL_BIN" "$bin_zip"
  xcrun notarytool submit "$bin_zip" \
    --key "$APPLE_NOTARY_KEY_PATH" \
    --key-id "$APPLE_NOTARY_KEY_ID" \
    --issuer "$APPLE_NOTARY_ISSUER" \
    --wait
  rm -f "$bin_zip"
  # Bare Mach-O can't be stapled (stapler only does .app/.dmg/.pkg);
  # Gatekeeper checks the notarization ticket online at first launch.
fi

# ── 7. Stage payload tree (Workbooks.app + /usr/local/bin/workbooksd) ──

PAYLOAD_DIR="$STAGE_DIR/payload"
mkdir -p "$PAYLOAD_DIR/Applications" "$PAYLOAD_DIR/usr/local/bin"
ditto "$TAURI_APP" "$PAYLOAD_DIR/Applications/Workbooks.app"
cp "$UNIVERSAL_BIN" "$PAYLOAD_DIR/usr/local/bin/workbooksd"
chmod +x "$PAYLOAD_DIR/usr/local/bin/workbooksd"

# ── 8. Postinstall scripts ───────────────────────────────────────

SCRIPTS_DIR="$STAGE_DIR/scripts"
mkdir -p "$SCRIPTS_DIR"
cp "$HERE/scripts/preinstall"  "$SCRIPTS_DIR/preinstall"
cp "$HERE/scripts/postinstall" "$SCRIPTS_DIR/postinstall"
chmod +x "$SCRIPTS_DIR/preinstall" "$SCRIPTS_DIR/postinstall"

# ── 9. Build the component .pkg ──────────────────────────────────

COMPONENT_PKG="$STAGE_DIR/component.pkg"
echo "[pkg] running pkgbuild..."
pkgbuild \
  --root "$PAYLOAD_DIR" \
  --identifier "$PKG_ID" \
  --version "$VERSION" \
  --scripts "$SCRIPTS_DIR" \
  --install-location "/" \
  "$COMPONENT_PKG"

# ── 9. Wrap in a distribution package (GUI installer) ────────────

DIST_XML="$STAGE_DIR/distribution.xml"
sed "s/{{VERSION}}/$VERSION/g" "$HERE/distribution.template.xml" > "$DIST_XML"

UNSIGNED_PKG="$STAGE_DIR/Workbooks-$VERSION-unsigned.pkg"
echo "[pkg] running productbuild..."
productbuild \
  --distribution "$DIST_XML" \
  --package-path "$STAGE_DIR" \
  "$UNSIGNED_PKG"

# ── 10. Sign + notarize + staple the final pkg ───────────────────

OUT_PKG="$RELEASE_DIR/dist/Workbooks-$VERSION.pkg"
mkdir -p "$(dirname "$OUT_PKG")"

if [ "$SKIP_SIGN" = "0" ]; then
  echo "[pkg] productsign..."
  productsign --sign "$APPLE_DEV_ID_INSTALLER_NAME" \
              --timestamp \
              "$UNSIGNED_PKG" "$OUT_PKG"
  pkgutil --check-signature "$OUT_PKG" | head -10
else
  cp "$UNSIGNED_PKG" "$OUT_PKG"
fi

if [ "$SKIP_NOTARIZE" = "0" ]; then
  echo "[pkg] notarizing pkg..."
  xcrun notarytool submit "$OUT_PKG" \
    --key "$APPLE_NOTARY_KEY_PATH" \
    --key-id "$APPLE_NOTARY_KEY_ID" \
    --issuer "$APPLE_NOTARY_ISSUER" \
    --wait

  echo "[pkg] stapling pkg..."
  xcrun stapler staple "$OUT_PKG"
  xcrun stapler validate "$OUT_PKG"
fi

if [ "$SKIP_SIGN" = "0" ] && [ "$SKIP_NOTARIZE" = "0" ]; then
  echo
  echo "[pkg] Gatekeeper verdict:"
  spctl -a -vv -t install "$OUT_PKG" 2>&1 || true
fi

echo
echo "[pkg] done."
echo "  → $OUT_PKG ($(wc -c < "$OUT_PKG") bytes)"
echo
echo "Test locally:"
echo "  open \"$OUT_PKG\""
