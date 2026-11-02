<#
.SYNOPSIS
    Restore DSH state from a backup directory created during an upgrade.

.DESCRIPTION
    An upgrade touches four things; this script restores any subset of them:

      profile   profiles\<name>\            plugin set + patch layer + lockfile
      sessions  sessions\                   chat history (session format is one-way, so a
                                            downgrade needs this restored too)
      settings  settings.yaml / .credentials.yaml
      config    the launcher's config.json (dshPath etc.)

    Default is to overwrite, never to delete: /PURGE is opt-in because it removes files
    that exist in the target but not in the backup (e.g. sessions created after the
    backup was taken).

.NOTES
    ASCII-only on purpose (Windows PowerShell 5.1 mis-reads BOM-less UTF-8 as ANSI).
    Repository paths contain "[ai]" -> always -LiteralPath.

.EXAMPLE
    .\dsh-rollback.ps1 -ListBackups

.EXAMPLE
    .\dsh-rollback.ps1 -BackupDir D:\dsh-backup\2026-10-26 -What profile,sessions -DryRun

.EXAMPLE
    .\dsh-rollback.ps1 -BackupDir D:\dsh-backup\2026-10-26 -What all -Purge
#>
[CmdletBinding()]
param(
    [string]$BackupDir = '',
    [string]$DSHHome = '',
    [string]$Profile = 'web',
    [string]$LauncherConfig = '',
    [string[]]$What = @('profile', 'sessions', 'settings', 'config'),
    [switch]$Purge,
    [switch]$DryRun,
    [switch]$ListBackups,
    [string]$BackupRoot = 'D:\dsh-backup'
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($DSHHome)) {
    if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $DSHHome = $env:DSH_HOME }
    else { $DSHHome = Join-Path $env:USERPROFILE '.dsh' }
}
if ([string]::IsNullOrWhiteSpace($LauncherConfig)) {
    $LauncherConfig = Join-Path $env:LOCALAPPDATA 'DeepSeekHarness\config.json'
}

function Write-Step([string]$m) { Write-Host ("[..] " + $m) }
function Write-Ok([string]$m) { Write-Host ("[OK] " + $m) -ForegroundColor Green }
function Write-Warn2([string]$m) { Write-Host ("[!!] " + $m) -ForegroundColor Yellow }
function Write-Fail([string]$m) { Write-Host ("[FAIL] " + $m) -ForegroundColor Red }

function Count-Files([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    return @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue).Count
}

function Invoke-Mirror([string]$From, [string]$To, [bool]$DoPurge) {
    if (-not (Test-Path -LiteralPath $From)) { throw ("backup source missing: " + $From) }
    if (-not (Test-Path -LiteralPath $To)) {
        [void][System.IO.Directory]::CreateDirectory($To)
    }
    $a = @($From, $To, '/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NP')
    if ($DoPurge) { $a += '/PURGE' }
    if ($DryRun) { $a += @('/L') }
    & robocopy.exe @a | Out-Null
    $rc = $LASTEXITCODE
    if ($rc -ge 8) { throw ("robocopy failed with exit code " + $rc + " for " + $From) }
    return $rc
}

# ---- list mode ---------------------------------------------------------------
if ($ListBackups) {
    Write-Host ("=== backups under " + $BackupRoot + " ===")
    if (-not (Test-Path -LiteralPath $BackupRoot)) { Write-Warn2 'no backup root yet'; return }
    Get-ChildItem -LiteralPath $BackupRoot -Directory | Sort-Object Name -Descending | ForEach-Object {
        $homeDir = Join-Path $_.FullName 'dsh-home'
        $cfg = Join-Path $_.FullName 'config.json'
        Write-Host ("  " + $_.Name)
        Write-Host ("     dsh-home   : " + $(if (Test-Path -LiteralPath $homeDir) { "yes (" + (Count-Files $homeDir) + " files)" } else { 'no' }))
        Write-Host ("     config.json: " + $(if (Test-Path -LiteralPath $cfg) { 'yes' } else { 'no' }))
    }
    return
}

if ([string]::IsNullOrWhiteSpace($BackupDir)) { throw '-BackupDir is required (or use -ListBackups)' }
if (-not (Test-Path -LiteralPath $BackupDir)) { throw ("backup dir not found: " + $BackupDir) }

# Normalise: allow either <backup root\stamp> or <stamp\dsh-home>
$HomeBackup = Join-Path $BackupDir 'dsh-home'
if (-not (Test-Path -LiteralPath $HomeBackup)) {
    if ((Split-Path -Leaf $BackupDir) -eq 'dsh-home') { $HomeBackup = $BackupDir }
    else { $HomeBackup = $BackupDir }
}
$CfgBackup = Join-Path $BackupDir 'config.json'

$wanted = @()
foreach ($w in $What) { foreach ($x in ($w -split ',')) { if (-not [string]::IsNullOrWhiteSpace($x)) { $wanted += $x.Trim().ToLower() } } }
if ($wanted -contains 'all') { $wanted = @('profile', 'sessions', 'settings', 'config') }

Write-Host '=== DSH rollback ==='
Write-Host ("backup   : {0}" -f $BackupDir)
Write-Host ("DSH_HOME : {0}" -f $DSHHome)
Write-Host ("parts    : {0}" -f ($wanted -join ', '))
Write-Host ("purge    : {0}" -f $Purge)
Write-Host ("dry-run  : {0}" -f $DryRun)
Write-Host ''

if ($wanted -contains 'profile') {
    $from = Join-Path $HomeBackup ('profiles\' + $Profile)
    $to = Join-Path $DSHHome ('profiles\' + $Profile)
    Write-Step ("profile  {0} -> {1}" -f $from, $to)
    Invoke-Mirror $from $to $Purge | Out-Null
    Write-Ok ("profile restored (target files: " + (Count-Files $to) + ")")
}

if ($wanted -contains 'sessions') {
    $from = Join-Path $HomeBackup 'sessions'
    $to = Join-Path $DSHHome 'sessions'
    Write-Step ("sessions {0} -> {1}" -f $from, $to)
    Invoke-Mirror $from $to $Purge | Out-Null
    Write-Ok ("sessions restored (target files: " + (Count-Files $to) + ")")
}

if ($wanted -contains 'settings') {
    foreach ($f in @('settings.yaml', '.credentials.yaml')) {
        $from = Join-Path $HomeBackup $f
        $to = Join-Path $DSHHome $f
        if (-not (Test-Path -LiteralPath $from)) { Write-Warn2 ("skip missing backup file: " + $f); continue }
        if ($DryRun) {
            Write-Step ("would restore settings {0} -> {1}" -f $from, $to)
            continue
        }
        Write-Step ("settings {0}" -f $f)
        Copy-Item -LiteralPath $from -Destination $to -Force
        $h1 = (Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash
        $h2 = (Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash
        if ($h1 -ne $h2) { throw ("hash mismatch after restoring " + $f) }
        Write-Ok ("restored and verified: " + $f)
    }
}

if ($wanted -contains 'config') {
    foreach ($cand in @($CfgBackup, (Join-Path $DSHHome 'config.json'))) {
        if (Test-Path -LiteralPath $cand) {
            if ($DryRun) {
                Write-Step ("would restore launcher config {0} -> {1}" -f $cand, $LauncherConfig)
                break
            }
            Write-Step ("launcher config {0} -> {1}" -f $cand, $LauncherConfig)
            $bak = $LauncherConfig + '.bak-rollback'
            if (Test-Path -LiteralPath $LauncherConfig) { Copy-Item -LiteralPath $LauncherConfig -Destination $bak -Force }
            Copy-Item -LiteralPath $cand -Destination $LauncherConfig -Force
            Write-Ok 'launcher config restored (previous one kept as .bak-rollback)'
            break
        }
    }
}

Write-Host ''
Write-Host 'Done. Restart the service to pick up the change:'
Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\DeepSeekHarness\Launch-DeepSeekHarness.ps1" -Restart'
