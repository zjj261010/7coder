@echo off
setlocal
rem Start the built-in web chat using the bundled Node 13.14 runtime when available.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-web.ps1" %*
exit /b %ERRORLEVEL%
