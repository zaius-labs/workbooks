#!/usr/bin/env bash
# Build a notarizable Workbooks-<version>.pkg from this Mac.
#
# Why a .pkg (vs. the prior .command-in-zip):
#
#   The .command shell script we used to ship in the per-arch zips
#   could be code-signed but NEVER stapled — Apple's `stapler` flatly
#   refuses with "Stapler is incapable of working with Terminal shell
#   script files." That meant Gatekeeper would reject the file on
#   first launch with no offline ticket to fall back on. .pkg, .app,
#   and .dmg are the asset types that DO carry stapleable tickets,
#   so they survive Gatekeeper without needing online lookup.
#
# Output:
#
#   <stage>/Workbooks-<version>.pkg
#       Universal installer (aarch64 + x86_64 lipo'd into one Mach-O).
#       Drops:
#         /usr/local/bin/workbooksd                    bare binary
#         /Applications/Workbooks.app                  launcher .app
#       Postinstall:
#         bootstraps user LaunchAgent for $(stat -f%u /dev/console)
#         registers the .app with Launch Services
#
# Prereqs:
#
#   ~/.workbooks/notary.env populated by setup.sh, plus a Developer
#   ID INSTALLER cert in keychain (separate from the Application cert
#   used for signing the binary). Verify:
#     security find-identity -p basic -v | grep "Developer ID Installer"
#
# Usage:
#
#   ./build-pkg.sh 0.1.1                    # builds + signs + notarizes
#   ./build-pkg.sh 0.1.1 --skip-notarize    # smoke-test without Apple round-trip
#   ./build-pkg.sh 0.1.1 --skip-sign        # build unsigned (for layout debugging)

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
ENV_FILE="$HOME/.workbooks/notary.env"

# Identifiers — keep these stable across versions so launchd /
# Launch Services correlate prior installs as the same product.
PKG_ID="sh.workbooks.workbooksd"
APP_ID="sh.workbooks.launcher"

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
  # Installer cert is named differently from the Application cert.
  # Default: derive from APPLE_DEV_ID_NAME by swapping "Application"
  # for "Installer". Override with APPLE_DEV_ID_INSTALLER_NAME.
  APPLE_DEV_ID_INSTALLER_NAME="${APPLE_DEV_ID_INSTALLER_NAME:-${APPLE_DEV_ID_NAME/Application/Installer}}"
  if ! security find-identity -p basic -v | grep -qF "$APPLE_DEV_ID_INSTALLER_NAME"; then
    echo "Developer ID Installer identity not found in keychain:" >&2
    echo "  $APPLE_DEV_ID_INSTALLER_NAME" >&2
    echo
    echo "Available identities:" >&2
    security find-identity -p basic -v >&2
    echo
    echo "Generate one at https://developer.apple.com/account/resources/certificates/" >&2
    echo "(choose 'Developer ID Installer'), download the .cer, double-click to install." >&2
    exit 1
  fi
fi

if [ "$SKIP_NOTARIZE" = "0" ]; then
  : "${APPLE_NOTARY_KEY_PATH:?not set in $ENV_FILE}"
  : "${APPLE_NOTARY_KEY_ID:?not set in $ENV_FILE}"
  : "${APPLE_NOTARY_ISSUER:?not set in $ENV_FILE}"
fi

# ── 1. Build universal binary ────────────────────────────────────

TARGETS=(aarch64-apple-darwin x86_64-apple-darwin)
echo "[pkg] building both arches..."
for t in "${TARGETS[@]}"; do
  rustup target add "$t" >/dev/null 2>&1 || true
  ( cd "$RUNTIME_DIR" && cargo build --release --target "$t" )
  strip "$RUNTIME_DIR/target/$t/release/workbooksd" || true
done

STAGE_DIR=$(mktemp -d -t workbooksd-pkg-XXXXXX)
trap 'rm -rf "$STAGE_DIR"' EXIT

UNIVERSAL_BIN="$STAGE_DIR/workbooksd"
echo "[pkg] lipo'ing into universal binary..."
lipo -create -output "$UNIVERSAL_BIN" \
  "$RUNTIME_DIR/target/aarch64-apple-darwin/release/workbooksd" \
  "$RUNTIME_DIR/target/x86_64-apple-darwin/release/workbooksd"
echo "  → $UNIVERSAL_BIN ($(wc -c < "$UNIVERSAL_BIN") bytes, $(lipo -archs "$UNIVERSAL_BIN"))"

# ── 2. Sign + notarize the universal binary ──────────────────────
# (Notarization of the binary happens BEFORE pkg assembly so the
# binary inside the .pkg is fully verified-and-stapled equivalent.
# Only the bare binary needs notarytool individually; the .pkg
# wrapper carries its own ticket once stapled.)

if [ "$SKIP_SIGN" = "0" ]; then
  echo "[pkg] codesigning universal binary..."
  codesign --sign "$APPLE_DEV_ID_NAME" \
           --options runtime \
           --timestamp \
           --force \
           "$UNIVERSAL_BIN"
  codesign --verify --strict --verbose=2 "$UNIVERSAL_BIN"
fi

if [ "$SKIP_NOTARIZE" = "0" ]; then
  echo "[pkg] notarizing universal binary..."
  zip="/tmp/workbooksd-universal-$$.zip"
  ditto -c -k --keepParent "$UNIVERSAL_BIN" "$zip"
  xcrun notarytool submit "$zip" \
    --key "$APPLE_NOTARY_KEY_PATH" \
    --key-id "$APPLE_NOTARY_KEY_ID" \
    --issuer "$APPLE_NOTARY_ISSUER" \
    --wait
  rm -f "$zip"
fi

# ── 3. Assemble the .app bundle ──────────────────────────────────

APP_DIR="$STAGE_DIR/payload/Applications/Workbooks.app"
mkdir -p "$APP_DIR/Contents/MacOS"

cat > "$APP_DIR/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>workbooks-launcher</string>
  <key>CFBundleIdentifier</key><string>$APP_ID</string>
  <key>CFBundleName</key><string>Workbooks</string>
  <key>CFBundleDisplayName</key><string>Workbooks</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
  <key>LSUIElement</key><true/>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>Workbook</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSItemContentTypes</key>
      <array><string>sh.workbooks.workbook</string></array>
    </dict>
  </array>
  <key>UTExportedTypeDeclarations</key>
  <array>
    <dict>
      <key>UTTypeIdentifier</key><string>sh.workbooks.workbook</string>
      <key>UTTypeDescription</key><string>Workbook</string>
      <key>UTTypeConformsTo</key>
      <array><string>public.html</string></array>
      <key>UTTypeTagSpecification</key>
      <dict>
        <key>public.filename-extension</key>
        <array><string>workbook.html</string></array>
      </dict>
    </dict>
  </array>
</dict>
</plist>
EOF

# The .app's executable forwards to workbooksd at the well-known
# install path. Hardcoded since the .pkg lays the binary down at
# /usr/local/bin/workbooksd; if the user moves it later we can't
# follow.
cat > "$APP_DIR/Contents/MacOS/workbooks-launcher" <<'EOF'
#!/bin/sh
# Workbooks launcher — forwards Finder open events to the daemon.
# Installed by the workbooksd .pkg; do not edit.
exec /usr/local/bin/workbooksd open "$@"
EOF
chmod +x "$APP_DIR/Contents/MacOS/workbooks-launcher"

if [ "$SKIP_SIGN" = "0" ]; then
  echo "[pkg] codesigning the .app bundle..."
  # Sign the inner script first, then the bundle outer (Apple
  # requires inside-out signing).
  codesign --sign "$APPLE_DEV_ID_NAME" --options runtime --timestamp \
           --force "$APP_DIR/Contents/MacOS/workbooks-launcher"
  codesign --sign "$APPLE_DEV_ID_NAME" --options runtime --timestamp \
           --force "$APP_DIR"
  codesign --verify --strict --verbose=2 "$APP_DIR"
fi

# ── 4. Lay out the binary at /usr/local/bin/ in the payload tree ─

BIN_DEST_DIR="$STAGE_DIR/payload/usr/local/bin"
mkdir -p "$BIN_DEST_DIR"
cp "$UNIVERSAL_BIN" "$BIN_DEST_DIR/workbooksd"
chmod +x "$BIN_DEST_DIR/workbooksd"

# ── 5. Postinstall script — bootstraps user-scoped LaunchAgent ──

SCRIPTS_DIR="$STAGE_DIR/scripts"
mkdir -p "$SCRIPTS_DIR"
# Copy the canonical postinstall from the source tree so it stays
# in version control.
cp "$HERE/scripts/postinstall" "$SCRIPTS_DIR/postinstall"
chmod +x "$SCRIPTS_DIR/postinstall"

# ── 6. Build the component .pkg ──────────────────────────────────

COMPONENT_PKG="$STAGE_DIR/component.pkg"
echo "[pkg] running pkgbuild..."
pkgbuild \
  --root "$STAGE_DIR/payload" \
  --identifier "$PKG_ID" \
  --version "$VERSION" \
  --scripts "$SCRIPTS_DIR" \
  --install-location "/" \
  "$COMPONENT_PKG"

# ── 7. Wrap in a distribution package (gives the GUI installer) ─

DIST_XML="$STAGE_DIR/distribution.xml"
sed "s/{{VERSION}}/$VERSION/g" "$HERE/distribution.template.xml" > "$DIST_XML"

UNSIGNED_PKG="$STAGE_DIR/Workbooks-$VERSION-unsigned.pkg"
echo "[pkg] running productbuild..."
productbuild \
  --distribution "$DIST_XML" \
  --package-path "$STAGE_DIR" \
  "$UNSIGNED_PKG"

# ── 8. Sign + notarize + staple the final pkg ────────────────────

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
  echo "[pkg] notarizing pkg (typically 30s–3m)..."
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
