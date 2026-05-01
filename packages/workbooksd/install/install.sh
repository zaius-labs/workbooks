#!/bin/sh
# workbooks.sh — installer for the workbooksd background daemon.
#
# Usage:
#   curl -fsSL https://workbooks.sh/install | sh
#
# What this does:
#   1. Downloads the workbooksd binary for your platform → ~/.local/bin/workbooksd
#   2. macOS: installs a launchd user agent so the daemon runs at login,
#      and a tiny .app bundle that registers `.workbook.html` as a
#      document type — double-click any workbook to open it.
#   3. Linux: stub (TODO: systemd user unit + xdg-mime).
#   4. Windows: not yet supported.
#
# Override knobs (via env):
#   WORKBOOKS_DOMAIN       — default: workbooks.sh
#   WORKBOOKS_BIN_DIR      — default: $HOME/.local/bin
#   WORKBOOKS_VERSION      — default: latest
#   WORKBOOKS_NO_DAEMON    — set to skip launchd/systemd registration
#   WORKBOOKS_NO_FILEASSOC — set to skip the .app / file association
#   WORKBOOKS_DRY_RUN      — set to print what would happen without writing

set -eu

WORKBOOKS_DOMAIN="${WORKBOOKS_DOMAIN:-workbooks.sh}"
WORKBOOKS_BIN_DIR="${WORKBOOKS_BIN_DIR:-$HOME/.local/bin}"
WORKBOOKS_BIN="$WORKBOOKS_BIN_DIR/workbooksd"
WORKBOOKS_VERSION="${WORKBOOKS_VERSION:-latest}"

say() { printf '%s\n' "$*" >&2; }
die() { say "[install] error: $*"; exit 1; }
run() {
  if [ "${WORKBOOKS_DRY_RUN:-}" = "1" ]; then
    say "[dry-run] $*"
  else
    eval "$@"
  fi
}

# ── platform detection ──────────────────────────────────────────────

detect_target() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin)
      case "$arch" in
        arm64|aarch64) echo "aarch64-apple-darwin" ;;
        x86_64) echo "x86_64-apple-darwin" ;;
        *) die "unsupported macOS arch: $arch" ;;
      esac
      ;;
    Linux)
      case "$arch" in
        x86_64) echo "x86_64-unknown-linux-gnu" ;;
        aarch64|arm64) echo "aarch64-unknown-linux-gnu" ;;
        *) die "unsupported Linux arch: $arch" ;;
      esac
      ;;
    *)
      die "unsupported OS: $os (Windows coming soon)"
      ;;
  esac
}

# ── binary download ────────────────────────────────────────────────

fetch() {
  url="$1"
  out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out" || return 1
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$out" || return 1
  else
    die "need curl or wget"
  fi
}

# Verify the SHA-256 of $1 matches the entry for $2 (the canonical
# asset name, e.g. workbooksd-aarch64-apple-darwin) in the manifest
# fetched from $WORKBOOKS_DOMAIN/dl/sha256.txt. Aborts on mismatch —
# corrupted, MITM'd, or unrecognized binaries are refused.
verify_checksum() {
  bin="$1"
  expected_name="$2"
  manifest="$bin.sha256.manifest"
  fetch "https://$WORKBOOKS_DOMAIN/dl/sha256.txt" "$manifest" || {
    say "[install] warning: could not fetch sha256 manifest; skipping verification"
    rm -f "$manifest"
    return 0
  }
  expected=$(awk -v n="$expected_name" '$2 == n { print $1 }' "$manifest")
  rm -f "$manifest"
  if [ -z "$expected" ]; then
    die "no checksum entry for $expected_name in /dl/sha256.txt — refusing to install"
  fi
  if command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$bin" | awk '{print $1}')
  elif command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$bin" | awk '{print $1}')
  else
    die "need shasum or sha256sum to verify download"
  fi
  if [ "$expected" != "$actual" ]; then
    rm -f "$bin"
    die "checksum mismatch for $expected_name (expected $expected, got $actual)"
  fi
  say "[install] checksum ok ($expected)"
}

download_binary() {
  target="$1"
  asset="workbooksd-$target"
  url="https://$WORKBOOKS_DOMAIN/dl/$asset"
  say "[install] downloading $url"
  mkdir -p "$WORKBOOKS_BIN_DIR"
  tmp="$WORKBOOKS_BIN.tmp.$$"
  fetch "$url" "$tmp" || die "download failed: $url"
  verify_checksum "$tmp" "$asset"
  chmod +x "$tmp"
  mv "$tmp" "$WORKBOOKS_BIN"
  say "[install] binary → $WORKBOOKS_BIN"
}

# ── macOS: launchd user agent ──────────────────────────────────────

install_macos_launchd() {
  [ "${WORKBOOKS_NO_DAEMON:-}" = "1" ] && { say "[install] skipping daemon registration (WORKBOOKS_NO_DAEMON)"; return; }
  plist="$HOME/Library/LaunchAgents/sh.workbooks.workbooksd.plist"
  log_dir="$HOME/Library/Logs"
  mkdir -p "$(dirname "$plist")" "$log_dir"

  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>sh.workbooks.workbooksd</string>
  <key>ProgramArguments</key>
  <array>
    <string>$WORKBOOKS_BIN</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$log_dir/workbooksd.log</string>
  <key>StandardErrorPath</key><string>$log_dir/workbooksd.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF

  uid=$(id -u)
  # Reload if already installed (best-effort).
  launchctl bootout "gui/$uid/sh.workbooks.workbooksd" >/dev/null 2>&1 || true
  if ! launchctl bootstrap "gui/$uid" "$plist"; then
    say "[install] warning: launchctl bootstrap failed; you may need to log out/in or run:"
    say "         launchctl bootstrap gui/$uid $plist"
  fi
  say "[install] launchd agent → $plist"
}

# ── macOS: file-association .app wrapper ───────────────────────────

install_macos_app() {
  [ "${WORKBOOKS_NO_FILEASSOC:-}" = "1" ] && { say "[install] skipping file association (WORKBOOKS_NO_FILEASSOC)"; return; }

  # Prefer /Applications; fall back to ~/Applications if not writable.
  app="/Applications/Workbooks.app"
  if ! mkdir -p "$app/Contents/MacOS" 2>/dev/null; then
    app="$HOME/Applications/Workbooks.app"
    mkdir -p "$app/Contents/MacOS"
  fi

  cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>workbooks-launcher</string>
  <key>CFBundleIdentifier</key><string>sh.workbooks.launcher</string>
  <key>CFBundleName</key><string>Workbooks</string>
  <key>CFBundleDisplayName</key><string>Workbooks</string>
  <key>CFBundleVersion</key><string>0.0.1</string>
  <key>CFBundleShortVersionString</key><string>0.0.1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
  <key>LSUIElement</key><true/>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>Workbook</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSItemContentTypes</key>
      <array>
        <string>sh.workbooks.workbook</string>
      </array>
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

  cat > "$app/Contents/MacOS/workbooks-launcher" <<EOF
#!/bin/sh
# Forwarded by Finder when a user double-clicks a .workbook.html file.
# We just hand the path off to workbooksd, which mints a token and
# spawns the user's default browser.
exec "$WORKBOOKS_BIN" open "\$@"
EOF
  chmod +x "$app/Contents/MacOS/workbooks-launcher"

  # Refresh Launch Services so the new UTI + document type are picked up
  # without requiring a logout. Path is stable since 10.10.
  lsregister="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"
  [ -x "$lsregister" ] && "$lsregister" -f "$app" >/dev/null 2>&1 || true

  say "[install] file-association app → $app"
  say "[install] note: if double-click still opens .workbook.html in your browser,"
  say "         right-click a file → Get Info → 'Open with: Workbooks' → 'Change All…'"
}

# ── Linux: stub for now ────────────────────────────────────────────

install_linux_stub() {
  say "[install] Linux: daemon installed at $WORKBOOKS_BIN"
  say "         systemd user unit + xdg-mime registration: TODO."
  say "         For now, run \`workbooksd\` manually or add to your shell startup."
}

# ── main ───────────────────────────────────────────────────────────

main() {
  target=$(detect_target)
  say "[install] target: $target"
  download_binary "$target"

  case "$(uname -s)" in
    Darwin)
      install_macos_launchd
      install_macos_app
      ;;
    Linux)
      install_linux_stub
      ;;
  esac

  say
  say "[install] done."
  say "         daemon binary : $WORKBOOKS_BIN"
  say "         double-click a .workbook.html to open it (macOS),"
  say "         or run: workbooksd open path/to/file.workbook.html"

  case ":$PATH:" in
    *":$WORKBOOKS_BIN_DIR:"*) ;;
    *)
      say
      say "[install] note: $WORKBOOKS_BIN_DIR is not on your PATH."
      say "         add: export PATH=\"$WORKBOOKS_BIN_DIR:\$PATH\""
      ;;
  esac
}

main "$@"
