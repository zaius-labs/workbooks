# workbooks.sh — installer for the workbooksd background daemon (Windows).
#
# Usage:
#   iwr -useb https://workbooks.sh/install.ps1 | iex
#
# What this does:
#   1. Downloads the workbooksd.exe binary for your architecture →
#      $env:LocalAppData\Programs\workbooksd\workbooksd.exe
#   2. Verifies SHA-256 against $WORKBOOKS_DOMAIN/dl/sha256.txt — refuses
#      install on mismatch (corrupted / MITM'd / unrecognized binary).
#   3. Registers a Run-at-login entry (HKCU\...\Run) so the daemon
#      starts when the user signs in.
#   4. Registers `.workbook.html` as a file association handled by
#      `workbooksd.exe open <path>` — double-click any workbook to open
#      it via the daemon-served URL.
#   5. Adds the install dir to the user's PATH.
#
# Override knobs (env):
#   WORKBOOKS_DOMAIN       default: workbooks.sh
#   WORKBOOKS_BIN_DIR      default: $env:LocalAppData\Programs\workbooksd
#   WORKBOOKS_VERSION      default: latest
#   WORKBOOKS_NO_DAEMON    set to skip Run-at-login registration
#   WORKBOOKS_NO_FILEASSOC set to skip the .workbook.html file association
#   WORKBOOKS_DRY_RUN      set to print what would happen without writing

#Requires -Version 5.1

$ErrorActionPreference = 'Stop'

# ── config ─────────────────────────────────────────────────────────

$Domain   = if ($env:WORKBOOKS_DOMAIN) { $env:WORKBOOKS_DOMAIN } else { 'workbooks.sh' }
$BinDir   = if ($env:WORKBOOKS_BIN_DIR) { $env:WORKBOOKS_BIN_DIR } else { Join-Path $env:LocalAppData 'Programs\workbooksd' }
$BinPath  = Join-Path $BinDir 'workbooksd.exe'
$Version  = if ($env:WORKBOOKS_VERSION) { $env:WORKBOOKS_VERSION } else { 'latest' }
$DryRun   = ($env:WORKBOOKS_DRY_RUN -eq '1')

function Say { param($m) Write-Host "[install] $m" }
function Die { param($m) Write-Host "[install] error: $m" -ForegroundColor Red; exit 1 }
function Run {
  param([scriptblock]$Block, [string]$Description)
  if ($DryRun) { Say "[dry-run] $Description"; return }
  & $Block
}

# ── architecture detection ─────────────────────────────────────────

function Detect-Target {
  $arch = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE')
  switch ($arch) {
    'AMD64' { return 'x86_64-pc-windows-msvc' }
    'ARM64' { return 'aarch64-pc-windows-msvc' }
    default { Die "unsupported Windows arch: $arch" }
  }
}

# ── binary download + verify ───────────────────────────────────────

function Get-FromUrl {
  param([string]$Url, [string]$Out)
  Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing -ErrorAction Stop
}

function Verify-Checksum {
  param([string]$BinaryPath, [string]$ExpectedName)
  $manifestUrl = "https://$Domain/dl/sha256.txt"
  $manifestPath = "$BinaryPath.sha256.manifest"
  try {
    Get-FromUrl $manifestUrl $manifestPath
  } catch {
    Say "warning: could not fetch sha256 manifest; skipping verification"
    return
  }

  $expected = $null
  Get-Content $manifestPath | ForEach-Object {
    $parts = $_ -split '\s+', 2
    if ($parts.Length -eq 2 -and $parts[1].Trim() -eq $ExpectedName) {
      $expected = $parts[0]
    }
  }
  Remove-Item $manifestPath -ErrorAction SilentlyContinue

  if (-not $expected) {
    Die "no checksum entry for $ExpectedName in /dl/sha256.txt — refusing to install"
  }

  $actual = (Get-FileHash -Path $BinaryPath -Algorithm SHA256).Hash.ToLower()
  if ($expected.ToLower() -ne $actual) {
    Remove-Item $BinaryPath -ErrorAction SilentlyContinue
    Die "checksum mismatch for $ExpectedName (expected $expected, got $actual)"
  }
  Say "checksum ok ($expected)"
}

function Download-Binary {
  param([string]$Target)
  $asset = "workbooksd-$Target.exe"
  $url = "https://$Domain/dl/$asset"
  Say "downloading $url"

  if (-not $DryRun) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    $tmp = "$BinPath.tmp.$PID"
    try {
      Get-FromUrl $url $tmp
    } catch {
      Die "download failed: $url ($($_.Exception.Message))"
    }
    Verify-Checksum $tmp $asset
    # Replace atomically (close any running daemon first if upgrading).
    if (Test-Path $BinPath) { Stop-RunningDaemon }
    Move-Item -Force -Path $tmp -Destination $BinPath
    Say "binary → $BinPath"
  } else {
    Say "[dry-run] would download $url → $BinPath"
  }
}

function Stop-RunningDaemon {
  Get-Process -Name 'workbooksd' -ErrorAction SilentlyContinue | ForEach-Object {
    Say "stopping running workbooksd (pid $($_.Id))"
    try { $_ | Stop-Process -Force -ErrorAction Stop } catch { }
  }
}

# ── PATH ───────────────────────────────────────────────────────────

function Add-ToUserPath {
  param([string]$Dir)
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($current -and ($current -split ';' | Where-Object { $_ -ieq $Dir })) {
    Say "$Dir already on user PATH"
    return
  }
  $new = if ($current) { "$current;$Dir" } else { $Dir }
  Run { [Environment]::SetEnvironmentVariable('Path', $new, 'User') } "set HKCU PATH += $Dir"
  Say "added $Dir to user PATH (open a new terminal to pick it up)"
}

# ── auto-start at login ────────────────────────────────────────────

function Register-RunAtLogin {
  if ($env:WORKBOOKS_NO_DAEMON -eq '1') { Say "skipping Run-at-login (WORKBOOKS_NO_DAEMON)"; return }
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $name = 'Workbooksd'
  # Quote the path so spaces in $env:LocalAppData (rare but possible) don't break parsing.
  $cmd = "`"$BinPath`""
  Run {
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -Path $key -Name $name -Value $cmd -PropertyType String -Force | Out-Null
  } "HKCU\...\Run += $name"
  Say "Run-at-login registered → $key\$name"
}

# ── .workbook.html file association ────────────────────────────────

function Register-FileAssociation {
  if ($env:WORKBOOKS_NO_FILEASSOC -eq '1') { Say "skipping file association (WORKBOOKS_NO_FILEASSOC)"; return }

  # Per-user file association, no admin required:
  #   HKCU\Software\Classes\.workbook.html → ProgID
  #   HKCU\Software\Classes\<ProgID>\shell\open\command → "$BinPath" open "%1"
  $progId = 'Workbooks.Document.1'
  $cmd = "`"$BinPath`" open `"%1`""

  Run {
    $progPath = "HKCU:\Software\Classes\$progId"
    New-Item -Path "$progPath\shell\open\command" -Force | Out-Null
    Set-ItemProperty -Path $progPath -Name '(default)' -Value 'Workbook'
    Set-ItemProperty -Path "$progPath\shell\open\command" -Name '(default)' -Value $cmd

    $extPath = 'HKCU:\Software\Classes\.workbook.html'
    New-Item -Path $extPath -Force | Out-Null
    Set-ItemProperty -Path $extPath -Name '(default)' -Value $progId

    # Tell Explorer to refresh its file-association cache so the new
    # entry is picked up without a logout. SHCNE_ASSOCCHANGED = 0x08000000.
    Add-Type -Namespace Win32 -Name Shell -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("shell32.dll")]
public static extern void SHChangeNotify(int wEventId, int uFlags, System.IntPtr dwItem1, System.IntPtr dwItem2);
"@ -ErrorAction SilentlyContinue
    [Win32.Shell]::SHChangeNotify(0x08000000, 0, [System.IntPtr]::Zero, [System.IntPtr]::Zero)
  } "register .workbook.html → $progId"

  Say "file association → .workbook.html opens via $BinPath"
  Say "note: if double-click still opens in your browser, right-click a"
  Say "      .workbook.html → Open with → Choose another app → Workbooks → Always."
}

# ── main ───────────────────────────────────────────────────────────

function Main {
  $target = Detect-Target
  Say "target: $target"
  Download-Binary $target
  Add-ToUserPath $BinDir
  Register-RunAtLogin
  Register-FileAssociation

  Say ""
  Say "done."
  Say "Start the daemon now:"
  Say "  & '$BinPath'"
  Say ""
  Say "Then open any .workbook.html — Cmd+S / Ctrl+S will save in place."
}

Main
