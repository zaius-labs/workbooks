> **Note:** Some sections below describe the original polyglot APE-binary
> runner (`packages/workbook-runner`), which has been replaced by
> `packages/workbooksd` — a small Rust background daemon that serves
> workbooks over localhost. The substrate transport contract still
> applies; only the host process changed. See packages/workbooksd/
> for the current implementation.

# Code Signing for Workbook Polyglot Binaries

**TL;DR:** if you're shipping the `.html` output, you never need certs. If you're shipping the polyglot binaries (`<name>-mac.zip`, `<name>-win.exe`, `<name>-linux`) to public users, signing eliminates the first-launch Gatekeeper / SmartScreen warning. Without signing, users see the warning once per file, then it works silently forever. Many authors ship unsigned and that's a fine choice.

## Decision tree

| Scenario | Need signing? | What happens without |
|---|---|---|
| Hobby / internal / friends | **No.** | Users right-click → Open on Mac, "Run anyway" on Windows. Once. |
| Public release at scale | **Yes** if you want zero-warning UX. | Same one-time warning, but for many strangers you might not want them to see it. |
| HTML-only output (`workbook build --no-polyglot`) | **No, ever.** | HTML files don't have a signing concept. |
| Linux-only audience | **No.** | Linux trusts the executable bit; no platform signing ritual. |
| iOS / Android | N/A | Mobile doesn't run the polyglot binary at all. Use `--also-html` for mobile users. |

## Costs

- **Apple Developer Program** — $99/yr per individual or org. Provides Developer ID Application certificate (signs binaries shipped outside the App Store) plus Apple notarization (free, mandatory for macOS Catalina+ trust).
- **Windows code signing certificate** — $200-500/yr from a CA (Sectigo, DigiCert, etc.). EV (Extended Validation) tier eliminates SmartScreen warnings instantly; OV (Organization Validated) builds reputation over weeks. Consider Microsoft's Trusted Signing service (~$10/mo) for an alternative without managing cert files yourself.
- **Linux** — free. No platform signing.

Total annual: ~$300-500 if you sign both Mac + Windows. Skippable for most authors.

## How to sign with the workbook CLI

The build pipeline detects environment variables and signs automatically when present. Set them in your CI (GitHub Actions, etc.) or your local environment.

### macOS

Required env vars:

```sh
export APPLE_DEVELOPER_ID="Developer ID Application: Your Name (TEAMID)"
export APPLE_TEAM_ID="TEAMID"
```

Find your `Developer ID Application` identity:

```sh
security find-identity -v -p codesigning
# →  1) ABC123... "Developer ID Application: Your Name (TEAMID)"
```

The identity string in quotes is what `APPLE_DEVELOPER_ID` should be set to.

When `workbook build` runs with these set, the resulting `<name>.app` (inside `<name>-mac.zip`) is signed with `codesign --force --sign "$APPLE_DEVELOPER_ID" --deep --options runtime`. For full notarization (eliminates Gatekeeper warning entirely), see [Notarization](#notarization-mac) below.

### Windows

Required env vars:

```sh
export WIN_CODESIGN_CERT_PATH=/path/to/your.pfx
export WIN_CODESIGN_CERT_PASS="cert-passphrase"
```

The build pipeline uses [`osslsigncode`](https://github.com/mtrojnar/osslsigncode) (cross-platform tool — install via `brew install osslsigncode` on Mac CI, `apt install osslsigncode` on Linux CI) to sign with your `.pfx`. Result: `<name>-win.exe` is signed with SHA-256.

Microsoft Trusted Signing (Azure-managed signing) is an alternative — no cert file to manage. Integration is on the roadmap (see Workbook Studio / `core-ksn`).

### Linux

No signing. The build pipeline produces `<name>-linux` ready to `chmod +x` and run.

## Notarization (Mac)

After signing on macOS, Apple's notarization service must scan the binary before Gatekeeper trusts it without warning. Two requirements:

1. App Store Connect API key (free, generated in App Store Connect dashboard)
2. The signed binary submitted to `xcrun notarytool`

Manual flow:

```sh
xcrun notarytool submit dist/colorwave-mac.zip \
  --key /path/to/AuthKey.p8 \
  --key-id YOUR_KEY_ID \
  --issuer YOUR_ISSUER_ID \
  --wait

xcrun stapler staple dist/colorwave.app
```

Automating this in the workbook CLI is on the roadmap. Until then, run manually after `workbook build`.

## CI / GitHub Actions example

```yaml
# .github/workflows/release.yml (sketch)
name: Release
on:
  release:
    types: [published]
jobs:
  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
        with: { submodules: recursive }
      - run: |
          mkdir -p vendor/cosmocc
          curl -sSL -o /tmp/cosmocc.zip https://cosmo.zip/pub/cosmocc/cosmocc.zip
          unzip -q /tmp/cosmocc.zip -d vendor/cosmocc
      - run: bun install
      - run: bun run build
        env:
          APPLE_DEVELOPER_ID: ${{ secrets.APPLE_DEVELOPER_ID }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          WIN_CODESIGN_CERT_PATH: ${{ secrets.WIN_CODESIGN_CERT_PATH }}
          WIN_CODESIGN_CERT_PASS: ${{ secrets.WIN_CODESIGN_CERT_PASS }}
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            apps/colorwave/dist/colorwave-mac.zip
            apps/colorwave/dist/colorwave-win.exe
            apps/colorwave/dist/colorwave-linux
            apps/colorwave/dist/colorwave.html
```

## Without signing — what users see

**macOS:**
> "colorwave.app" cannot be opened because Apple cannot check it for malicious software.
>
> [OK] [Cancel]

User: right-click `colorwave.app` → Open → confirm dialog → app runs. Subsequent launches: silent.

**Windows:**
> Windows protected your PC
>
> Microsoft Defender SmartScreen prevented an unrecognized app from starting.
>
> [Don't run] [More info]

User: click "More info" → "Run anyway." Subsequent launches: silent until the binary changes (each new build resets the trust state until SmartScreen reputation accrues).

**Linux:**
> No warning. Just `chmod +x colorwave-linux && ./colorwave-linux`.

## Workbook Studio (future)

The [Workbook Studio epic](`bd show core-ksn`) tracks an optional desktop app that manages signing certs for authors. Once shipped, authors install Studio once, sign in to their Apple Developer / Microsoft accounts via Studio, and every workbook they build on that machine auto-signs without env-var management. End users never need Studio — it's purely an authoring convenience.

## Open-source forks

This signing setup is for `workbooks.sh`'s own first-party releases. Anyone forking the toolchain to publish their own workbooks brings their own certs (or skips signing). The Workbooks CLI never embeds or shares signing keys — keys live in your CI secrets / your local env, never committed.
