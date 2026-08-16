@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Initialize-Case.ps1" %*
exit /b %ERRORLEVEL%
