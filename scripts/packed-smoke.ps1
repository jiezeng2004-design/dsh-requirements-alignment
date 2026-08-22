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
$profile = 'packed-smoke-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$tempRoot = Join-Path $workspaceRoot '_packed-smoke'
$recordRoot = Join-Path $pluginRoot 'dogfood\records'
$utf8NoBom = New-Object Text.UTF8Encoding($false)
$script:results = @()
$script:scenarioDirs = @()

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

function Remove-ManagedDirectory {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$AllowedParent,
        [Parameter(Mandatory)][string]$LeafPattern
    )
    if (-not (Test-Path -LiteralPath $Path)) { return }

    $parentFull = [IO.Path]::GetFullPath($AllowedParent).TrimEnd('\', '/')
    $targetFull = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $targetParent = [IO.Path]::GetDirectoryName($targetFull).TrimEnd('\', '/')
    $leaf = [IO.Path]::GetFileName($targetFull)
    if (-not [string]::Equals($targetParent, $parentFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw "refusing cleanup outside the exact managed parent: target=$targetFull parent=$parentFull"
    }
    if ($leaf -notmatch $LeafPattern) {
        throw "refusing cleanup of an unexpected managed-directory name: $leaf"
    }

    $rootItem = Get-Item -LiteralPath $targetFull -Force -ErrorAction Stop
    if (-not $rootItem.PSIsContainer) { throw "cleanup target is not a directory: $targetFull" }
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "cleanup target is a reparse point: $targetFull"
    }

    $entryCount = 1
    $pending = New-Object 'Collections.Generic.Stack[string]'
    $pending.Push($targetFull)
    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        foreach ($child in @(Get-ChildItem -LiteralPath $current -Force -ErrorAction Stop)) {
            $entryCount++
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "cleanup tree contains a reparse point: $($child.FullName)"
            }
            if ($child.PSIsContainer) { $pending.Push($child.FullName) }
        }
    }

    Write-Host "cleanup target verified: $targetFull (directory, $entryCount entries, no reparse points)"
    Remove-Item -LiteralPath $targetFull -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $targetFull) { throw "cleanup did not remove the exact target: $targetFull" }
}

function Remove-ProfileDir {
    param([Parameter(Mandatory)][string]$Path)
    Remove-ManagedDirectory `
        -Path $Path `
        -AllowedParent (Join-Path $dshHome 'profiles') `
        -LeafPattern '^packed-smoke-[0-9a-f]{8}$'
}

function Read-Records([string]$Path) {
    if (-not (Test-Path $Path)) { return @() }
    return @(Get-Content $Path | ForEach-Object { $_ | ConvertFrom-Json })
}

function Get-FirstPhase($records, [string]$Phase) {
    foreach ($row in @($records)) {
        if ($null -eq $row) { continue }
        if ($row.PSObject.Properties.Name -contains 'phase' -and $row.phase -eq $Phase) { return $row }
    }
    return $null
}

function Get-LastPhase($records, [string]$Phase) {
    $match = $null
    foreach ($row in @($records)) {
        if ($null -eq $row) { continue }
        if ($row.PSObject.Properties.Name -contains 'phase' -and $row.phase -eq $Phase) { $match = $row }
    }
    return $match
}

function Get-Note([object]$Row, [string]$Name) {
    if ($null -eq $Row) { return $null }
    $prop = $Row.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}

function Reset-ModeState {
    param([Parameter(Mandatory)][string]$SettingsPath)
    # The shared runtime override persists in the DSH_HOME settings.yaml
    # (fourth mode layer); remove the requirements-alignment row so every
    # packed boot starts from ONLY its overlay profile-default mode.
    if (-not (Test-Path -LiteralPath $SettingsPath)) { return }
    $raw = [IO.File]::ReadAllText($SettingsPath)
    if ($raw -notmatch '(?m)^requirements-alignment:') { return }
    $newRaw = [regex]::Replace($raw, '(?m)^requirements-alignment:[^
]*(?:?
[ 	][^
]*)*?
?', '')
    [IO.File]::WriteAllText($SettingsPath, $newRaw, $utf8NoBom)
    Write-Host "reset persisted shared-mode rows in $SettingsPath"
}

function Invoke-ModeBoot {
    param(
        [Parameter(Mandatory)][string]$Mode,
        [Parameter(Mandatory)][string]$TarballName,
        [Parameter(Mandatory)][bool]$ExpectPolicy,
        [Parameter(Mandatory)][bool]$ExpectTools,
        [Parameter(Mandatory)][bool]$ExpectAlign,
        [string]$SwitchTo = ''
    )
    $scenarioName = "$profile-$Mode"
    $scenarioDir = Join-Path $pluginRoot "dogfood\scenarios\$scenarioName"
    if (Test-Path -LiteralPath $scenarioDir) {
        throw "refusing to reuse an existing per-run scenario directory: $scenarioDir"
    }
    New-Item -ItemType Directory -Force -Path $scenarioDir | Out-Null
    $script:scenarioDirs += $scenarioDir
    Copy-Item (Join-Path $pluginRoot 'dogfood\fixtures\02-typo\*') $scenarioDir -Recurse -Force
    $recordPath = Join-Path $recordRoot "packed-smoke-$Mode.jsonl"
    if (Test-Path $recordPath) { Remove-Item $recordPath -Force }
    $yamlRecordPath = $recordPath.Replace("'", "''")
    $runAlign = if ($ExpectAlign) { 'true' } else { 'false' }
    $runBaselineProbe = if ($ExpectTools) { 'true' } else { 'false' }
    $switchLine = if ($SwitchTo) { "        switchSharedModeTo: '$SwitchTo'" } else { '' }
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
        runBaselineProbe: $runBaselineProbe
        verifyPolicySection: true
        verifyRegistrations: true
$switchLine
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
    $outputText = $output | Out-String
    $quotaUnavailable = $exit -ne 0 -and $outputText -match 'QUOTA:\s*Insufficient Balance'
    Add-Check ($exit -eq 0 -or $quotaUnavailable) $(
        if ($quotaUnavailable) {
            "$Mode packed profile booted; external model completion unavailable (QUOTA)"
        } else {
            "$Mode packed profile booted and completed the task (exit $exit)"
        }
    )
    $records = @(Read-Records $recordPath)
    $reg = Get-FirstPhase $records 'registrations'
    $regOk = $null -ne $reg -and [bool](Get-Note $reg 'executed')
    Add-Check $regOk "$Mode registrations recorded from live registries"
    if ($regOk) {
        $tools = @()
        $toolsValue = Get-Note $reg 'tools'
        if ($null -ne $toolsValue) { $tools = @($toolsValue) }
        $hasTools = ($tools -contains 'establish_baseline') -and ($tools -contains 'report_drift')
        $policyValue = [bool](Get-Note $reg 'policy')
        $alignValue = [bool](Get-Note $reg 'align')
        Add-Check (($policyValue -eq $ExpectPolicy)) "$Mode policy section present=$ExpectPolicy (assembled system prompt; got $policyValue)"
        Add-Check (($hasTools -eq $ExpectTools)) "$Mode alignment tools present=$ExpectTools (got: $($tools -join ','))"
        Add-Check (($alignValue -eq $ExpectAlign)) "$Mode /align registered=$ExpectAlign (got $alignValue)"
        $alignModeValue = [bool](Get-Note $reg 'alignMode')
        Add-Check $alignModeValue "$Mode /align-mode registered (always-on control command; got $alignModeValue)"
    } else {
        Add-Check $false "$Mode policy section present=$ExpectPolicy (no registrations record)"
        Add-Check $false "$Mode alignment tools present=$ExpectTools (no registrations record)"
        Add-Check $false "$Mode /align registered=$ExpectAlign (no registrations record)"
        Add-Check $false "$Mode /align-mode registered (no registrations record)"
    }
    if ($ExpectAlign) {
        $align = Get-FirstPhase $records 'align'
        Add-Check (($null -ne $align) -and [bool](Get-Note $align 'executed') -and ((Get-Note $align 'resultKind') -eq 'success')) "$Mode /align executed through the real commands registry"
        $modeLabel = if ($Mode -eq 'auto') { 'Mode: Auto' } else { 'Mode: Manual' }
        Add-Check (($null -ne $align) -and ("$(Get-Note $align 'resultText')" -match [regex]::Escape($modeLabel))) "$Mode /align result includes $modeLabel"
    }
    if ($ExpectTools) {
        $probe = Get-FirstPhase $records 'baseline-probe'
        Add-Check (($null -ne $probe) -and [bool](Get-Note $probe 'executed') -and -not [bool](Get-Note $probe 'isError') -and [bool](Get-Note $probe 'baselineRecorded') -and ([int](Get-Note $probe 'revision') -ge 1)) "$Mode establish_baseline worked through the packed install's real tools registry (revision=$(Get-Note $probe 'revision'))"
    }
    $policy = Get-FirstPhase $records 'policy'
    if ($ExpectPolicy) {
        Add-Check (($null -ne $policy) -and [bool](Get-Note $policy 'executed') -and [bool](Get-Note $policy 'present')) "$Mode assembled system prompt contains the requirements-alignment:policy section"
        Add-Check (($null -ne $policy) -and ("$(Get-Note $policy 'textHead')" -match '## Requirements Alignment policy')) "$Mode policy section text is the shipped drift-guard policy"
    } else {
        Add-Check (($null -ne $policy) -and [bool](Get-Note $policy 'executed') -and -not [bool](Get-Note $policy 'present')) "$Mode assembled system prompt has no requirements-alignment:policy section"
    }
    # v0.4.1 mode-switch probe: boot in $Mode, run the REAL /align-mode command
    # to switch the shared layer to $SwitchTo, and verify the capability matrix
    # after the switch (transactional commitment: source AND live capabilities
    # converge, effective mode matches).
    if ($SwitchTo) {
        $before = Get-FirstPhase $records 'switch-before'
        $sw = Get-FirstPhase $records 'mode-switch'
        $after = Get-FirstPhase $records 'switch-after'
        Add-Check (($null -ne $before) -and [bool](Get-Note $before 'executed')) "$Mode switch-before registrations recorded"
        Add-Check (($null -ne $sw) -and [bool](Get-Note $sw 'executed') -and ((Get-Note $sw 'resultKind') -eq 'success')) "$Mode /align-mode $SwitchTo executed through the real commands registry"
        $switchLabel = switch ($SwitchTo) { 'auto' { 'Auto' } 'manual' { 'Manual' } 'off' { 'Off' } }
        Add-Check (($null -ne $sw) -and ("$(Get-Note $sw 'resultText')" -match [regex]::Escape("Switched to $switchLabel"))) "$Mode /align-mode result claims the switch to $switchLabel"
        $afterOk = ($null -ne $after) -and [bool](Get-Note $after 'executed')
        Add-Check $afterOk "$Mode switch-after registrations recorded"
        if ($afterOk) {
            $expPolicyAfter = ($SwitchTo -eq 'auto')
            $expToolsAfter = ($SwitchTo -ne 'off')
            $expAlignAfter = ($SwitchTo -ne 'off')
            $afterTools = @()
            $afterToolsValue = Get-Note $after 'tools'
            if ($null -ne $afterToolsValue) { $afterTools = @($afterToolsValue) }
            Add-Check ([bool](Get-Note $after 'policy') -eq $expPolicyAfter) "$Mode after switch to $SwitchTo policy present=$expPolicyAfter (got $(Get-Note $after 'policy'))"
            Add-Check (((($afterTools -contains 'establish_baseline') -and ($afterTools -contains 'report_drift')) -eq $expToolsAfter)) "$Mode after switch to $SwitchTo alignment tools present=$expToolsAfter (got: $($afterTools -join ','))"
            Add-Check ([bool](Get-Note $after 'align') -eq $expAlignAfter) "$Mode after switch to $SwitchTo /align registered=$expAlignAfter (got $(Get-Note $after 'align'))"
            $afterEffective = "$(Get-Note $after 'effective')"
            Add-Check ($afterEffective -match [regex]::Escape("$SwitchTo/")) "$Mode after switch to $SwitchTo effective mode is $SwitchTo (got $afterEffective)"
        } else {
            Add-Check $false "$Mode after switch to $SwitchTo policy present"
            Add-Check $false "$Mode after switch to $SwitchTo alignment tools present"
            Add-Check $false "$Mode after switch to $SwitchTo /align registered"
            Add-Check $false "$Mode after switch to $SwitchTo effective mode is $SwitchTo"
        }
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
$currentTarballPath = Join-Path $tempRoot "dsh-requirements-alignment-$version.tgz"
if (Test-Path -LiteralPath $currentTarballPath) {
    Remove-Item -LiteralPath $currentTarballPath -Force -ErrorAction Stop
}
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
Remove-ProfileDir $dstProfile
New-Item -ItemType Directory -Force -Path $dstProfile | Out-Null
foreach ($file in @('package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'cordis.yml', 'cordis.patch.yml')) {
    Copy-Item (Join-Path $srcProfile $file) (Join-Path $dstProfile $file)
}
$manifestPath = Join-Path $dstProfile 'package.json'
$cleanManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$cleanManifest.dependencies.PSObject.Properties.Remove('dsh-requirements-alignment')
$cleanManifest.dsh.profile.bundles = @(
    $cleanManifest.dsh.profile.bundles | Where-Object { $_ -ne 'dsh-requirements-alignment' }
)
[IO.File]::WriteAllText(
    $manifestPath,
    (($cleanManifest | ConvertTo-Json -Depth 10) + [Environment]::NewLine),
    $utf8NoBom
)
Push-Location $dstProfile
& pnpm install --offline 2>&1 | Out-Null
$installExit = $LASTEXITCODE
Pop-Location
Add-Check ($installExit -eq 0) 'disposable profile installed offline from the shared store'
# rc.1 runtime guard: the disposable profile must resolve the SAME 0.1.1-rc.1
# DSH family the plugin pins (no range drift, no stale rc.x runtime).
$runtimeChecks = @(
    @{ Name = 'dsh-headless'; Path = Join-Path $dstProfile 'node_modules\@deepseek-ai\dsh-headless\package.json' },
    @{ Name = 'dsh-commands'; Path = Join-Path $dstProfile 'node_modules\@deepseek-ai\dsh-commands\package.json' },
    @{ Name = 'dsh-base';     Path = Join-Path $dstProfile 'node_modules\@deepseek-ai\dsh-base\package.json' }
)
foreach ($rc in $runtimeChecks) {
    $rcVer = ''
    if (Test-Path -LiteralPath $rc.Path) {
        $rcVer = [string](Get-Content -LiteralPath $rc.Path -Raw | ConvertFrom-Json).version
    }
    Add-Check ($rcVer -eq '0.1.1-rc.1') "disposable $($rc.Name) runtime is 0.1.1-rc.1 (got: $(if ($rcVer) { $rcVer } else { 'missing' }))"
}
$preexistingInstall = Join-Path $dstProfile 'node_modules\dsh-requirements-alignment'
Add-Check (-not (Test-Path -LiteralPath $preexistingInstall)) 'disposable profile starts without a workspace-linked plugin'

# ------------------------------------------------- 3. add the tarball
& $script:dsh plugin --profile $profile add $tarball.FullName --offline 2>&1 | Out-Null
Add-Check ($LASTEXITCODE -eq 0) "dsh plugin add <current $version tarball> succeeded"
$manifestAfterAdd = Get-Content $manifestPath -Raw | ConvertFrom-Json
$depSpec = $manifestAfterAdd.dependencies.'dsh-requirements-alignment'
Add-Check ($null -ne $depSpec -and $depSpec -match [regex]::Escape($version)) "dependency spec is the packed $version install (got: $depSpec)"
$installedPath = Join-Path $dstProfile 'node_modules\dsh-requirements-alignment'
$installedItem = Get-Item -LiteralPath $installedPath -Force -ErrorAction Stop
$installedManifest = Get-Content -LiteralPath (Join-Path $installedPath 'package.json') -Raw | ConvertFrom-Json
Add-Check ([string]$installedManifest.version -eq $version) "installed package reports version $version"
$sourceFull = [IO.Path]::GetFullPath($pluginRoot).TrimEnd('\', '/')
$installedTargets = @($installedItem.Target | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | ForEach-Object {
    [IO.Path]::GetFullPath([string]$_).TrimEnd('\', '/')
})
$pointsAtSource = @($installedTargets | Where-Object {
    [string]::Equals($_, $sourceFull, [StringComparison]::OrdinalIgnoreCase)
}).Count -gt 0
$installedLocation = if ($installedTargets.Count -eq 0) { 'regular directory' } else { $installedTargets -join ',' }
Add-Check (-not $pointsAtSource) "installed package is isolated from the source checkout ($installedLocation)"

# ------------------------------------------------- 4. rows compose
$dump = & $script:dsh --profile $profile --dump-config 2>&1 | Out-String
Add-Check ($dump -match 'requirements-alignment' -and $dump -match 'requirements-alignment-ask-user') 'composed profile contains both plugin rows'

# ---------------------------------------------- Off → Auto → Manual
# Each boot starts from ONLY its overlay profile-default mode (the shared
# runtime override persists in the DSH_HOME settings layer between boots, so
# the persisted mode is reset before every boot). The OFF boot runs FIRST,
# before any switch can persist an override, keeping it fully deterministic.
Reset-ModeState (Join-Path $dshHome 'settings.yaml')
Invoke-ModeBoot -Mode 'off' -TarballName $tarball.Name -ExpectPolicy $false -ExpectTools $false -ExpectAlign $false
# B (v0.4.1): boot Auto, switch the shared layer to Manual through the REAL
# /align-mode command, verify the effective mode + capability matrix follow.
Reset-ModeState (Join-Path $dshHome 'settings.yaml')
Invoke-ModeBoot -Mode 'auto' -TarballName $tarball.Name -ExpectPolicy $true -ExpectTools $true -ExpectAlign $true -SwitchTo 'manual'
# A (v0.4.1): boot Manual, switch to Auto, verify the full auto matrix lands.
Reset-ModeState (Join-Path $dshHome 'settings.yaml')
Invoke-ModeBoot -Mode 'manual' -TarballName $tarball.Name -ExpectPolicy $false -ExpectTools $true -ExpectAlign $true -SwitchTo 'auto'

# ---------------------------------------------- 6. remove and verify restore
& $script:dsh plugin --profile $profile rm dsh-requirements-alignment
Add-Check ($LASTEXITCODE -eq 0) 'dsh plugin rm succeeded'
$manifestAfterRm = Get-Content $manifestPath -Raw
Add-Check ($manifestAfterRm -notmatch 'dsh-requirements-alignment') 'manifest restored: no plugin dependency or bundle entry remains'
$ls = & $script:dsh plugin --profile $profile ls 2>&1 | Out-String
Add-Check ($ls -notmatch 'dsh-requirements-alignment') 'profile package list no longer contains the plugin'

# ---------------------------------------------------------------- cleanup
Remove-ProfileDir $dstProfile
foreach ($scenarioDir in $script:scenarioDirs) {
    Remove-ManagedDirectory `
        -Path $scenarioDir `
        -AllowedParent (Join-Path $pluginRoot 'dogfood\scenarios') `
        -LeafPattern '^packed-smoke-[0-9a-f]{8}-(auto|manual|off)$'
}

$passed = @($script:results | Where-Object { $_ }).Count
Write-Host ("PACKED SMOKE SUMMARY: $passed/" + $script:results.Count + " passed")
exit $(if ($passed -eq $script:results.Count -and $script:results.Count -gt 0) { 0 } else { 1 })
