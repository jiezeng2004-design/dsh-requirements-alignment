#requires -Version 5.1
<#
.SYNOPSIS
    Real DSH dogfooding for dsh-requirements-alignment: boots the align-headless
    profile (dsh-base + dsh-headless + this plugin + scripted answer provider)
    through the real 'dsh' launcher and runs the five behavioral scenarios.
    Uses an isolated DSH_HOME under the workspace. Credentials are copied
    from the real home and never printed.
#>
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $pluginRoot
$dshHome = Join-Path $workspaceRoot '.dsh-dogfood'
$scenarioRoot = Join-Path $pluginRoot 'dogfood\scenarios'
$overlayRoot = Join-Path $pluginRoot 'dogfood\overlays'
$recordRoot = Join-Path $pluginRoot 'dogfood\records'
$logRoot = Join-Path $pluginRoot 'dogfood\logs'
$renderedOverlayRoot = Join-Path $logRoot 'rendered-overlays'
$profile = 'align-headless'
$utf8NoBom = New-Object Text.UTF8Encoding($false)
New-Item -ItemType Directory -Force -Path $recordRoot, $logRoot, $renderedOverlayRoot | Out-Null
function Reset-Scenario {
    param([Parameter(Mandatory)][string]$Name)
    $dir = Join-Path $scenarioRoot $Name
    $fixture = Join-Path (Join-Path $pluginRoot 'dogfood\fixtures') $Name
    if (Test-Path $dir) { Remove-Item (Join-Path $dir '*') -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    if (Test-Path $fixture) { Copy-Item (Join-Path $fixture '*') $dir -Recurse -Force }
}
function Write-Log([string]$Name, [string]$Text) { [IO.File]::WriteAllText((Join-Path $logRoot $Name), $Text, $utf8NoBom) }
function Invoke-Scenario {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Task,
        [Parameter(Mandatory)][string]$WorkDir,
        [Parameter(Mandatory)][string]$Overlay,
        [Parameter(Mandatory)][string]$RecordFile,
        [Parameter(Mandatory)][int]$ExpectRoundsMin,
        [Parameter(Mandatory)][int]$ExpectRoundsMax,
        [string]$QuestionTopicPattern = ''
    )
    Reset-Scenario $Name
    $recordPath = Join-Path $recordRoot $RecordFile
    if (Test-Path $recordPath) { Remove-Item $recordPath -Force }
    $overlayPath = Join-Path $overlayRoot $Overlay
    $renderedOverlayPath = Join-Path $renderedOverlayRoot $Overlay
    $overlayToken = '__DOGFOOD_RECORD_PATH__'
    $overlayText = [IO.File]::ReadAllText($overlayPath)
    if (-not $overlayText.Contains($overlayToken)) { throw "Overlay $Overlay is missing $overlayToken" }
    $yamlRecordPath = $recordPath.Replace("'", "''")
    $renderedOverlayText = $overlayText.Replace($overlayToken, $yamlRecordPath)
    [IO.File]::WriteAllText($renderedOverlayPath, $renderedOverlayText, $utf8NoBom)
    $env:DSH_HOME = $dshHome
    Push-Location $WorkDir
    $output = & dsh --profile $profile --patch $renderedOverlayPath $Task 2>&1
    Pop-Location
    $exit = $LASTEXITCODE
    $text = ($output | Out-String)
    Write-Log ("$Name.out.txt") $text
    Write-Log ("$Name.exit.txt") $exit
    $asked = @()
    if (Test-Path $recordPath) { $asked = Get-Content $recordPath | ForEach-Object { $_ | ConvertFrom-Json } }
    Write-Log ("$Name.asked.json") ($asked | ConvertTo-Json -Depth 5)
    $rounds = @($asked).Count
    $ok = $true
    $reasons = @()
    if ($exit -ne 0) { $ok = $false; $reasons += "exit code $exit (expected 0)" }
    if ($rounds -lt $ExpectRoundsMin -or $rounds -gt $ExpectRoundsMax) {
        $ok = $false; $reasons += "question rounds $rounds (expected $ExpectRoundsMin..$ExpectRoundsMax)"
    }
    if ($QuestionTopicPattern -ne '' -and $rounds -gt 0) {
        $all = ($asked | ForEach-Object { $_.question }) -join ' | '
        if ($all -notmatch $QuestionTopicPattern) {
            $ok = $false; $reasons += "question topic did not match /$QuestionTopicPattern/: $all"
        }
    }
    Write-Host ("[$(if ($ok) { 'PASS' } else { 'FAIL' })] $Name : rounds=$rounds exit=$exit" + $(if ($reasons.Count) { ' :: ' + ($reasons -join '; ') } else { '' }))
    return $ok
}

$results = @()
$results += Invoke-Scenario -Name '01-greenfield' -Task 'Build me a personal task manager.' -WorkDir (Join-Path $scenarioRoot '01-greenfield') -Overlay '01-greenfield.yml' -RecordFile '01-greenfield.jsonl' -ExpectRoundsMin 1 -ExpectRoundsMax 3 -QuestionTopicPattern 'form|use|web|desktop|mobile|scope|mvp|first version'
$results += Invoke-Scenario -Name '02-typo' -Task 'Fix the typo in README.md.' -WorkDir (Join-Path $scenarioRoot '02-typo') -Overlay '02-typo.yml' -RecordFile '02-typo.jsonl' -ExpectRoundsMin 0 -ExpectRoundsMax 0
$results += Invoke-Scenario -Name '03-bugfix' -Task 'The submit button throws TypeError when form.email is undefined. Fix it without changing the UI.' -WorkDir (Join-Path $scenarioRoot '03-bugfix') -Overlay '03-bugfix.yml' -RecordFile '03-bugfix.jsonl' -ExpectRoundsMin 0 -ExpectRoundsMax 0
$results += Invoke-Scenario -Name '04-pick-whatever' -Task 'Build me an AI tool that can make money. Pick whatever makes sense.' -WorkDir (Join-Path $scenarioRoot '04-pick-whatever') -Overlay '04-pick-whatever.yml' -RecordFile '04-pick-whatever.jsonl' -ExpectRoundsMin 1 -ExpectRoundsMax 3 -QuestionTopicPattern 'user|target|audience|who|product|idea|tool'
Reset-Scenario '02-typo'
$run6 = Invoke-Scenario -Name '06-align' -Task 'Fix the typo in README.md.' -WorkDir (Join-Path $scenarioRoot '02-typo') -Overlay '06-align.yml' -RecordFile '06-align.jsonl' -ExpectRoundsMin 0 -ExpectRoundsMax 2
$alignOk = $true
$driverPath = Join-Path $recordRoot '06-align.jsonl'
if (Test-Path $driverPath) {
    $driver = Get-Content $driverPath | Select-Object -First 1 | ConvertFrom-Json
    if (-not $driver.executed) { $alignOk = $false; Write-Host '[FAIL] 06-align : /align did not execute' }
    elseif ($driver.resultKind -ne 'success') { $alignOk = $false; Write-Host '[FAIL] 06-align : resultKind=' $driver.resultKind }
    elseif ($driver.alignCommandRuns -lt 1) { $alignOk = $false; Write-Host '[FAIL] 06-align : no command/run event recorded' }
    elseif (-not $driver.lastManualCheckAt) { $alignOk = $false; Write-Host '[FAIL] 06-align : no manual check recorded' }
    else { Write-Host '[PASS] 06-align : /align executed (command/run=1, manual check recorded, status="' $driver.resultText '")' }
} else {
    $alignOk = $false
    Write-Host '[FAIL] 06-align : driver record missing'
}
$results += ($run6 -and $alignOk)
# removed duplicate 05 invocation
$results += Invoke-Scenario -Name '05-realign' -Task 'Now make it support multiple users across devices.' -WorkDir (Join-Path $scenarioRoot '05-realign') -Overlay '05-realign.yml' -RecordFile '05-realign.jsonl' -ExpectRoundsMin 1 -ExpectRoundsMax 3 -QuestionTopicPattern 'account|user|sync|cloud|login|identity|multi'

$passed = @($results | Where-Object { $_ }).Count
Write-Host ("DOGFOOD SUMMARY: $passed/" + $results.Count + " passed")
exit $(if ($passed -eq $results.Count) { 0 } else { 1 })
