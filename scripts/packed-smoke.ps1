#requires -Version 5.1
<#
.SYNOPSIS
    Packed add/rm smoke across Auto / Manual / Off: packs the CURRENT tarball,
    installs it into a disposable profile under the isolated DSH_HOME, boots
    a real headless task at each mode (policy / tools / /align asserted from
    the assembled system prompt and live registries), then removes it and
    verifies the profile returns to a clean state. Run after `pnpm run build`
    (the pack ships the fresh lib/ build).
#>
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $pluginRoot
$dshHome = Join-Path $workspaceRoot '.dsh-dogfood'
$profile = 'packed-smoke'
$tempRoot = Join-Path $workspaceRoot '_packed-smoke'
$recordRoot = Join-Path $pluginRoot 'dogfood\records'
$utf8NoBom = New-Object Text.UTF8Encoding($false)
$script:results = @()

function Resolve-DshLauncher {
    $cmd = Get-Command dsh -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $fallback = Join-Path $env:USERPROFILE '.dsh\profiles\node_modules\@deepseek-ai\dsh\node_modules\.bin\dsh.CMD'
    if (Test-Path $fallback) { return $fallback }
    throw 'dsh launcher not found: add it to PATH or install @deepseek-ai/dsh into the profile root node_modules'
}

function Add-Check {
    param([Parameter(Mandatory)][bool]$Ok, [Parameter(Mandatory)][string]$Label)
    Write-Host ("[{0}] {1}" -f $(if ($Ok) { 'PASS' } else { 'FAIL' }), $Label)
    $script:results += $Ok
}

function Read-Records([string]$Path) {
    if (-not (Test-Path $Path)) { return @() }
    return @(Get-Content $Path | ForEach-Object { $_ | ConvertFrom-Json })
}

function Get-Phase($records, [string]$Phase) {
    return @($records | Where-Object { $_.PSObject.Properties.Name -contains 'phase' -and $_.phase -eq $Phase })
}

function Invoke-ModeBoot {
    param(
        [Parameter(Mandatory)][string]$Mode,
        [Parameter(Mandatory)][string]$TarballName,
        [Parameter(Mandatory)][bool]$ExpectPolicy,
        [Parameter(Mandatory)][bool]$ExpectTools,
        [Parameter(Mandatory)][bool]$ExpectAlign
    )
    $scenarioDir = Join-Path $pluginRoot 'dogfood\scenarios\packed-smoke'
    if (Test-Path $scenarioDir) { Remove-Item (Join-Path $scenarioDir '*') -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Force -Path $scenarioDir | Out-Null
    Copy-Item (Join-Path $pluginRoot 'dogfood\fixtures\02-typo\*') $scenarioDir -Recurse -Force
    $recordPath = Join-Path $recordRoot "packed-smoke-$Mode.jsonl"
    if (Test-Path $recordPath) { Remove-Item $recordPath -Force }
    $yamlRecordPath = $recordPath.Replace("'", "''")
    $runAlign = if ($ExpectAlign) { 'true' } else { 'false' }
    $overlay = @"
- id: requirements-alignment
  config:
    mode: $Mode
- id: scripted-answers
  config:
    default:
      custom: 'No answer needed.'
    recordPath: '$yamlRecordPath'
- insert:
    - id: align-driver
      name: 'dsh-requirements-alignment/align-driver'
      config:
        recordPath: '$yamlRecordPath'
        runAlign: $runAlign
        verifyPolicySection: true
        verifyRegistrations: true
"@
    $overlayPath = Join-Path $tempRoot "packed-smoke-$Mode-overlay.yml"
    [IO.File]::WriteAllText($overlayPath, $overlay, $utf8NoBom)
    if ($ExpectTools) {
        $task = "Fix the typo in README.md. Before fixing, call establish_baseline with goal 'Fix the typo in README.md' and explicitConstraints ['typo fix only']. Then fix the typo."
    } else {
        $task = "Fix the typo in README.md."
    }
    Push-Location $scenarioDir
    $output = & $script:dsh --profile $profile --patch $overlayPath $task 2>&1
    $exit = $LASTEXITCODE
    Pop-Location
    Add-Check ($exit -eq 0) "$Mode packed profile booted and completed the task (exit $exit)"
    $records = Read-Records $recordPath
    $regs = Get-Phase $records 'registrations'
    $reg = $regs | Select-Object -First 1
    $regOk = $regs.Count -ge 1 -and $reg.executed
    Add-Check $regOk "$Mode registrations recorded from live registries"
    if ($regOk) {
        $tools = @($reg.tools)
        $hasTools = ($tools -contains 'establish_baseline') -and ($tools -contains 'report_drift')
        Add-Check (($reg.policy -eq $ExpectPolicy)) "$Mode policy section present=$ExpectPolicy (assembled system prompt; got $($reg.policy))"
        Add-Check (($hasTools -eq $ExpectTools)) "$Mode alignment tools present=$ExpectTools (got: $($tools -join ','))"
        Add-Check (($reg.align -eq $ExpectAlign)) "$Mode /align registered=$ExpectAlign (got $($reg.align))"
    } else {
        Add-Check $false "$Mode policy section present=$ExpectPolicy (no registrations record)"
        Add-Check $false "$Mode alignment tools present=$ExpectTools (no registrations record)"
        Add-Check $false "$Mode /align registered=$ExpectAlign (no registrations record)"
    }
    if ($ExpectAlign) {
        $align = Get-Phase $records 'align'
        Add-Check ($align.Count -ge 1 -and $align[0].executed -and $align[0].resultKind -eq 'success') "$Mode /align executed through the real commands registry"
        $modeLabel = if ($Mode -eq 'auto') { 'Mode: Auto' } else { 'Mode: Manual' }
        Add-Check ($align.Count -ge 1 -and "$($align[0].resultText)" -match [regex]::Escape($modeLabel)) "$Mode /align result includes $modeLabel"
    }
    if ($ExpectTools) {
        $end = @(Get-Phase $records 'turn-end' | Select-Object -Last 1)
        Add-Check ($end.Count -eq 1 -and $end[0].baselineRecorded -and $end[0].revision -ge 1) "$Mode establish_baseline worked from the packed install (revision=$($end[0].revision))"
    }
    if ($ExpectPolicy) {
        $policy = Get-Phase $records 'policy'
        Add-Check ($policy.Count -ge 1 -and $policy[0].executed -and $policy[0].present) "$Mode assembled system prompt contains the requirements-alignment:policy section"
        Add-Check ($policy.Count -ge 1 -and $policy[0].textHead -match '## Requirements Alignment policy') "$Mode policy section text is the shipped drift-guard policy"
    } else {
        $policy = Get-Phase $records 'policy'
        Add-Check ($policy.Count -ge 1 -and $policy[0].executed -and -not $policy[0].present) "$Mode assembled system prompt has no requirements-alignment:policy section"
    }
}

try {
    $script:dsh = Resolve-DshLauncher
} catch {
    Write-Host "PACKED SMOKE ENVIRONMENT: $($_.Exception.Message)"
    Add-Check $false "dsh launcher available"
    $passed = @($script:results | Where-Object { $_ }).Count
    Write-Host ("PACKED SMOKE SUMMARY: $passed/" + $script:results.Count + " passed")
    exit 1
}

if (-not (Test-Path $dshHome)) {
    Write-Host "PACKED SMOKE ENVIRONMENT: isolated DSH_HOME not found at $dshHome"
    Add-Check $false "isolated DSH_HOME exists ($dshHome)"
    $passed = @($script:results | Where-Object { $_ }).Count
    Write-Host ("PACKED SMOKE SUMMARY: $passed/" + $script:results.Count + " passed")
    exit 1
}

$srcProfile = Join-Path $dshHome "profiles\align-headless"
if (-not (Test-Path $srcProfile)) {
    Write-Host "PACKED SMOKE ENVIRONMENT: align-headless profile skeleton missing at $srcProfile"
    Add-Check $false "align-headless profile skeleton exists"
    $passed = @($script:results | Where-Object { $_ }).Count
    Write-Host ("PACKED SMOKE SUMMARY: $passed/" + $script:results.Count + " passed")
    exit 1
}

$env:DSH_HOME = $dshHome
New-Item -ItemType Directory -Force -Path $tempRoot, $recordRoot | Out-Null

$pkg = Get-Content (Join-Path $pluginRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$pkg.version

# ---------------------------------------------------------------- 1. pack
$tarballs = @(Get-ChildItem $tempRoot -Filter 'dsh-requirements-alignment-*.tgz' -ErrorAction SilentlyContinue)
foreach ($old in $tarballs) { Remove-Item $old.FullName -Force }
Push-Location $pluginRoot
& pnpm pack --pack-destination $tempRoot 2>&1 | Out-Null
$packExit = $LASTEXITCODE
Pop-Location
Add-Check ($packExit -eq 0) 'pnpm pack succeeded'
$tarball = Get-ChildItem $tempRoot -Filter "dsh-requirements-alignment-$version.tgz" | Select-Object -First 1
Add-Check ($null -ne $tarball) "current tarball produced (dsh-requirements-alignment-$version.tgz)"
if ($null -eq $tarball) {
    $passed = @($script:results | Where-Object { $_ }).Count
    Write-Host ("PACKED SMOKE SUMMARY: $passed/" + $script:results.Count + " passed")
    exit 1
}

# ------------------------------------------------- 2. disposable profile
$dstProfile = Join-Path $dshHome "profiles\$profile"
if (Test-Path $dstProfile) { Remove-Item $dstProfile -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dstProfile | Out-Null
foreach ($file in @('package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'cordis.yml', 'cordis.patch.yml')) {
    Copy-Item (Join-Path $srcProfile $file) (Join-Path $dstProfile $file)
}
Push-Location $dstProfile
& pnpm install --offline 2>&1 | Out-Null
$installExit = $LASTEXITCODE
Pop-Location
Add-Check ($installExit -eq 0) 'disposable profile installed offline from the shared store'
$manifestPath = Join-Path $dstProfile 'package.json'

# ------------------------------------------------- 3. add the tarball
& $script:dsh plugin --profile $profile add $tarball.FullName --offline 2>&1 | Out-Null
Add-Check ($LASTEXITCODE -eq 0) "dsh plugin add <current $version tarball> succeeded"
$manifestAfterAdd = Get-Content $manifestPath -Raw | ConvertFrom-Json
$depSpec = $manifestAfterAdd.dependencies.'dsh-requirements-alignment'
Add-Check ($null -ne $depSpec -and $depSpec -match [regex]::Escape($version)) "dependency spec is the packed $version install (got: $depSpec)"

# ------------------------------------------------- 4. rows compose
$dump = & $script:dsh --profile $profile --dump-config 2>&1 | Out-String
Add-Check ($dump -match 'requirements-alignment' -and $dump -match 'requirements-alignment-ask-user') 'composed profile contains both plugin rows'

# ---------------------------------------------- 5. Auto → Manual → Off
Invoke-ModeBoot -Mode 'auto' -TarballName $tarball.Name -ExpectPolicy $true -ExpectTools $true -ExpectAlign $true
Invoke-ModeBoot -Mode 'manual' -TarballName $tarball.Name -ExpectPolicy $false -ExpectTools $true -ExpectAlign $true
Invoke-ModeBoot -Mode 'off' -TarballName $tarball.Name -ExpectPolicy $false -ExpectTools $false -ExpectAlign $false

# ---------------------------------------------- 6. remove and verify restore
& $script:dsh plugin --profile $profile rm dsh-requirements-alignment 2>&1 | Out-Null
Add-Check ($LASTEXITCODE -eq 0) 'dsh plugin rm succeeded'
$manifestAfterRm = Get-Content $manifestPath -Raw
Add-Check ($manifestAfterRm -notmatch 'dsh-requirements-alignment') 'manifest restored: no plugin dependency or bundle entry remains'
$ls = & $script:dsh plugin --profile $profile ls 2>&1 | Out-String
Add-Check ($ls -notmatch 'dsh-requirements-alignment') 'profile package list no longer contains the plugin'

# ---------------------------------------------------------------- cleanup
Remove-Item $dstProfile -Recurse -Force -ErrorAction SilentlyContinue

$passed = @($script:results | Where-Object { $_ }).Count
Write-Host ("PACKED SMOKE SUMMARY: $passed/" + $script:results.Count + " passed")
exit $(if ($passed -eq $script:results.Count -and $script:results.Count -gt 0) { 0 } else { 1 })
