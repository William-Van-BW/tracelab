[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory, Position = 0)]
    [string]$DeploymentPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "FixtureTools.psm1") -Force

$target = Get-AetfFullPath -Path $DeploymentPath
if (-not (Test-Path -LiteralPath $target -PathType Container)) { throw "部署目录不存在：$target" }
$caseParent = Split-Path -Parent $target
$deploymentsRoot = Split-Path -Parent $caseParent
$destinationRoot = Split-Path -Parent $deploymentsRoot
if ((Split-Path -Leaf $deploymentsRoot) -ne "deployments") {
    throw "部署目录结构不符合约定，拒绝销毁：$target"
}
$target = Assert-AetfPathUnderRoot -Path $target -Root $deploymentsRoot
$markerPath = Join-Path $target ".aetf-fixture-deployment.json"
if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    throw "缺少清理标记，拒绝递归删除：$markerPath"
}
$marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($marker.format -ne "aetf-fixture-deployment") { throw "清理标记格式无效，拒绝销毁。" }
if (-not (Get-AetfFullPath -Path $marker.root_path).Equals($target, [StringComparison]::OrdinalIgnoreCase)) {
    throw "清理标记中的 root_path 与目标不一致，拒绝销毁。"
}
$ownershipRoot = Join-Path $destinationRoot ".ownership"
$ownershipPath = Assert-AetfPathUnderRoot -Path (Get-AetfFullPath -Path $marker.ownership_record_path) -Root $ownershipRoot
if (-not (Test-Path -LiteralPath $ownershipPath -PathType Leaf)) {
    throw "缺少外部所有权记录，拒绝销毁：$ownershipPath"
}
$ownership = Get-Content -LiteralPath $ownershipPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($ownership.cleanup_token -ne $marker.cleanup_token -or $ownership.deployment_id -ne $marker.deployment_id) {
    throw "所有权记录与部署标记不匹配，拒绝销毁。"
}

$baseline = Get-Content -LiteralPath $marker.baseline_manifest_path -Raw -Encoding UTF8 | ConvertFrom-Json
$finalEntries = Get-AetfStateEntries -RootBindings $marker.root_bindings
$changes = @(Compare-AetfStateEntries -Before @($baseline.entries) -After $finalEntries)
$caseHashBytes = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes([string]$marker.case_id))
$caseStorageKey = if ($marker.PSObject.Properties.Name -contains "storage_key") { [string]$marker.storage_key } else { "case_" + ([System.BitConverter]::ToString($caseHashBytes).Replace("-", "").Substring(0, 12).ToLowerInvariant()) }
$evidenceRoot = Join-Path $destinationRoot "records"
$evidencePath = Join-Path (Join-Path $evidenceRoot $caseStorageKey) $marker.deployment_id
$evidencePath = Assert-AetfPathUnderRoot -Path $evidencePath -Root $evidenceRoot
New-Item -ItemType Directory -Path $evidencePath -Force | Out-Null
Write-AetfJson -Path (Join-Path $evidencePath "baseline-state.json") -Value $baseline
Write-AetfJson -Path (Join-Path $evidencePath "final-state.json") -Value @{
    document_type = "fixture_state"; spec_version = "0.3.2"; deployment_id = $marker.deployment_id
    captured_at = [DateTime]::UtcNow.ToString("o"); entries = $finalEntries
}
Write-AetfJson -Path (Join-Path $evidencePath "changes.json") -Value @{
    document_type = "fixture_change_set"; spec_version = "0.3.2"
    deployment_id = $marker.deployment_id; case_id = $marker.case_id
    detected_at = [DateTime]::UtcNow.ToString("o")
    change_count = $changes.Count; changes = $changes
}
Write-AetfJson -Path (Join-Path $evidencePath "deployment-record.json") -Value $marker

if ($PSCmdlet.ShouldProcess($target, "保存最终证据后销毁 AETF fixture 部署")) {
    $reparsePoints = [System.Collections.Generic.List[string]]::new()
    $queue = [System.Collections.Generic.Queue[string]]::new()
    $queue.Enqueue($target)
    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        foreach ($item in Get-ChildItem -LiteralPath $current -Directory -Force) {
            $itemPath = Assert-AetfPathUnderRoot -Path $item.FullName -Root $target
            $isReparse = (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
            if ($isReparse) { $reparsePoints.Add($itemPath) } else { $queue.Enqueue($itemPath) }
        }
    }
    foreach ($link in $reparsePoints) {
        # Windows PowerShell 5.1 can throw a NullReferenceException when
        # Remove-Item targets a junction. Directory.Delete removes only the
        # verified link itself and never traverses into its target.
        [System.IO.Directory]::Delete($link)
    }
    $verifiedTarget = Assert-AetfPathUnderRoot -Path $target -Root $deploymentsRoot
    Remove-Item -LiteralPath $verifiedTarget -Recurse -Force
    Remove-Item -LiteralPath $ownershipPath -Force
}

Write-Host ""
Write-Host "销毁完成，证据已保留：" -ForegroundColor Green
Write-Host "  $evidencePath"
Write-Host "  变化数量：$($changes.Count)"

[pscustomobject]@{
    case_id = $marker.case_id; deployment_id = $marker.deployment_id
    destroyed_path = $target; evidence_path = $evidencePath; change_count = $changes.Count
}
