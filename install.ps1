# omp-pulse installer for Windows (PowerShell 5.1 compatible).
#
# Downloads the release binary for this machine's architecture, verifies its
# SHA256 against the release's SHA256SUMS file, and installs it to
# %LOCALAPPDATA%\Programs\omp-pulse.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   $env:OMP_PULSE_VERSION = "0.1.0"; .\install.ps1   # pin a version
$ErrorActionPreference = "Stop"

# TLS 1.2: PowerShell 5.1 on older Windows defaults to TLS 1.0, which GitHub
# rejects. Must be set before any web call.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# --- resolve the version (override with OMP_PULSE_VERSION) --------------------
$Version = $env:OMP_PULSE_VERSION
if (-not $Version) {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/JulianCodespoti/omp-pulse/releases/latest" -UseBasicParsing
    $Version = $release.tag_name.TrimStart("v")
}

# --- detect architecture ------------------------------------------------------
$Arch = $env:PROCESSOR_ARCHITECTURE
if ($Arch -ne "AMD64") {
    throw "Unsupported architecture: $Arch (omp-pulse currently publishes only x86_64 Windows builds)"
}

# Overridable so the script can be tested against a local server or an internal
# mirror; an installer nobody has run is not an installer.
$Base = if ($env:OMP_PULSE_BASE_URL) { $env:OMP_PULSE_BASE_URL } else { "https://github.com/JulianCodespoti/omp-pulse/releases/download/v$Version" }
$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\omp-pulse"
$Tmp = Join-Path $env:TEMP ("omp-pulse-install-" + [Guid]::NewGuid().ToString("N"))

New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
try {
    # Read SHA256SUMS FIRST: it is the release's manifest, and an older release
    # may not carry this platform.
    # Saved to a file because release assets are served as
    # application/octet-stream, for which Windows PowerShell 5.1 returns
    # .Content as a byte array rather than text.
    $SumsFile = Join-Path $Tmp "SHA256SUMS"
    Invoke-WebRequest -Uri "$Base/SHA256SUMS" -OutFile $SumsFile -UseBasicParsing
    $Sums = Get-Content -Path $SumsFile -Raw
    $Asset = "omp-pulse-$Version-x86_64-pc-windows-msvc.zip"
    $Escaped = [regex]::Escape($Asset)
    $Expected = $null
    foreach ($Line in ($Sums -split "`r?`n")) {
        if ($Line -match "^([0-9a-f]{64})\s+\*?$Escaped\s*$") {
            $Expected = $Matches[1]
            break
        }
    }
    if (-not $Expected) {
        throw "Release v$Version has no Windows x86_64 binary. Build from source: https://github.com/JulianCodespoti/omp-pulse#build-from-source"
    }

    Write-Host "Downloading $Asset"
    $Zip = Join-Path $Tmp $Asset
    Invoke-WebRequest -Uri "$Base/$Asset" -OutFile $Zip -UseBasicParsing

    Write-Host "Verifying SHA256"
    $Actual = (Get-FileHash -Algorithm SHA256 -Path $Zip).Hash.ToLower()
    if ($Actual -ne $Expected) { throw "SHA256 mismatch: expected $Expected, got $Actual" }

    Write-Host "Installing to $InstallDir"
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Expand-Archive -Path $Zip -DestinationPath $Tmp -Force
    Copy-Item -Path (Join-Path $Tmp "omp-pulse.exe") -Destination $InstallDir -Force
}
finally {
    Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}

Write-Host "Installed $InstallDir\omp-pulse.exe"
$OnPath = $env:Path -split ";" | Where-Object { $_ -and $_.TrimEnd("\") -eq $InstallDir }
if (-not $OnPath) {
    Write-Host ""
    # Do not use setx: it expands/truncates PATH and %PATH% is cmd.exe syntax.
    $QuotedDir = $InstallDir.Replace("'", "''")
    Write-Host "For this PowerShell session:"
    Write-Host ("  `$env:Path += ';' + '" + $QuotedDir + "'")
    Write-Host "For future sessions, add the installation directory to your user Path in Windows Environment Variables."
}
Write-Host ""
Write-Host "next step: run  omp-pulse setup  then  omp-pulse service install  (or omp-pulse serve)."
