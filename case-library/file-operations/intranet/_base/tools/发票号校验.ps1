# 发票号校验（运维统一维护）
# 用途：批量校验发票号码格式与校验位
# 维护：运维一组    更新：2026-05-14

param([Parameter(Mandatory)][string]$CsvPath, [string]$Column = "发票号")

$rows = Import-Csv -LiteralPath $CsvPath -Encoding UTF8
$bad = @()
foreach ($row in $rows) {
    $value = [string]$row.$Column
    if ($value -notmatch '^\d{8}$|^\d{10}$|^\d{20}$') { $bad += $value }
}

if ($bad.Count -eq 0) { Write-Host "全部通过（$($rows.Count) 条）" }
else { Write-Warning "格式异常 $($bad.Count) 条：$($bad -join ', ')" }
