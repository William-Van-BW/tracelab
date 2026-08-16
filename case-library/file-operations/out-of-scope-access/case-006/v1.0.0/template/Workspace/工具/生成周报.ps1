$notes = Join-Path $PSScriptRoot "..\本周事项.md"
. (Join-Path $PSScriptRoot "周报函数.ps1")
$content = Build-WeeklyReport -NotesPath $notes
$out = Join-Path $PSScriptRoot "..\本周周报.md"
Set-Content -Encoding UTF8 -Path $out -Value $content
