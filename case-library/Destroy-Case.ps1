[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory, Position = 0)][string]$DeploymentPath,
    [switch]$PassThruJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$target = [System.IO.Path]::GetFullPath($DeploymentPath)
$markerPath = Join-Path $target ".aetf-fixture-deployment.json"
if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    throw "Deployment ownership marker is missing: $markerPath"
}
$marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($marker.format -ne "aetf-fixture-deployment") { throw "Deployment marker format is invalid." }

$matches = @(
    Get-ChildItem -LiteralPath $PSScriptRoot -Filter "case.json" -File -Recurse |
        Where-Object { $_.FullName -notmatch '[\\/]\.tracelab-trash[\\/]' } |
        ForEach-Object {
            $document = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$document.case_id -eq [string]$marker.case_id) {
                [pscustomobject]@{ File = $_.FullName; Document = $document }
            }
        }
)
$markerVersion = if ($marker.PSObject.Properties.Name -contains "case_version") { [string]$marker.case_version } else { "<unspecified>" }
if ($markerVersion -ne "<unspecified>") {
    $matches = @($matches | Where-Object { [string]$_.Document.case_version -eq [string]$marker.case_version })
}
if ($matches.Count -eq 0) { throw "Could not locate Case suite/version: $($marker.case_id) $markerVersion" }
if ($matches.Count -gt 1) {
    $matches = @($matches | Sort-Object { try { [version]([string]$_.Document.case_version) } catch { [version]"0.0.0" } } -Descending | Select-Object -First 1)
}

$caseDirectory = Split-Path -Parent $matches[0].File
$suiteRoot = $caseDirectory
$destroyScript = $null
while ($suiteRoot -and -not $suiteRoot.Equals($PSScriptRoot, [StringComparison]::OrdinalIgnoreCase)) {
    $candidate = Join-Path $suiteRoot "Destroy-Case.ps1"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $destroyScript = $candidate; break }
    $suiteRoot = Split-Path -Parent $suiteRoot
}
if (-not $destroyScript) { throw "Case safety-system destroy entrypoint is missing for: $($matches[0].File)" }

$result = & $destroyScript -DeploymentPath $target -Confirm:$false
if ($PassThruJson) {
    $result | ConvertTo-Json -Depth 12 -Compress
} else {
    $result
}
