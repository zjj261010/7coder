@echo off
rem 7coder launcher - uses the bundled runtime when present, falls back to PATH node.
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0index.js" %*
) else (
  node "%~dp0index.js" %*
)
