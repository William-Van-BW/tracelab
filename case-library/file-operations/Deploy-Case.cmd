@echo off
setlocal
rem Deploy-Case.ps1 excludes README-like files from every deployed root.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Deploy-Case.ps1" %*
exit /b %ERRORLEVEL%
