<#
.SYNOPSIS
    Switch the REAL profile to a new DSH version: plugins and kernel in one step, with a
    pre-switch snapshot and a rollback pointer.

.DESCRIPTION
    Order matters and it is NOT "plugins first, then restart the old kernel":

      * the new plugin releases declare `dsh.engines.dsh: ">=0.2.1-rc.2"`, so the old kernel
        refuses to load them;
      * therefore the plugin swap and the kernel swap must take effect in the SAME restart.

    What this script does, in order (each step verified before the next):

      1. snapshot  - copy the real profile (minus node_modules) into the backup root, count files
      2. stage     - install the new plugin versions into the real profile via the NEW CLI
      3. restore   - re-place plugins that exist only in node_modules and are NOT declared in
                     package.json (pnpm may prune them); they are snapshotted in step 1
      4. pin       - point the launcher's dshPath at the new kernel (dsh-version.mjs does the
                     backup + read-back verification)
      5. restart   - relaunch the managed instance
      6. verify    - run the HTTP smoke test against the new instance

    Without -Apply it only checks preconditions and prints the plan.

.NOTES
    ASCII-only on purpose (Windows PowerShell 5.1 mis-reads BOM-less UTF-8 as ANSI).
    Repository paths contain "[ai]" -> -LiteralPath everywhere.

.EXAMPLE
    .\dsh-switch.ps1 -Version 0.2.1-rc.2                  # 只看计划
    .\dsh-switch.ps1 -Version 0.2.1-rc.2 -Apply           # 真正执行
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$DSHHome = '',
    [string]$Profile = 'web',
    [string]$LauncherConfig = '',
    [string]$BackupRoot = 'D:\dsh-backup',
    [string[]]$Packages = @(
        '@linxin666/dsh-web-all@0.4.8',
        'dshmarket@1.66.45',
        'dsh-whale-widget@0.4.2',
        'dsh-better-sidebar@0.28.0',
        'dsh-plugin-wallpaper-engine@1.4.0'
    ),
    [string[]]$HandPlaced = @('dsh-sidebar-opacity', 'dsh-plugin-app-icon', 'dsh-plugin-restart'),
    [switch]$Apply,
    [switch]$SkipBackup,
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($DSHHome)) {
    if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $DSHHome = $env:DSH_HOME }
    else { $DSHHome = Join-Path $env:USERPROFILE '.dsh' }
}
if ([string]::IsNullOrWhiteSpace($LauncherConfig)) {
    $LauncherConfig = Join-Path $env:LOCALAPPDATA 'DeepSeekHarness\config.json'
}
$Launcher = Join-Path $env:LOCALAPPDATA 'DeepSeekHarness\Launch-DeepSeekHarness.ps1'
$ProfileDir = Join-Path $DSHHome ('profiles\' + $Profile)
$NewBin = Join-Path $env:LOCALAPPDATA ('DeepSeekHarness\versions\' + $Version + '\node_modules\@deepseek-ai\dsh\lib\bin.js')
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$SnapDir = Join-Path $BackupRoot ("$Stamp-pre-switch")
$SnapProfile = Join-Path $SnapDir 'profile'

function Step([string]$m) { Write-Host ("[..] " + $m) }
function Ok([string]$m) { Write-Host ("[OK] " + $m) -ForegroundColor Green }
function Skip([string]$m) { Write-Host ("[--] " + $m) -ForegroundColor DarkGray }
function Warn2([string]$m) { Write-Host ("[!!] " + $m) -ForegroundColor Yellow }

function Count-Files([string]$p, [switch]$ExcludeNodeModules) {
    if (-not (Test-Path -LiteralPath $p)) { return 0 }
    $all = @(Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue)
    if ($ExcludeNodeModules) { $all = @($all | Where-Object { $_.FullName -notmatch '\\node_modules\\' }) }
    return $all.Count
}

Write-Host '=== DSH switch plan ==='
Write-Host ("mode        : " + $(if ($Apply) { 'APPLY' } else { 'dry-run (add -Apply to execute)' }))
Write-Host ("version     : " + $Version)
Write-Host ("DSH_HOME    : " + $DSHHome)
Write-Host ("profile     : " + $Profile + "  ->  " + $ProfileDir)
Write-Host ("new kernel  : " + $NewBin)
Write-Host ("backup root : " + $BackupRoot)
Write-Host ''

# ---- preconditions -----------------------------------------------------------
$fail = 0
if (-not (Test-Path -LiteralPath $NewBin)) { Write-Host ("[FAIL] new kernel missing: " + $NewBin) -ForegroundColor Red; $fail++ }
else { $v = (& node $NewBin --version 2>&1 | Out-String).Trim(); Ok ("new kernel reports " + $v) }
if (-not (Test-Path -LiteralPath $ProfileDir)) { Write-Host ("[FAIL] profile dir missing: " + $ProfileDir) -ForegroundColor Red; $fail++ }
if (-not (Test-Path -LiteralPath $LauncherConfig)) { Write-Host ("[FAIL] launcher config missing: " + $LauncherConfig) -ForegroundColor Red; $fail++ }
$pkgJson = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $pkgJson)) { Write-Host ("[FAIL] profile package.json missing") -ForegroundColor Red; $fail++ }
if (-not (Test-Path -LiteralPath $Launcher)) { Write-Host ("[FAIL] launcher missing: " + $Launcher) -ForegroundColor Red; $fail++ }
if ($fail -gt 0) { throw ("$fail precondition(s) failed; nothing changed") }

$cur = Get-Content -LiteralPath $pkgJson -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host ''
Write-Host 'current declared deps:'
foreach ($p in $cur.dependencies.PSObject.Properties) { Write-Host ("  {0} = {1}" -f $p.Name, $p.Value) }
Write-Host ''
Write-Host 'target packages:'
foreach ($p in $Packages) { Write-Host ("  + " + $p) }
Write-Host ''
Write-Host 'hand-placed plugins (not in package.json, must be re-placed after install):'
foreach ($p in $HandPlaced) { Write-Host ("  ~ " + $p) }
Write-Host ''

if (-not $Apply) {
    Warn2 'dry-run: nothing was changed. Re-run with -Apply to execute steps 1-6.'
    return
}

# ---- 1. snapshot -------------------------------------------------------------
if ($SkipBackup) {
    Skip 'step 1 snapshot (skipped by -SkipBackup)'
} else {
    Step ("step 1/6 snapshot -> " + $SnapProfile)
    if (-not (Test-Path -LiteralPath $SnapDir)) { [void][System.IO.Directory]::CreateDirectory($SnapDir) }
    & robocopy.exe $ProfileDir $SnapProfile /E /XJ /XD node_modules /R:1 /W:1 /NFL /NDL /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw ("robocopy failed: " + $LASTEXITCODE) }
    $n1 = Count-Files $ProfileDir -ExcludeNodeModules
    $n2 = Count-Files $SnapProfile
    Write-Host ("     files: profile=$n1 snapshot=$n2")
    if ($n2 -lt $n1) { throw 'snapshot incomplete; aborting before any change' }
    # 手工放置的插件也一并留底，供步骤 3 复原
    foreach ($h in $HandPlaced) {
        $src = Join-Path $ProfileDir ('node_modules\' + $h)
        if (Test-Path -LiteralPath $src) {
            & robocopy.exe $src (Join-Path $SnapDir ('hand-placed\' + $h)) /E /XJ /R:1 /W:1 /NFL /NDL /NP | Out-Null
            if ($LASTEXITCODE -ge 8) { throw ("robocopy failed for " + $h) }
        }
    }
    Ok 'snapshot done'
}

# ---- 1b. release-age exemptions ---------------------------------------------
# pnpm 12 的"新版本冷却"会把刚发布的版本挡回去，add 之后静默落成旧版。
# 这里在装之前把目标版本写进 minimumReleaseAgeExclude（幂等，且先备份）。
Step 'step 1b/6 ensure pnpm release-age exemptions'
$wsFile = Join-Path $ProfileDir 'pnpm-workspace.yaml'
if (-not (Test-Path -LiteralPath $wsFile)) {
    Warn2 ('  no pnpm-workspace.yaml at ' + $wsFile + '; skipping')
} else {
    $curWs = [System.IO.File]::ReadAllText($wsFile, [System.Text.Encoding]::UTF8)
    $need = @()
    foreach ($p in $Packages) {
        $nm0 = ($p -split '@')[0]
        if ($p.StartsWith('@')) { $nm0 = '@' + (($p.Substring(1) -split '@')[0]) }
        $ver0 = ($p -split '@')[-1]
        $entry = $nm0 + '@' + $ver0
        if ($curWs -notmatch [regex]::Escape($entry)) { $need += $entry }
    }
    if ($need.Count -eq 0) {
        Skip '  all target versions already exempt'
    } else {
        $bakWs = $wsFile + '.bak-releaseage-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
        Copy-Item -LiteralPath $wsFile -Destination $bakWs -Force
        $lines2 = ($need | ForEach-Object { '  - "' + $_ + '"' }) -join [Environment]::NewLine
        if ($curWs -match 'minimumReleaseAgeExclude:') {
            $newWs = $curWs.TrimEnd() + [Environment]::NewLine + $lines2 + [Environment]::NewLine
        } else {
            $newWs = $curWs.TrimEnd() + [Environment]::NewLine + 'minimumReleaseAgeExclude:' + [Environment]::NewLine + $lines2 + [Environment]::NewLine
        }
        [System.IO.File]::WriteAllText($wsFile, $newWs, (New-Object System.Text.UTF8Encoding($false)))
        Ok ('  added: ' + ($need -join ', ') + '  (backup ' + (Split-Path -Leaf $bakWs) + ')')
    }
}

# ---- 2. stage plugins --------------------------------------------------------
Step ("step 2/6 install " + $Packages.Count + " package(s) into the REAL profile")
$env:DSH_HOME = $DSHHome
$addArgs = @('plugin', '--profile', $Profile, 'add') + $Packages
& node $NewBin @addArgs
if ($LASTEXITCODE -ne 0) { throw ("plugin add failed with exit code " + $LASTEXITCODE) }
Ok 'plugin add returned 0 (verify versions next)'

$nm = Join-Path $ProfileDir 'node_modules'
$bad = 0
foreach ($p in $Packages) {
    $name = ($p -split '@')[0]
    if ($p.StartsWith('@')) { $name = '@' + (($p.Substring(1) -split '@')[0]) }
    $pj = Join-Path $nm ($name.Replace('/', '\') + '\package.json')
    if (Test-Path -LiteralPath $pj) {
        $j = Get-Content -LiteralPath $pj -Raw -Encoding UTF8 | ConvertFrom-Json
        Write-Host ("     " + $j.name + " = " + $j.version)
        $want = ($p -split '@')[-1]
        if ($j.version -ne $want) { Warn2 ("  version differs from request: wanted " + $want + ", got " + $j.version) }
    } else { Warn2 ("  not installed: " + $name); $bad++ }
}
if ($bad -gt 0) { throw ("$bad package(s) missing after install; stopping before pin/restart") }

# ---- 3. restore hand-placed packages ----------------------------------------
Step 'step 3/6 re-place hand-placed plugins (pnpm may have pruned them)'
foreach ($h in $HandPlaced) {
    $dst = Join-Path $nm $h
    $src = Join-Path $SnapDir ('hand-placed\' + $h)
    if (Test-Path -LiteralPath $dst) { Skip ("  still present: " + $h); continue }
    if (-not (Test-Path -LiteralPath $src)) { Warn2 ("  no snapshot for " + $h + "; cannot restore"); continue }
    & robocopy.exe $src $dst /E /XJ /R:1 /W:1 /NFL /NDL /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw ("restore failed for " + $h) }
    Ok ("  restored " + $h)
}

# ---- 3b. appearance carry-over ----------------------------------------------
# 0.2.1 的 dsh-settings 会把 settings.yaml 改名成 .imported 再逐段导入；导入不认的段落
# 只留在改名后的文件里（2026-10-26 实测：skin-wallpaper / skin-custom-theme 都没进去）。
# 壁纸现在由 dsh-plugin-wallpaper-engine 在 DSH_HOME 之外自己持久化，无需在此处理；
# 自定义主题需要在皮肤中心的 config 上显式补一条，否则升级后"颜色会变"。
Step 'step 3b/6 ensure appearance overrides in the profile patch'
$patchFile = Join-Path $ProfileDir 'cordis.patch.yml'
if (-not (Test-Path -LiteralPath $patchFile)) {
    Warn2 ("  no patch layer at " + $patchFile + "; skipping appearance overrides")
} elseif ((Get-Content -LiteralPath $patchFile -Raw -Encoding UTF8) -match 'skin-custom-theme') {
    Skip '  appearance overrides already present'
} else {
    $bak = $patchFile + '.bak-appearance-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item -LiteralPath $patchFile -Destination $bak -Force
    $blockLines = @(
        '',
        '# ==== appearance carry-over (added by dsh-switch) ====',
        '# Custom theme stays OFF on purpose: with applied:true it paints an opaque base plate',
        '# that covers the z-index:-2 wallpaper layer. Verified 2026-10-26 on the trial copy:',
        '# the wallpaper was playing yet invisible, and turning the theme off made it appear.',
        '# The legacy settings.yaml marker applied:true is dropped by the 0.2.1 import anyway,',
        '# so this row only pins the intended (off) state explicitly.',
        '- id: web-ui-skin-center',
        '  config:',
        '    skin-custom-theme:',
        '      applied: false'
    )
    $block = [Environment]::NewLine + ($blockLines -join [Environment]::NewLine) + [Environment]::NewLine
    $cur = [System.IO.File]::ReadAllText($patchFile, [System.Text.Encoding]::UTF8)
    [System.IO.File]::WriteAllText($patchFile, $cur + $block, (New-Object System.Text.UTF8Encoding($false)))
    $back = [System.IO.File]::ReadAllText($patchFile, [System.Text.Encoding]::UTF8)
    if ($back -notmatch 'skin-custom-theme') { throw 'appearance override was not written' }
    Ok ("  written; backup = " + $bak)
}

# ---- 4. pin -----------------------------------------------------------------
Step 'step 4/6 pin the launcher to the new kernel'
$verScript = Join-Path $PSScriptRoot 'dsh-version.mjs'
& node $verScript pin --bin $NewBin
if ($LASTEXITCODE -ne 0) { throw 'pin failed; launcher config unchanged (see dsh-version.mjs output)' }
Ok 'pinned'

# ---- 5. restart -------------------------------------------------------------
# 这一步会重启承载本会话的服务进程，agent 自己跑会在中途断开。-NoRestart 让你在前
# 四步验证通过后，改由「插件自己的 /dsh-restart/restart 端点」或人工双击来重启。
if ($NoRestart) {
    Skip 'step 5/6 restart (skipped by -NoRestart)'
    Write-Host ''
    Write-Host 'Steps 1-4 are done. The profile now holds the NEW plugin set while the OLD kernel'
    Write-Host 'is still running. Do not let it restart on its own: restart it deliberately now, via'
    Write-Host '  POST /dsh-restart/restart    (the dsh-plugin-restart endpoint)'
    Write-Host 'or by relaunching the desktop shortcut. Both boot the new kernel with the new plugins.'
    return
} else {
    Step 'step 5/6 restart the managed instance'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $Launcher -Restart -NoBrowser
    if ($LASTEXITCODE -ne 0) { Warn2 ("launcher exited " + $LASTEXITCODE + " - check %LOCALAPPDATA%\DeepSeekHarness\logs\launcher.log") }
}

# ---- 6. verify --------------------------------------------------------------
Step 'step 6/6 smoke test the new instance'
$urlFile = Join-Path $env:LOCALAPPDATA 'DeepSeekHarness\server-url.json'
$deadline = (Get-Date).AddSeconds(120)
$url = ''
while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $urlFile) {
        try { $rec = Get-Content -LiteralPath $urlFile -Raw -Encoding UTF8 | ConvertFrom-Json; $url = [string]$rec.url } catch { $url = '' }
        if (-not [string]::IsNullOrWhiteSpace($url)) { break }
    }
    Start-Sleep -Milliseconds 500
}
if ([string]::IsNullOrWhiteSpace($url)) { Warn2 'no server-url.json yet; check the logs manually'; return }
Write-Host ("     url: " + $url)
$smoke = Join-Path $PSScriptRoot 'dsh-smoke.mjs'
& node $smoke --url $url
if ($LASTEXITCODE -ne 0) {
    Warn2 'smoke test reported failures'
    Warn2 ("roll back with: .\dsh-rollback.ps1 -BackupDir `"" + $SnapDir + "`" -What profile,settings,config")
    throw 'smoke test failed after switch'
}
Ok 'switch complete and verified'
Write-Host ''
Write-Host ("rollback snapshot: " + $SnapDir)
Write-Host ("rollback command : .\dsh-rollback.ps1 -BackupDir `"" + $SnapDir + "`" -What profile,settings,config")
