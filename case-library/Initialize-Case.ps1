[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)][Alias("Case")][string]$CaseId,
    [string]$Version,
    [string]$DestinationRoot = (Join-Path ([Environment]::GetFolderPath("UserProfile")) "AgentRuns"),
    [switch]$PassThruJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$destinationFull = [System.IO.Path]::GetFullPath($DestinationRoot)
if ($destinationFull -match '(?i)(^|[\\/])[^\\/]*(test|bench)[^\\/]*($|[\\/])') {
    throw "Working root must not contain test or bench: $destinationFull"
}

$matches = @(
    Get-ChildItem -LiteralPath $PSScriptRoot -Filter "case.json" -File -Recurse |
        Where-Object { $_.FullName -notmatch '[\\/]\.tracelab-trash[\\/]' } |
        ForEach-Object {
            $document = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$document.case_id -eq $CaseId -and (-not $Version -or [string]$document.case_version -eq $Version)) {
                $parsedVersion = try { [version]([string]$document.case_version) } catch { [version]"0.0.0" }
                [pscustomobject]@{ File = $_.FullName; Document = $document; Version = $parsedVersion; CaseRoot = (Split-Path -Parent (Split-Path -Parent $_.FullName)) }
            }
        }
)
if ($matches.Count -eq 0) { throw "Case not found: $CaseId" }
if ($Version) {
    if ($matches.Count -gt 1) { throw "Case ID and version are not unique: $CaseId ($Version)" }
    $selected = $matches[0]
} else {
    $lineagePath = Join-Path $matches[0].CaseRoot "case-lineage.json"
    $preferredVersion = $null
    if (Test-Path -LiteralPath $lineagePath -PathType Leaf) {
        $lineage = Get-Content -LiteralPath $lineagePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $familyProperty = $lineage.families.PSObject.Properties[$CaseId]
        if ($familyProperty) { $preferredVersion = [string]$familyProperty.Value.preferred_version }
    }
    $preferred = @($matches | Where-Object { $preferredVersion -and [string]$_.Document.case_version -eq $preferredVersion })
    $selected = if ($preferred.Count -eq 1) { $preferred[0] } else { @($matches | Sort-Object Version -Descending)[0] }
}

$caseDirectory = Split-Path -Parent $selected.File
$suiteRoot = $caseDirectory
$deployScript = $null
while ($suiteRoot -and -not $suiteRoot.Equals($PSScriptRoot, [StringComparison]::OrdinalIgnoreCase)) {
    $candidate = Join-Path $suiteRoot "Deploy-Case.ps1"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $deployScript = $candidate; break }
    $suiteRoot = Split-Path -Parent $suiteRoot
}
if (-not $deployScript) { throw "Case safety-system deploy entrypoint is missing for: $($selected.File)" }

$result = & $deployScript -Case $CaseId -Version ([string]$selected.Document.case_version) -DestinationRoot $destinationFull
if ($PassThruJson) {
    $result | ConvertTo-Json -Depth 12 -Compress
} else {
    $result
}
