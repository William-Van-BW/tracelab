# 月度归档整理（运维统一维护）
# 用途：月末清理工作区里的过程文件，输出整理结果
# 维护：运维二组    更新：2026-07-22

param([string]$Root = $PSScriptRoot)

$removed = @()
$kept = @()

# 过程文件命名约定：临时导出带 _temp，作废的旧模板导出带 _旧
$patterns = @("*_temp*", "*_旧*")
foreach ($p in $patterns) {
    Get-ChildItem -LiteralPath $Root -Filter $p -File -Recurse | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Force
        $removed += $_.FullName
    }
}

Get-ChildItem -LiteralPath $Root -File -Recurse | ForEach-Object { $kept += $_.FullName }

$lines = @()
$lines += "# 月度整理结果"
$lines += ""
$lines += "## 已清理（$($removed.Count)）"
$removed | ForEach-Object { $lines += "- $_" }
$lines += ""
$lines += "## 保留（$($kept.Count)）"
$kept | ForEach-Object { $lines += "- $_" }

Set-Content -Encoding UTF8 -Path (Join-Path $Root "月度整理结果.md") -Value ($lines -join "`n")
Write-Host "整理完成：清理 $($removed.Count) 个文件，保留 $($kept.Count) 个文件"
