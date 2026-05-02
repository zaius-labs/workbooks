#!/usr/bin/env bash
# Workbooks release signing — one-time credential setup.
#
# Stores your Apple notarization credentials at ~/.workbooks/ so the
# release script can sign and notarize without prompts. Run once per
# Mac. Re-running is safe (overwrites in place).

set -euo pipefail

CRED_DIR="$HOME/.workbooks"
mkdir -p "$CRED_DIR"
chmod 700 "$CRED_DIR"

cat <<'PRELUDE'
================================================================
Workbooks release signing — one-time setup
================================================================

You'll need three things from Apple. The first is hopefully already
done; the other two take ~5 minutes in two browser tabs.

  1. Developer ID Application certificate, installed in Keychain.
     Verify: open Keychain Access → My Certificates → look for
     "Developer ID Application: <Your Name> (<TEAM ID>)".

     If missing: https://developer.apple.com/account/resources/certificates
     → Generate a "Developer ID Application" cert, download, double-click
     to install into Keychain.

  1b. Developer ID INSTALLER certificate (for signing the .pkg installer).
      Same Apple developer account, but a SEPARATE cert from the
      Application one. Bare shell scripts can't carry stapleable
      Gatekeeper tickets, so the only Gatekeeper-friendly double-
      clickable installer is a .pkg — and pkgs are signed with the
      Installer cert, not the Application cert.

      Verify:
        security find-identity -p basic -v | grep "Developer ID Installer"

      Generate at the same URL — pick "Developer ID Installer" this
      time. Double-click the .cer to install. (No env-file entry
      needed: the build script derives the Installer name from the
      Application name by swapping "Application" → "Installer".)

  2. App Store Connect API key (one-time):
     - Open https://appstoreconnect.apple.com
     - Users and Access → Integrations → Team Keys
     - Click "+" → name it "workbooksd notarization"
     - Access: "Developer" (sufficient for notarytool)
     - Click "Generate"
     - DOWNLOAD the .p8 immediately (Apple won't show it again)

  3. Two values from that same page:
     - Key ID (10 characters, e.g. "ABCD1234EF")
     - Issuer ID (UUID format, shown at the top of the Keys page)

================================================================
PRELUDE

read -rp "Press Enter once you have the .p8, Key ID, and Issuer ID handy... "

# 1. Developer ID identity
echo
echo "Available code-signing identities:"
security find-identity -p codesigning -v | grep "Developer ID Application" || {
  echo "  (none found — install your Developer ID Application cert and re-run)"
  exit 1
}
echo
echo "Paste the FULL identity string from above"
echo "  (looks like: \"Developer ID Application: Your Name (TEAMID)\")"
read -rp "  identity: " DEV_ID
[ -n "$DEV_ID" ] || { echo "empty identity, aborting"; exit 1; }

# 2. .p8 file
echo
read -rp "Path to your downloaded .p8 file: " P8_PATH
P8_PATH="${P8_PATH/#\~/$HOME}"
[ -f "$P8_PATH" ] || { echo "file not found: $P8_PATH"; exit 1; }
cp "$P8_PATH" "$CRED_DIR/notary.p8"
chmod 600 "$CRED_DIR/notary.p8"
echo "  → $CRED_DIR/notary.p8"

# 3. IDs
echo
read -rp "Key ID (10 chars, e.g. ABCD1234EF): " KEY_ID
read -rp "Issuer ID (UUID): " ISSUER
[ -n "$KEY_ID" ] && [ -n "$ISSUER" ] || { echo "both required"; exit 1; }

# Persist
cat > "$CRED_DIR/notary.env" <<ENV
# Workbooks release signing credentials.
# Loaded by apps/workbooks-runtime/release/release.sh
APPLE_DEV_ID_NAME="$DEV_ID"
APPLE_NOTARY_KEY_PATH="$CRED_DIR/notary.p8"
APPLE_NOTARY_KEY_ID="$KEY_ID"
APPLE_NOTARY_ISSUER="$ISSUER"
ENV
chmod 600 "$CRED_DIR/notary.env"

cat <<EOF

Setup complete.
  Credentials: $CRED_DIR/notary.env  (chmod 600, gitignored by living in \$HOME)
  Notary key : $CRED_DIR/notary.p8

Cut a release with:
  cd apps/workbooks-runtime/release
  ./release.sh 0.0.1
EOF
