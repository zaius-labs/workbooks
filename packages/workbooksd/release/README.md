# Cutting a workbooksd release

Two ways to release. Pick one.

## Path A: local Mac (signed by your Apple Developer ID)

This is the recommended path while the project is small. Your cert
stays on your Mac; nothing leaves the machine except the signed +
notarized binary.

**One-time setup** (~5 min, mostly in your browser):

```sh
cd packages/workbooksd/release
./setup.sh
```

The script tells you what to grab from Apple (Developer ID cert in
Keychain, `.p8` API key from App Store Connect, two short IDs from
that page). It writes `~/.workbooks/notary.env` (chmod 600) so future
releases don't prompt.

**Per release:**

```sh
./release.sh 0.0.1
```

What happens:
- Builds `aarch64-apple-darwin` + `x86_64-apple-darwin`
- Signs each with your Developer ID, hardened runtime, RFC3161 timestamp
- Submits to `xcrun notarytool` and waits for Apple's verdict
- Drops signed binaries into `site/src/dl/`
- Updates `sha256.txt` manifest
- Commits + pushes (Pages auto-deploys via the path-filter workflow)
- Tags `release-workbooksd-v<version>`
- Creates a GitHub Release with the binaries attached (if `gh` CLI is installed)

The tag is prefixed `release-` deliberately — the CI release workflow
(`.github/workflows/workbooksd-release.yml`) only triggers on
`workbooksd-v*`, so it won't double-build.

## Path B: CI-driven (signing in GitHub Actions)

Use this once Linux + Windows builds matter, since CI matrix builds
all platforms in parallel.

```sh
git tag workbooksd-v0.0.1
git push origin workbooksd-v0.0.1
```

The workflow at `.github/workflows/workbooksd-release.yml`:
- Runs the matrix (macos-14, macos-13, ubuntu-latest, windows-latest)
- Signs each platform's binary if the corresponding secret group is set
- On Windows, also packages the signed `workbooksd.exe` into
  `Workbooks.msi` via `cargo-wix`, then signs the MSI itself with
  Trusted Signing
- Ships `Workbooks.msi` + `install.ps1` + the bare `.exe` to
  `site/src/dl/` alongside the macOS / Linux assets
- Otherwise builds unsigned and emits a workflow warning

**Required CI secrets** (none of these are needed for Path A):

| Group | Variable | Note |
|---|---|---|
| Apple | `APPLE_DEV_ID_CERT_P12` | base64 of the .p12 export |
| Apple | `APPLE_DEV_ID_CERT_PASSWORD` | password for the .p12 |
| Apple | `APPLE_DEV_ID_NAME` | `Developer ID Application: ...` identity |
| Apple | `APPLE_NOTARY_API_KEY` | base64 of the App Store Connect .p8 |
| Apple | `APPLE_NOTARY_API_KEY_ID` | 10-char Key ID |
| Apple | `APPLE_NOTARY_API_ISSUER` | Issuer UUID |
| Windows | `AZURE_CLIENT_ID` | service principal app id |
| Windows | `AZURE_TENANT_ID` | tenant id |
| Windows | `AZURE_CLIENT_SECRET` | service principal secret |
| Windows | `TRUSTED_SIGNING_ENDPOINT` | e.g. `https://eus.codesigning.azure.net/` |
| Windows | `TRUSTED_SIGNING_ACCOUNT` | account name |
| Windows | `TRUSTED_SIGNING_PROFILE` | certificate profile name |

The Apple group is the same data Path A uses, just base64-encoded for
GitHub Secrets storage. Microsoft Trusted Signing (~$10/mo) is the
cheapest CI-friendly Windows signing path.

## What gets signed vs. checksummed

Even unsigned releases get SHA-256 verification: `install.sh` fetches
`/dl/sha256.txt` and refuses any binary whose hash doesn't match the
manifest. That's a real integrity check, independent of code signing.

Signing adds:
- macOS: Gatekeeper passes silently for downloaded binaries
- Windows: SmartScreen passes silently (Microsoft Trusted Signing has instant reputation)
- Linux: GPG-signed `.asc` files for binary verification (not yet wired)
