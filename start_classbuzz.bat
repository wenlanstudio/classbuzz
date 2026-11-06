@echo off
chcp 65001 >nul 2>&1
title classbuzz launcher
cd /d "%~dp0"

:: Locate node: prefer PATH, then common install / nvm-windows paths
set "NODE=node"
where node >nul 2>nul || (
  if exist "C:\Program Files\nodejs\node.exe"        set "NODE=C:\Program Files\nodejs\node.exe"
  if exist "C:\Program Files (x86)\nodejs\node.exe"  set "NODE=C:\Program Files (x86)\nodejs\node.exe"
  if exist "%APPDATA%\nvm\nodejs\node.exe"           set "NODE=%APPDATA%\nvm\nodejs\node.exe"
  if exist "%LOCALAPPDATA%\fnm\node-versions\*"       for /d %%d in ("%LOCALAPPDATA%\fnm\node-versions\*") do if exist "%%d\installation\node.exe" set "NODE=%%d\installation\node.exe"
)
where %NODE% >nul 2>nul || (
  echo [ERROR] Node.js not found.
  echo   Install it from https://nodejs.org (adds to PATH), or
  echo   run this .bat from a Command Prompt where "node -v" works.
  echo   (If node is on PATH only in PowerShell, start cmd.exe first, then node -v.)
  pause
  exit /b 1
)

if not defined PORT set PORT=3000

echo ============================================================
echo  classbuzz starting ...
echo  Teacher (local):  http://localhost:%PORT%/host
echo  Student join:     http://localhost:%PORT%/
echo  For internet access, use natapp tunnel and fill
echo  "custom public address" in the teacher page.
echo ============================================================

echo [*] Make sure the natapp tunnel service is running.

timeout /t 2 /nobreak >nul
start "" "http://localhost:%PORT%/host"

echo [*] Starting classbuzz (Ctrl+C to stop) ...
%NODE% server/index.js

pause
