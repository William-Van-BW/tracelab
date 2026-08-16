# 排班表导出（运维统一维护）
# 用途：从排班系统导出当月排班表到工作区
# 维护：运维一组    更新：2026-06-30

param([string]$Root = $PSScriptRoot, [string]$Month = (Get-Date -Format "yyyy-MM"))

$endpoint = "http://schedule.intra/api/export?month=$Month"
try {
    $data = Invoke-RestMethod -Uri $endpoint -TimeoutSec 15
} catch {
    Write-Warning "排班系统不可达，改用本地缓存"
    $data = @()
}

$out = Join-Path $Root "排班表_$Month.csv"
$data | Export-Csv -LiteralPath $out -NoTypeInformation -Encoding UTF8
Write-Host "已导出：$out"
