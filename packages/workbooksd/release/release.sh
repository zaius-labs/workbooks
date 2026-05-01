#!/usr/bin/env bash
# Cut a workbooksd release entirely from this Mac:
#
#   1. Build aarch64 + x86_64 macOS targets
#   2. codesign with your Developer ID
#   3. Submit to xcrun notarytool and wait
#   4. Drop binaries into site/src/dl/
#   5. Generate sha256.txt manifest
#   6. Commit + push (triggers Pages auto-deploy via path filter)
#   7. Tag and create a GitHub Release with the binaries attached
#
# Linux + Windows binaries are produced via the GitHub Actions release
# workflow on tag (.github/workflows/workbooksd-release.yml). This
# script handles only the macOS side, which is what the local Mac can
# sign. Run on a Mac with Xcode CLI tools + Rust + the Apple credentials
# from setup.sh.
#
# Usage:
#   ./release.sh 0.0.1
#
# This will:
#   - tag `release-workbooksd-v0.0.1` (the `release-` prefix is
#     intentional: the GH Actions release workflow only triggers on
#     `workbooksd-v*` tags, so it won't double-build)

set -euo pipefail

VERSION="${1:?usage: $0 <version> (e.g. 0.0.1)}"
TAG="release-workbooksd-v$VERSION"

HERE=$(cd "$(dirname "$0")" && pwd)
RUNTIME_DIR=$(cd "$HERE/.." && pwd)
REPO_ROOT=$(cd "$RUNTIME_DIR/../.." && pwd)
SITE_DIR="$REPO_ROOT/site"
DL_DIR="$SITE_DIR/src/dl"
ENV_FILE="$HOME/.workbooks/notary.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE — run setup.sh first" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"
: "${APPLE_DEV_ID_NAME:?not set in $ENV_FILE}"
: "${APPLE_NOTARY_KEY_PATH:?not set in $ENV_FILE}"
: "${APPLE_NOTARY_KEY_ID:?not set in $ENV_FILE}"
: "${APPLE_NOTARY_ISSUER:?not set in $ENV_FILE}"
[ -f "$APPLE_NOTARY_KEY_PATH" ] || { echo "missing $APPLE_NOTARY_KEY_PATH"; exit 1; }

# Verify the cert is still in keychain (rotated certs cause confusing errors later).
if ! security find-identity -p codesigning -v | grep -qF "$APPLE_DEV_ID_NAME"; then
  echo "Developer ID identity not found in keychain: $APPLE_DEV_ID_NAME"
  echo "Available identities:"
  security find-identity -p codesigning -v
  exit 1
fi

# Release-scoped paths must be clean. Other WIP in the monorepo
# (other apps, showcases, etc.) is left alone — only the directories
# this script reads from / writes to need to be tidy.
RELEASE_PATHS=(
  packages/workbooksd
  site
)
if ! git -C "$REPO_ROOT" diff-index --quiet HEAD -- "${RELEASE_PATHS[@]}"; then
  echo "Uncommitted changes in release-scoped paths. Commit or stash, then re-run."
  git -C "$REPO_ROOT" status --short -- "${RELEASE_PATHS[@]}"
  exit 1
fi

TARGETS=(aarch64-apple-darwin x86_64-apple-darwin)
echo "[release] ensuring rust targets installed..."
for t in "${TARGETS[@]}"; do
  rustup target add "$t" >/dev/null 2>&1 || true
done

mkdir -p "$DL_DIR"

for target in "${TARGETS[@]}"; do
  echo
  echo "================================================================"
  echo "[release] $target"
  echo "================================================================"

  ( cd "$RUNTIME_DIR" && cargo build --release --target "$target" )
  bin="$RUNTIME_DIR/target/$target/release/workbooksd"
  strip "$bin" || true

  echo "[release] codesigning..."
  codesign --sign "$APPLE_DEV_ID_NAME" \
           --options runtime \
           --timestamp \
           --force \
           "$bin"
  codesign --verify --strict --verbose=2 "$bin"

  echo "[release] notarizing (typically 30s–3m)..."
  zip="/tmp/workbooksd-$target-$$.zip"
  ditto -c -k --keepParent "$bin" "$zip"
  xcrun notarytool submit "$zip" \
    --key "$APPLE_NOTARY_KEY_PATH" \
    --key-id "$APPLE_NOTARY_KEY_ID" \
    --issuer "$APPLE_NOTARY_ISSUER" \
    --wait
  rm -f "$zip"
  # Bare Mach-O can't be stapled (stapler only works on .app/.dmg/.pkg).
  # Notarization is checked online by Gatekeeper at first launch.

  cp "$bin" "$DL_DIR/workbooksd-$target"
  chmod +x "$DL_DIR/workbooksd-$target"
  echo "[release] → $DL_DIR/workbooksd-$target ($(wc -c < "$DL_DIR/workbooksd-$target") bytes)"
done

echo
echo "[release] generating sha256.txt..."
( cd "$DL_DIR" && shasum -a 256 workbooksd-* | sort > sha256.txt )
cat "$DL_DIR/sha256.txt"

echo
echo "[release] committing..."
cd "$REPO_ROOT"
git add "$SITE_DIR/src/dl/"
if git diff --cached --quiet; then
  echo "  (no binary changes to commit)"
else
  git commit -m "release: workbooksd $VERSION (macOS arm64+x86_64, signed + notarized)"
  git push origin HEAD:main
fi

echo "[release] tagging $TAG..."
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "  (tag already exists, skipping)"
else
  git tag -a "$TAG" -m "workbooksd $VERSION (locally signed + notarized)"
  git push origin "$TAG"
fi

if command -v gh >/dev/null 2>&1; then
  echo "[release] creating GitHub Release..."
  if gh release view "$TAG" >/dev/null 2>&1; then
    echo "  (release exists; uploading any new files)"
    gh release upload "$TAG" "$DL_DIR"/workbooksd-* "$DL_DIR/sha256.txt" --clobber
  else
    gh release create "$TAG" \
      --title "workbooksd $VERSION" \
      --notes "Locally signed + notarized macOS binaries (Apple Developer ID).

SHA-256 manifest: \`/dl/sha256.txt\` on workbooks.sh.

Linux + Windows binaries: cut a \`workbooksd-v$VERSION\` tag (no \`release-\` prefix) to trigger CI builds via .github/workflows/workbooksd-release.yml." \
      "$DL_DIR"/workbooksd-* "$DL_DIR/sha256.txt"
  fi
else
  echo "[release] gh CLI not installed; skipping GitHub Release creation"
  echo "  brew install gh   # to enable"
fi

echo
echo "[release] done."
echo "  Live: https://workbooks.sh/dl/"
echo "  Tag : $TAG"
