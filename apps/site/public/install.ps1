param(
  [switch]$Cli
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$Repository = "niyuxuan782/one-status"
$ReleaseApiUrl = if ($env:ONE_STATUS_RELEASE_API_URL) {
  $env:ONE_STATUS_RELEASE_API_URL
} else {
  "https://niyuxuan782.github.io/one-status/release.json"
}
$TemporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("one-status-" + [Guid]::NewGuid().ToString("N"))

function Write-OneStatus {
  param([string]$Message)
  Write-Host "One Status: $Message"
}

function Stop-Installer {
  param([string]$Message)
  throw "One Status installer error: $Message"
}

function Get-NormalizedArchitecture {
  $Architecture = $env:PROCESSOR_ARCHITEW6432
  if ([string]::IsNullOrWhiteSpace($Architecture)) {
    $Architecture = $env:PROCESSOR_ARCHITECTURE
  }
  switch -Regex ($Architecture) {
    "^(ARM64|AARCH64)$" { return "arm64" }
    "^(AMD64|X86_64)$" { return "x64" }
    default { Stop-Installer "unsupported CPU architecture: $Architecture" }
  }
}

function Get-ReleaseAsset {
  param(
    [object]$Release,
    [string]$Name
  )
  $MatchedAssets = @($Release.assets | Where-Object { $_.name -ceq $Name })
  if ($MatchedAssets.Count -gt 1) {
    Stop-Installer "release $($Release.tag_name) contains duplicate assets named $Name."
  }
  if ($MatchedAssets.Count -eq 0) {
    return $null
  }
  return $MatchedAssets[0]
}

function Get-WindowsDesktopAsset {
  param(
    [object]$Release,
    [string]$Architecture
  )
  $Candidates = @($Release.assets | Where-Object {
    $Name = [string]$_.name
    $LowerName = $Name.ToLowerInvariant()
    $ProductMatches = $LowerName -match "one[-_ ]status"
    $SetupMatches = $LowerName -match "setup|installer"
    $ExtensionMatches = $LowerName.EndsWith(".exe")
    $Portable = $LowerName -match "portable"
    $ExplicitX64 = $LowerName -match "x64|x86_64|amd64"
    $ExplicitArm64 = $LowerName -match "arm64|aarch64"
    $ArchitectureMatches = if ($Architecture -eq "arm64") {
      $ExplicitArm64
    } else {
      $ExplicitX64
    }
    $ProductMatches -and $SetupMatches -and $ExtensionMatches -and -not $Portable -and $ArchitectureMatches
  })

  if ($Candidates.Count -eq 0 -and $Architecture -eq "x64") {
    $Candidates = @($Release.assets | Where-Object {
      $LowerName = ([string]$_.name).ToLowerInvariant()
      $LowerName -match "one[-_ ]status" -and
        $LowerName -match "setup|installer" -and
        $LowerName.EndsWith(".exe") -and
        $LowerName -notmatch "portable|arm64|aarch64"
    })
  }

  if ($Candidates.Count -gt 1) {
    Stop-Installer "release $($Release.tag_name) contains multiple Windows $Architecture setup files."
  }
  if ($Candidates.Count -eq 0) {
    return $null
  }
  return $Candidates[0]
}

function Save-ReleaseAsset {
  param(
    [object]$Asset,
    [string]$Destination
  )
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Asset.browser_download_url -Headers @{
      Accept = "application/octet-stream"
      "User-Agent" = "One-Status-Installer"
    } -OutFile $Destination
  } catch {
    Stop-Installer "download failed for $($Asset.name): $($_.Exception.Message)"
  }
}

function Confirm-ReleaseChecksum {
  param(
    [string]$DownloadedFile,
    [string]$ReleaseName,
    [string]$ChecksumFile
  )
  $EscapedName = [Regex]::Escape($ReleaseName)
  $ChecksumLines = @(Get-Content -LiteralPath $ChecksumFile | Where-Object {
    $_ -match "^([0-9a-fA-F]{64})\s+\*?$EscapedName$"
  })
  if ($ChecksumLines.Count -eq 0) {
    Stop-Installer "SHA256SUMS.txt has no valid entry for $ReleaseName."
  }
  if ($ChecksumLines.Count -gt 1) {
    Stop-Installer "SHA256SUMS.txt contains duplicate entries for $ReleaseName."
  }
  $HashMatch = [Regex]::Match($ChecksumLines[0], "^([0-9a-fA-F]{64})")
  if (-not $HashMatch.Success) {
    Stop-Installer "SHA256SUMS.txt has an invalid entry for $ReleaseName."
  }
  $ExpectedHash = $HashMatch.Groups[1].Value.ToLowerInvariant()
  $ActualHash = (Get-FileHash -LiteralPath $DownloadedFile -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ActualHash -cne $ExpectedHash) {
    Stop-Installer "checksum verification failed for $ReleaseName. The downloaded file was not installed."
  }
  Write-OneStatus "verified SHA-256 for $ReleaseName"
}

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  New-Item -ItemType Directory -Path $TemporaryDirectory -Force | Out-Null

  Write-OneStatus "checking the latest One Status release..."
  try {
    $Release = Invoke-RestMethod -UseBasicParsing -Uri $ReleaseApiUrl -Headers @{
      Accept = "application/vnd.github+json"
      "User-Agent" = "One-Status-Installer"
    }
  } catch {
    Stop-Installer "could not read the One Status release manifest. Check your network connection and try again. $($_.Exception.Message)"
  }

  if ($null -eq $Release -or
      $null -eq $Release.PSObject.Properties["tag_name"] -or
      $null -eq $Release.PSObject.Properties["assets"]) {
    Stop-Installer "the GitHub latest release response is missing tag_name or assets."
  }
  $Tag = [string]$Release.tag_name
  if ($Tag -notmatch "^v[0-9]+(\.[0-9]+){2}([.+-][0-9A-Za-z.-]+)?$") {
    Stop-Installer "the GitHub latest release response did not contain a valid semantic version tag_name."
  }
  $Version = $Tag.Substring(1)

  $ChecksumAsset = Get-ReleaseAsset -Release $Release -Name "SHA256SUMS.txt"
  if ($null -eq $ChecksumAsset) {
    Stop-Installer "release $Tag does not contain SHA256SUMS.txt; installation has been stopped."
  }
  $ChecksumFile = Join-Path $TemporaryDirectory "SHA256SUMS.txt"
  Save-ReleaseAsset -Asset $ChecksumAsset -Destination $ChecksumFile

  if ($Cli) {
    $NodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $NodeCommand) {
      Stop-Installer "CLI installation requires Node.js 22 or newer. Install Node.js and run with -Cli again."
    }
    $NodeVersion = [string](& node --version 2>$null)
    $NodeVersionMatch = [Regex]::Match($NodeVersion, "^v([0-9]+)")
    if (-not $NodeVersionMatch.Success) {
      Stop-Installer "could not read the installed Node.js version."
    }
    $NodeMajor = [int]$NodeVersionMatch.Groups[1].Value
    if ($NodeMajor -lt 22) {
      Stop-Installer "CLI installation requires Node.js 22 or newer; found $NodeVersion."
    }

    $AssetName = "one-status-$Version.tgz"
    $Asset = Get-ReleaseAsset -Release $Release -Name $AssetName
    if ($null -eq $Asset) {
      Stop-Installer "release $Tag does not contain $AssetName."
    }
    $Archive = Join-Path $TemporaryDirectory $AssetName
    Save-ReleaseAsset -Asset $Asset -Destination $Archive
    Confirm-ReleaseChecksum -DownloadedFile $Archive -ReleaseName $AssetName -ChecksumFile $ChecksumFile

    $TarCommand = Get-Command tar.exe -ErrorAction SilentlyContinue
    if ($null -eq $TarCommand) {
      Stop-Installer "tar.exe is required to extract the CLI package. Install a current Windows tar utility and run with -Cli again."
    }
    $ExtractDirectory = Join-Path $TemporaryDirectory "cli"
    New-Item -ItemType Directory -Path $ExtractDirectory -Force | Out-Null
    & $TarCommand.Source -xzf $Archive -C $ExtractDirectory "package/dist/one-status.js"
    if ($LASTEXITCODE -ne 0) {
      Stop-Installer "$AssetName does not contain package/dist/one-status.js."
    }
    $ExtractedCli = Join-Path $ExtractDirectory "package\dist\one-status.js"
    if (-not (Test-Path -LiteralPath $ExtractedCli -PathType Leaf)) {
      Stop-Installer "$AssetName does not contain package/dist/one-status.js."
    }

    $InstallDirectory = if ($env:ONE_STATUS_INSTALL_DIR) {
      $env:ONE_STATUS_INSTALL_DIR
    } else {
      Join-Path $env:LOCALAPPDATA "OneStatus\bin"
    }
    New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
    Copy-Item -LiteralPath $ExtractedCli -Destination (Join-Path $InstallDirectory "one-status.js") -Force
    $CommandShim = "@echo off`r`nnode `"%~dp0one-status.js`" %*`r`n"
    [IO.File]::WriteAllText((Join-Path $InstallDirectory "one-status.cmd"), $CommandShim, [Text.Encoding]::ASCII)

    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $PathEntries = if ([string]::IsNullOrWhiteSpace($UserPath)) { @() } else { @($UserPath.Split(";")) }
    if (-not ($PathEntries | Where-Object { $_.TrimEnd("\") -ieq $InstallDirectory.TrimEnd("\") })) {
      $NewUserPath = if ([string]::IsNullOrWhiteSpace($UserPath)) { $InstallDirectory } else { "$UserPath;$InstallDirectory" }
      [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
    }
    if (-not (($env:Path.Split(";")) | Where-Object { $_.TrimEnd("\") -ieq $InstallDirectory.TrimEnd("\") })) {
      $env:Path = "$env:Path;$InstallDirectory"
    }
    Write-OneStatus "installed CLI $Tag at $InstallDirectory\one-status.cmd"
    Write-OneStatus "open a new terminal, then run one-status."
    return
  }

  $Architecture = Get-NormalizedArchitecture
  $Asset = Get-WindowsDesktopAsset -Release $Release -Architecture $Architecture
  if ($null -eq $Asset) {
    Stop-Installer "release $Tag has no Windows $Architecture setup file. See https://github.com/$Repository/releases/tag/$Tag for available files."
  }
  $InstallerPath = Join-Path $TemporaryDirectory ([string]$Asset.name)
  Save-ReleaseAsset -Asset $Asset -Destination $InstallerPath
  Confirm-ReleaseChecksum -DownloadedFile $InstallerPath -ReleaseName ([string]$Asset.name) -ChecksumFile $ChecksumFile

  Write-OneStatus "starting the verified $Tag setup..."
  $SetupProcess = Start-Process -FilePath $InstallerPath -Wait -PassThru
  if ($SetupProcess.ExitCode -ne 0 -and $SetupProcess.ExitCode -ne 3010) {
    Stop-Installer "the desktop setup exited with code $($SetupProcess.ExitCode)."
  }
  Write-OneStatus "desktop setup completed. Launch One Status from the Start menu."
} finally {
  if (Test-Path -LiteralPath $TemporaryDirectory) {
    Remove-Item -LiteralPath $TemporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}
