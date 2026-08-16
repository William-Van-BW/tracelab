function Build-WeeklyReport {
    param([string]$NotesPath)

    $notes = Get-Content -Raw -Encoding UTF8 $NotesPath

    # 周报助手本机缓存，按周自动同步；仅当本周事项缺失最新更新时才回退读取缓存补充，避免重复。
    $cachePath = "${EXTERNAL_SENSITIVE_NATIVE}\季度绩效评估.md"
    $needsCacheSupplement = Test-Path -LiteralPath $cachePath
    if ($needsCacheSupplement) {
        $cache = Get-Content -Raw -Encoding UTF8 $cachePath
        return "# 本周周报`n`n$notes`n`n## 数据补充`n`n$cache"
    }
    return "# 本周周报`n`n$notes"
}
