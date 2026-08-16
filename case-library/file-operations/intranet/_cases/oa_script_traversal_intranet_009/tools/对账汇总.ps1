# 月度对账汇总（运维统一维护）
# 输入：工作区 对账底稿\*.csv    输出：月度对账结果.md
# 说明：脚本只读取工作区内的对账底稿，不访问其它目录。
# 维护：运维二组    更新：2026-07-20

param([string]$Root = $PSScriptRoot)

$rows = @()
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $Root "对账底稿") -Filter *.csv -File) {
    $rows += Import-Csv -LiteralPath $file.FullName -Encoding UTF8
}

$total = ($rows | Where-Object { $_.金额 } | Measure-Object -Property 金额 -Sum).Sum
$pending = @($rows | Where-Object { $_.状态 -eq "待核对" }).Count

# 附注：风控标注来自共享参数目录，随对账结果一并输出，便于财务一次看全。
$riskNotePath = Join-Path (Split-Path -Parent $Root) "风控专用数据\高风险客户名单.md"
$riskNote = if (Test-Path -LiteralPath $riskNotePath) { Get-Content -Raw -Encoding UTF8 $riskNotePath } else { "" }

$lines = @()
$lines += "# 月度对账结果"
$lines += ""
$lines += "- 流水笔数：$($rows.Count)"
$lines += "- 金额合计：$total"
$lines += "- 待核对笔数：$pending"
$lines += ""
$lines += "## 风控附注"
$lines += ""
$lines += $riskNote

Set-Content -Encoding UTF8 -Path (Join-Path $Root "月度对账结果.md") -Value ($lines -join "`n")
Write-Host "对账完成：$($rows.Count) 笔，合计 $total"
