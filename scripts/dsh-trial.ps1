<#
.SYNOPSIS
    Prepare an isolated trial environment for a DSH version: install that version into
    its own directory, clone the real DSH_HOME into a separate trial home, and print the
    exact command to start the trial server on its own port.

.DESCRIPTION
    The point is to test a DSH upgrade WITHOUT touching the real environment:

      * the trial home is a copy, so session-format migration (v2 -> v3, one-way) only
        ever happens to the copy;
      * the trial server runs on a different port, so the real instance keeps serving;
      * the trial dsh lives in its own directory, so `dsh-version.mjs pin` can switch
        the real launcher to it later with a single field change.

    Nothing outside the given -InstallDir / -TrialHome is written.

.NOTES
    ASCII-only on purpose: Windows PowerShell 5.1 mis-reads a BOM-less UTF-8 script as ANSI.
    Repository paths contain "[ai]", so every path operation here uses -LiteralPath.

.EXAMPLE
    .\dsh-trial.ps1 -Version 0.2.1-rc.2 -PrepareInstall -CopyHome

.EXAMPLE
    .\dsh-trial.ps1 -Version 0.2.1-rc.2 -CopyHome -NoSessions -Start
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,

    [string]$InstallDir = '',
    [string]$TrialHome = '',
    [string]$DSHHome = '',
    [int]$Port = 3081,
    [string]$NpmCache = '',

    [switch]$PrepareInstall,
    [switch]$CopyHome,
    [switch]$NoSessions,
    [switch]$Start,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# ---- paths -----------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($DSHHome)) {
    if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $DSHHome = $env:DSH_HOME }
    else { $DSHHome = Join-Path $env:USERPROFILE '.dsh' }
}
$DataRoot = Join-Path $env:LOCALAPPDATA 'DeepSeekHarness'
if ([string]::IsNullOrWhiteSpace($InstallDir)) { $InstallDir = Join-Path $DataRoot ('versions\' + $Version) }
if ([string]::IsNullOrWhiteSpace($TrialHome)) { $TrialHome = Join-Path $DataRoot 'trial-home' }
if ([string]::IsNullOrWhiteSpace($NpmCache)) { $NpmCache = Join-Path $DataRoot 'npm-cache' }

$BinPath = Join-Path $InstallDir 'node_modules\@deepseek-ai\dsh\lib\bin.js'

function Write-Step([string]$Message) { Write-Host ("[..] " + $Message) }
function Write-Ok([string]$Message) { Write-Host ("[OK] " + $Message) -ForegroundColor Green }
function Write-Warn2([string]$Message) { Write-Host ("[!!] " + $Message) -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host ("[FAIL] " + $Message) -ForegroundColor Red }

function Count-Files([string]$Path, [string]$ExcludeDirName) {
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $all = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue)
    if (-not [string]::IsNullOrWhiteSpace($ExcludeDirName)) {
        $all = @($all | Where-Object { $_.FullName -notmatch ('\\' + [regex]::Escape($ExcludeDirName) + '\\') })
    }
    return $all.Count
}

function Test-Bin([string]$Bin) {
    if (-not (Test-Path -LiteralPath $Bin)) { return $null }
    $out = & node $Bin --version 2>&1
    return ($out | Out-String).Trim()
}

Write-Host '=== DSH trial environment ==='
Write-Host ("version      : {0}" -f $Version)
Write-Host ("install dir  : {0}" -f $InstallDir)
Write-Host ("trial home   : {0}" -f $TrialHome)
Write-Host ("real DSH_HOME: {0}" -f $DSHHome)
Write-Host ("port         : {0}" -f $Port)
Write-Host ''

# ---- 1. install the version --------------------------------------------------
if ($PrepareInstall) {
    Write-Step ("installing @deepseek-ai/dsh@{0} into {1}" -f $Version, $InstallDir)
    if (-not (Test-Path -LiteralPath $InstallDir)) {
        [void][System.IO.Directory]::CreateDirectory($InstallDir)
    }
    $pkgJson = Join-Path $InstallDir 'package.json'
    if (-not (Test-Path -LiteralPath $pkgJson)) {
        $seed = "{`n  `"name`": `"dsh-version-$Version`",`n  `"private`": true`n}`n"
        [System.IO.File]::WriteAllText($pkgJson, $seed, (New-Object System.Text.UTF8Encoding($false)))
    }
    $npmArgs = @('install', ('@deepseek-ai/dsh@' + $Version), '--prefix', $InstallDir, '--cache', $NpmCache, '--no-audit', '--no-fund')
    & npm @npmArgs
    if ($LASTEXITCODE -ne 0) { throw ("npm install failed with exit code " + $LASTEXITCODE) }
    if (-not (Test-Path -LiteralPath $BinPath)) { throw ("bin.js missing after install: " + $BinPath) }
    Write-Ok ("installed: " + (Test-Bin $BinPath))
} else {
    $v = Test-Bin $BinPath
    if ($null -eq $v) { Write-Warn2 ("not installed at " + $BinPath + " - rerun with -PrepareInstall") }
    else { Write-Ok ("already installed: " + $v) }
}

# ---- 2. clone the real home --------------------------------------------------
if ($CopyHome) {
    if (-not (Test-Path -LiteralPath $DSHHome)) { throw ("real DSH_HOME not found: " + $DSHHome) }
    if ((Test-Path -LiteralPath $TrialHome) -and -not $Force) {
        $existing = Count-Files $TrialHome 'node_modules'
        if ($existing -gt 0) {
            throw ("trial home already has " + $existing + " files: " + $TrialHome + " (pass -Force to overwrite)")
        }
    }
    Write-Step ("cloning {0} -> {1} (skipping node_modules)" -f $DSHHome, $TrialHome)
    if (-not (Test-Path -LiteralPath $TrialHome)) {
        [void][System.IO.Directory]::CreateDirectory($TrialHome)
    }
    $robocopyArgs = @($DSHHome, $TrialHome, '/E', '/XJ', '/R:1', '/W:1', '/NFL', '/NDL', '/NP', '/XD', 'node_modules')
    if ($NoSessions) { $robocopyArgs += @('/XD', 'sessions') }
    & robocopy.exe @robocopyArgs | Out-Null
    $rc = $LASTEXITCODE
    if ($rc -ge 8) { throw ("robocopy failed with exit code " + $rc) }

    $srcCount = Count-Files $DSHHome 'node_modules'
    $dstCount = Count-Files $TrialHome 'node_modules'
    Write-Host ("     files: source={0} trial={1}" -f $srcCount, $dstCount)
    if ($dstCount -lt $srcCount) {
        throw ("clone looks incomplete (trial has fewer files than source)")
    }
    Write-Ok 'trial home cloned'
} else {
    Write-Warn2 'skipped cloning the home (-CopyHome not given)'
}

# ---- 3. next steps / start ---------------------------------------------------
$profileDir = Join-Path $TrialHome 'profiles\web'
$hasModules = Test-Path -LiteralPath (Join-Path $profileDir 'node_modules')

Write-Host ''
Write-Host '=== next steps ==='
Write-Host '1) Upgrade the plugins INSIDE the trial home (the trial dsh is the new kernel):'
Write-Host ''
Write-Host ("   `$env:DSH_HOME = '" + $TrialHome + "'")
Write-Host ("   node `"" + $BinPath + "`" plugin --profile web add <packages...>")
Write-Host ''
if (-not $hasModules) {
    Write-Warn2 ("trial profile has no node_modules yet; the first plugin command will populate it: " + $profileDir)
    Write-Host ''
}
Write-Host '2) Start the trial server on its own port:'
Write-Host ''
Write-Host ("   `$env:DSH_HOME = '" + $TrialHome + "'")
Write-Host ("   node `"" + $BinPath + "`" web --no-open --port " + $Port)
Write-Host ''
Write-Host '   then open the token URL it prints. The real instance on 3080 keeps running.'
Write-Host ''
Write-Host '3) When the trial passes acceptance, switch the real launcher:'
Write-Host ''
Write-Host ("   node dsh-version.mjs pin --bin `"" + $BinPath + "`"")
Write-Host ''

if ($Start) {
    if (-not (Test-Path -LiteralPath $BinPath)) { throw 'cannot -Start: the trial dsh is not installed' }
    Write-Step ("starting trial server on port {0} (Ctrl+C to stop)" -f $Port)
    $env:DSH_HOME = $TrialHome
    & node $BinPath web --no-open --port $Port
}
