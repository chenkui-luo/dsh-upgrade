<#
.SYNOPSIS
    Install / reinstall / uninstall the dsh-upgrade skill under $DSH_HOME\skills\dsh-upgrade.

.DESCRIPTION
    The skill lives in this repository (dsh-upgrade\SKILL.md) and is deployed by copying it
    into the DSH home, where the skill loader discovers it as <name>\SKILL.md.

    Written to be run by a human or by an agent after the user approves writing outside the
    workspace: $DSH_HOME is outside it.

.NOTES
    ASCII-only on purpose. -LiteralPath everywhere.

.EXAMPLE
    .\install-skill.ps1
    .\install-skill.ps1 -WhatIf
    .\install-skill.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$DSHHome = '',
    [string]$Source = '',
    [switch]$Uninstall,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($DSHHome)) {
    if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $DSHHome = $env:DSH_HOME }
    else { $DSHHome = Join-Path $env:USERPROFILE '.dsh' }
}
if ([string]::IsNullOrWhiteSpace($Source)) {
    $Source = Join-Path (Split-Path -Parent $PSScriptRoot) 'SKILL.md'
}

$TargetDir = Join-Path $DSHHome 'skills\dsh-upgrade'
$Target = Join-Path $TargetDir 'SKILL.md'

function Write-Ok([string]$m) { Write-Host ("[OK] " + $m) -ForegroundColor Green }
function Write-Step([string]$m) { Write-Host ("[..] " + $m) }

if ($Uninstall) {
    if (-not (Test-Path -LiteralPath $TargetDir)) { Write-Host 'nothing to uninstall'; return }
    Write-Step ("removing " + $TargetDir)
    if (-not $WhatIf) { Remove-Item -LiteralPath $TargetDir -Recurse -Force }
    Write-Ok 'skill uninstalled'
    return
}

if (-not (Test-Path -LiteralPath $Source)) { throw ("SKILL.md not found: " + $Source) }

Write-Step ("source: " + $Source)
Write-Step ("target: " + $Target)
if ($WhatIf) {
    Write-Host '[WhatIf] nothing written'
    return
}

if (-not (Test-Path -LiteralPath $TargetDir)) { [void][System.IO.Directory]::CreateDirectory($TargetDir) }
Copy-Item -LiteralPath $Source -Destination $Target -Force

$h1 = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
$h2 = (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash
if ($h1 -ne $h2) { throw 'copy verification failed: source and target hashes differ' }
Write-Ok ("installed and verified (sha256 " + $h1.Substring(0, 12) + "...)")

$line = Get-Content -LiteralPath $Target -TotalCount 3 -Encoding UTF8
Write-Host ('first lines: ' + (($line -join ' | ')))
Write-Host ''
Write-Host 'Verify the loader sees it:'
Write-Host '  restart the DSH service, then ask the agent "有哪些技能" or open the skills panel.'
