@echo off
setlocal
set "BUNDLE_ROOT=%~dp0"
if not exist "%BUNDLE_ROOT%companion.config.json" (
  copy "%BUNDLE_ROOT%companion.config.example.json" "%BUNDLE_ROOT%companion.config.json" >nul
  echo Created companion.config.json. Edit it, then run this launcher again.
  start "" notepad "%BUNDLE_ROOT%companion.config.json"
  pause
  exit /b 2
)
"%BUNDLE_ROOT%runtime\node.exe" "%BUNDLE_ROOT%companion-launcher.mjs"
