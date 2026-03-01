@echo off
rem ─────────────────────────────────────────────────────────────
rem  VS Code Copilot Hook Bridge: Windows → WSL → Node.js
rem  Forwards stdin/stdout so hook JSON piping works.
rem  %~dp0 = this script's directory (portable, no hardcoded paths)
rem
rem  Path conversion: cmd.exe string substitution converts
rem  C:\Users\..\.ai\hooks\ → /mnt/c/Users/../.ai/hooks/
rem  This avoids wslpath/$()/single-quote quoting nightmares.
rem ─────────────────────────────────────────────────────────────
rem  DIAG: raw breadcrumb to prove VS Code is calling us
echo [%date% %time%] CALLED args=%* >> "%~dp0cmd-diag.log" 2>nul

rem Convert %~dp0 (Windows) to a WSL-compatible Linux path
set "SD=%~dp0"
set "SD=%SD:\=/%"
set "SD=%SD:C:=/mnt/c%"
set "SD=%SD:c:=/mnt/c%"
set "SD=%SD:D:=/mnt/d%"
set "SD=%SD:d:=/mnt/d%"

wsl bash "%SD%dispatch-bridge.sh" %*
