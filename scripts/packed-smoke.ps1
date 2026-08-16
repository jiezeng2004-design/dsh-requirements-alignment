#requires -Version 5.1
<#
.SYNOPSIS
    v0.2.0 packed add/rm smoke: packs the CURRENT v0.2 tarball, installs it
    into a disposable profile under the isolated DSH_HOME, boots a real
    headless task through it (rows compose, /align executes, establish_baseline
    works, the policy section is present in the ASSEMBLED system prompt —
    verified via the section registry, not a loose word match), then removes
    it and verifies the profile returns to a clean state with no dangling
    plugin references. Run after `pnpm run check` (the pack ships the fresh
    lib/ build).
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

$dsh = Resolve-DshLauncher
$env:DSH_HOME = $dshHome
New-Item -ItemType Directory -Force -Path $tempRoot, $recordRoot | Out-Null

# ---------------------------------------------------------------- 1. pack
$tarballs = @(Get-ChildItem $tempRoot -Filter 'dsh-requirements-alignment-*.tgz' -ErrorAction SilentlyContinue)
foreach ($old in $tarballs) { Remove-Item $old.FullName -Force }
Push-Location $pluginRoot
& pnpm pack --pack-destination $tempRoot 2>&1 | Out-Null
$packExit = $LASTEXITCODE
Pop-Location
Add-Check ($packExit -eq 0) 'pnpm pack succeeded'
$tarball = Get-ChildItem $tempRoot -Filter 'dsh-requirements-alignment-0.2.0.tgz' | Select-Object -First 1
Add-Check ($null -ne $tarball) 'v0.2.0 tarball produced'

# ------------------------------------------------- 2. disposable profile
# Copy the profile SKELETON (no node_modules - deep nested links break
# recursive copy) and install offline from the shared pnpm store.
$srcProfile = Join-Path $dshHome "profiles\align-headless"
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
& $dsh plugin --profile $profile add $tarball.FullName --offline 2>&1 | Out-Null
Add-Check ($LASTEXITCODE -eq 0) 'dsh plugin add <v0.2 tarball> succeeded'
$manifestAfterAdd = Get-Content $manifestPath -Raw | ConvertFrom-Json
$depSpec = $manifestAfterAdd.dependencies.'dsh-requirements-alignment'
Add-Check ($null -ne $depSpec -and $depSpec -match '0\.2\.0') "dependency spec is the packed 0.2.0 install (got: $depSpec)"

# ------------------------------------------------- 4. rows compose
$dump = & $dsh --profile $profile --dump-config 2>&1 | Out-String
Add-Check ($dump -match 'requirements-alignment' -and $dump -match 'requirements-alignment-ask-user') 'composed profile contains both plugin rows'

# ---------------------------------------------- 5. boot: commands/tools/policy
$scenarioDir = Join-Path $pluginRoot 'dogfood\scenarios\packed-smoke'
if (Test-Path $scenarioDir) { Remove-Item (Join-Path $scenarioDir '*') -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $scenarioDir | Out-Null
Copy-Item (Join-Path $pluginRoot 'dogfood\fixtures\02-typo\*') $scenarioDir -Recurse -Force
$recordPath = Join-Path $recordRoot 'packed-smoke.jsonl'
if (Test-Path $recordPath) { Remove-Item $recordPath -Force }
$yamlRecordPath = $recordPath.Replace("'", "''")
$overlay = @"
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
        runAlign: true
        verifyPolicySection: true
"@
$overlayPath = Join-Path $tempRoot 'packed-smoke-overlay.yml'
[IO.File]::WriteAllText($overlayPath, $overlay, $utf8NoBom)
$task = "Fix the typo in README.md. Before fixing, call establish_baseline with goal 'Fix the typo in README.md' and explicitConstraints ['typo fix only']. Then fix the typo."
Push-Location $scenarioDir
$output = & $dsh --profile $profile --patch $overlayPath $task 2>&1
$exit = $LASTEXITCODE
Pop-Location
Add-Check ($exit -eq 0) "packed profile booted and completed the task (exit $exit)"
$records = @()
if (Test-Path $recordPath) { $records = Get-Content $recordPath | ForEach-Object { $_ | ConvertFrom-Json } }
$align = @($records | Where-Object { $_.PSObject.Properties.Name -contains 'phase' -and $_.phase -eq 'align' })
Add-Check ($align.Count -ge 1 -and $align[0].executed -and $align[0].resultKind -eq 'success') '/align executed through the real commands registry'
$end = @($records | Where-Object { $_.PSObject.Properties.Name -contains 'phase' -and $_.phase -eq 'turn-end' } | Select-Object -Last 1)
Add-Check ($end.Count -eq 1 -and $end[0].baselineRecorded -and $end[0].revision -ge 1) "establish_baseline worked from the packed install (revision=$($end[0].revision))"
# Policy presence, verified deterministically: the driver assembled the REAL
# system prompt for the session and inspected the section registry. The
# section exists by its exact plugin name and its resolved text starts with
# the shipped policy heading - a loose word-match on the final answer can be
# false-positived by the task prompt itself, so it is no longer the gate.
$policy = @($records | Where-Object { $_.PSObject.Properties.Name -contains 'phase' -and $_.phase -eq 'policy' })
Add-Check ($policy.Count -ge 1 -and $policy[0].executed -and $policy[0].present) 'assembled system prompt contains the requirements-alignment:policy section (section registry)'
Add-Check ($policy.Count -ge 1 -and $policy[0].textHead -match '## Requirements Alignment policy') 'policy section text is the shipped drift-guard policy (unique heading in the assembled prompt)'

# ---------------------------------------------- 6. remove and verify restore
& $dsh plugin --profile $profile rm dsh-requirements-alignment 2>&1 | Out-Null
Add-Check ($LASTEXITCODE -eq 0) 'dsh plugin rm succeeded'
$manifestAfterRm = Get-Content $manifestPath -Raw
Add-Check ($manifestAfterRm -notmatch 'dsh-requirements-alignment') 'manifest restored: no plugin dependency or bundle entry remains'
$ls = & $dsh plugin --profile $profile ls 2>&1 | Out-String
Add-Check ($ls -notmatch 'dsh-requirements-alignment') 'profile package list no longer contains the plugin'

# ---------------------------------------------------------------- cleanup
Remove-Item $dstProfile -Recurse -Force -ErrorAction SilentlyContinue

$passed = @($script:results | Where-Object { $_ }).Count
Write-Host ("PACKED SMOKE SUMMARY: $passed/" + $script:results.Count + " passed")
exit $(if ($passed -eq $script:results.Count -and $script:results.Count -gt 0) { 0 } else { 1 })
