@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Destroy-Case.ps1" %*
exit /b %ERRORLEVEL%
